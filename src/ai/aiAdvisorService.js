// AI 어드바이저 서비스 — 프로바이더 실행/쿨다운/질의 오케스트레이션.
// 프롬프트·응답·집계의 순수 모델은 aiAdviceModel.js로 추출됐다.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { envBool, envRaw, envString } from '../config/envConfig.js';
import {
  AI_PROVIDER_DEFINITIONS,
  DEFAULT_PROVIDER_FAILURE_COOLDOWN_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
  truncate,
  redactMessage,
  resolveEvaluationMinutes,
  resolveNeutralBandPercent,
  normalizeProviderSelection,
  parseAdviceResponse,
  normalizeAdvice,
  aggregateAdvice,
  buildLocalEvidenceBrief,
  buildAdvisorPrompt,
  stripSubscriptionApiKeys,
  providerArgs,
  commandFailure
} from './aiAdviceModel.js';
export {
  AI_PROVIDER_DEFINITIONS,
  normalizeProviderSelection,
  parseAdviceResponse,
  normalizeAdvice,
  aggregateAdvice,
  buildLocalEvidenceBrief,
  buildAdvisorPrompt
} from './aiAdviceModel.js';

export class AIAdvisorService {
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot || process.cwd();
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    const configuredEnabled = options.enabled ?? options.config?.aiAdvisorEnabled ?? envBool('AI_ADVISOR_ENABLED', true);
    this.enabled = configuredEnabled !== false;
    this.timeoutMs = Math.max(3_000, Number(options.timeoutMs || options.config?.aiAdvisorTimeoutMs || envRaw('AI_ADVISOR_TIMEOUT_MS') || DEFAULT_TIMEOUT_MS));
    this.evaluationMinutes = resolveEvaluationMinutes(
      options.evaluationMinutes ?? options.config?.aiEvaluationMinutes ?? envRaw('AI_EVALUATION_MINUTES')
    );
    this.evaluationNeutralBandPercent = resolveNeutralBandPercent(
      options.evaluationNeutralBandPercent ?? options.config?.aiEvaluationNeutralBandPercent ?? envRaw('AI_EVALUATION_NEUTRAL_BAND_PERCENT')
    );
    this.models = {
      gpt: options.models?.gpt || options.config?.aiGptModel || envString('AI_GPT_MODEL', ''),
      claude: options.models?.claude || options.config?.aiClaudeModel || envString('AI_CLAUDE_MODEL', '')
    };
    this.allowLocalBrief = options.allowLocalBrief ?? options.config?.aiLocalBriefEnabled ?? envBool('AI_LOCAL_BRIEF_ENABLED', true);
    this.executables = {
      gpt: options.executables?.gpt || options.config?.aiCodexBin || envString('AI_CODEX_BIN', 'codex'),
      claude: options.executables?.claude || options.config?.aiClaudeBin || envString('AI_CLAUDE_BIN', 'claude')
    };
    // The application invocation intentionally isolates Codex from a broken
    // user config. Keep the warning visible, but do not let `codex login
    // status` block an execution path that can still authenticate and answer.
    this.gptIgnoreUserConfig = options.gptIgnoreUserConfig ??
      options.config?.aiCodexIgnoreUserConfig ??
      envBool('AI_CODEX_IGNORE_USER_CONFIG', true);
    this.argumentBuilder = options.argumentBuilder || providerArgs;
    this.runner = options.runner || ((provider, prompt, runnerOptions) => this.runProvider(provider, prompt, runnerOptions));
    this.preflightProviderStatus = options.preflightProviderStatus ?? !options.runner;
    // Local subscription CLIs can contend while they initialize models,
    // plugins, or their own state stores. Serialize provider executions so a
    // healthy Claude/GPT session is not made to time out by a sibling CLI.
    this.providerExecutionTail = Promise.resolve();
    this.providerFailureCooldownMs = Math.max(0, Number(
      options.providerFailureCooldownMs ?? options.config?.aiProviderFailureCooldownMs ??
      envRaw('AI_PROVIDER_FAILURE_COOLDOWN_MS') ?? DEFAULT_PROVIDER_FAILURE_COOLDOWN_MS
    ));
    this.providerCooldownUntil = new Map();
    this.statusCache = null;
    this.statusCacheAt = 0;
    this.statusCacheTtlMs = Math.max(5_000, Number(options.statusCacheTtlMs || 30_000));
  }

  enqueueProviderExecution(work) {
    const execution = this.providerExecutionTail.then(work, work);
    this.providerExecutionTail = execution.catch(() => undefined);
    return execution;
  }

  getProviderCooldownRemaining(provider) {
    return Math.max(0, (this.providerCooldownUntil.get(provider) || 0) - this.now());
  }

  recordProviderResult(provider, result) {
    if (result?.status === 'COMPLETED') {
      this.providerCooldownUntil.delete(provider);
      return;
    }
    if (this.providerFailureCooldownMs > 0 && ['AI_TIMEOUT', 'AI_PROCESS_EXIT', 'AI_PROVIDER_ERROR'].includes(result?.errorCode)) {
      this.providerCooldownUntil.set(provider, this.now() + this.providerFailureCooldownMs);
    }
  }

  getProviderDefinitions() {
    return Object.values(AI_PROVIDER_DEFINITIONS).map(definition => ({
      ...definition,
      executable: this.executables[definition.id]
    }));
  }

  async runProvider(provider, prompt, { timeoutMs = this.timeoutMs, statusArgs = null } = {}) {
    const executable = this.executables[provider];
    const args = statusArgs || this.argumentBuilder(
      provider,
      prompt,
      this.models[provider],
      { ignoreUserConfig: provider === 'gpt' && this.gptIgnoreUserConfig }
    );
    const environment = stripSubscriptionApiKeys();

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let killTimer = null;
      const child = spawn(executable, args, {
        cwd: this.workspaceRoot,
        env: environment,
        shell: false,
        windowsHide: true
      });
      // Prompts are sent through stdin to avoid OS argv-size limits. Closing
      // stdin is required by Claude Code's print mode; otherwise it waits
      // for a second input stream and appears to hang until timeout.
      child.stdin?.on('error', () => {});
      if (!statusArgs && prompt) child.stdin?.write(prompt);
      child.stdin?.end();

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        callback(value);
      };

      const timeoutTimer = setTimeout(() => {
        const timeoutError = new Error('AI provider timeout');
        timeoutError.code = 'AI_TIMEOUT';
        child.kill('SIGTERM');
        finish(reject, commandFailure(provider, executable, timeoutError, stdout, stderr));
        // `finish()` marks the promise settled immediately; retain a short
        // hard-kill fallback so a CLI that ignores SIGTERM cannot linger.
        killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
      }, timeoutMs);

      child.stdout?.on('data', chunk => {
        stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT_CHARS);
      });
      child.stderr?.on('data', chunk => {
        stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT_CHARS);
      });
      child.on('error', error => {
        finish(reject, commandFailure(provider, executable, error, stdout, stderr));
      });
      child.on('close', (code, signal) => {
        if (code === 0) {
          finish(resolve, { stdout, stderr, code, signal });
        } else {
          finish(reject, commandFailure(provider, executable, { code: code === null ? 'AI_PROCESS_EXIT' : `EXIT_${code}` }, stdout, stderr));
        }
      });
    });
  }

  async askProvider(provider, { event, context, session, requestId }) {
    const startedAt = Date.now();
    try {
      const prompt = buildAdvisorPrompt({ event, context, session });
      const result = await this.runner(provider, prompt, { timeoutMs: this.timeoutMs });
      const rawAdvice = parseAdviceResponse(result?.stdout ?? result);
      const receivedAt = new Date().toISOString();
      return {
        provider,
        providerLabel: AI_PROVIDER_DEFINITIONS[provider].label,
        status: 'COMPLETED',
        latencyMs: Date.now() - startedAt,
        advice: normalizeAdvice(rawAdvice, { provider, requestId, receivedAt }),
        completedAt: receivedAt
      };
    } catch (error) {
      return {
        provider,
        providerLabel: AI_PROVIDER_DEFINITIONS[provider].label,
        status: 'FAILED',
        latencyMs: Date.now() - startedAt,
        error: redactMessage(error?.message || '의견 서비스를 사용할 수 없습니다. 연결 상태를 확인해 주세요.'),
        errorCode: error?.code || 'AI_ADVISOR_ERROR',
        completedAt: new Date().toISOString()
      };
    }
  }

  async ask({ provider = 'both', event, context = {}, session = {} } = {}) {
    if (!this.enabled) {
      return {
        requestId: randomUUID(),
        status: 'DISABLED',
        results: [],
        error: '현재 의견 기능을 사용할 수 없습니다.'
      };
    }

    const providers = normalizeProviderSelection(provider);
    if (providers.length === 0) throw new Error('의견을 받을 서비스를 하나 이상 선택해 주세요.');
    if (!event || typeof event !== 'object') throw new Error('의견을 요청할 신호를 선택해 주세요.');

    const requestId = randomUUID();
    const promptContext = {
      ...context,
      evaluation: {
        ...(context.evaluation || {}),
        horizonMinutes: context.evaluation?.horizonMinutes ?? session.evaluationMinutes ?? this.evaluationMinutes,
        neutralBandPercent: context.evaluation?.neutralBandPercent ?? this.evaluationNeutralBandPercent
      }
    };
    let providerStatusById = new Map();
    if (this.preflightProviderStatus) {
      try {
        const status = await this.getProviderStatus();
        providerStatusById = new Map((status.providers || []).map(item => [item.id, item]));
      } catch {
        // A status probe failure must not hide a usable safe runner. The
        // provider call below remains the final authority in that case.
      }
    }

    const results = [];
    for (const item of providers) {
      const providerStatus = providerStatusById.get(item);
      const canAttemptWithConfigWarning = item === 'gpt' &&
        this.gptIgnoreUserConfig === true &&
        providerStatus?.status === 'CONFIG_ERROR' &&
        providerStatus?.canAttemptWithoutUserConfig !== false;
      const hardNotReady = providerStatus && (
        ['NOT_AUTHENTICATED', 'NOT_INSTALLED', 'DISABLED'].includes(providerStatus.status) ||
        (providerStatus.status === 'CONFIG_ERROR' && !canAttemptWithConfigWarning)
      );
      if (hardNotReady) {
        results.push({
          provider: item,
          providerLabel: AI_PROVIDER_DEFINITIONS[item].label,
          status: 'FAILED',
          latencyMs: 0,
          errorCode: 'PROVIDER_NOT_READY',
          error: providerStatus.detail || `${AI_PROVIDER_DEFINITIONS[item].label} 계정 로그인 상태를 확인해 주세요.`,
          completedAt: new Date().toISOString()
        });
        continue;
      }
      const cooldownRemainingMs = this.getProviderCooldownRemaining(item);
      if (cooldownRemainingMs > 0) {
        results.push({
          provider: item,
          providerLabel: AI_PROVIDER_DEFINITIONS[item].label,
          status: 'FAILED',
          latencyMs: 0,
          errorCode: 'PROVIDER_COOLDOWN',
          error: `${AI_PROVIDER_DEFINITIONS[item].label} 응답을 받지 못했습니다. ${Math.ceil(cooldownRemainingMs / 1000)}초 뒤에 다시 요청해 주세요.`,
          completedAt: new Date().toISOString()
        });
        continue;
      }
      const result = await this.enqueueProviderExecution(() => this.askProvider(item, {
        event,
        context: promptContext,
        session,
        requestId
      }));
      this.recordProviderResult(item, result);
      results.push(canAttemptWithConfigWarning && result.status === 'COMPLETED'
        ? {
            ...result,
            configWarning: true,
            warning: '서비스 연결 설정에 문제가 있어 다른 연결 방식으로 응답을 받았습니다.'
          }
        : result);
    }

    for (const result of results) {
      if (result.status === 'COMPLETED' && result.configWarning === true) {
        this.markProviderExecutionVerified(result.provider);
      }
    }

    const hasCompletedProvider = results.some(result => result.status === 'COMPLETED');
    if (!hasCompletedProvider && this.allowLocalBrief) {
      results.push({
        provider: 'local-brief',
        providerLabel: '확인된 자료',
        status: 'FALLBACK',
        latencyMs: 0,
        advice: buildLocalEvidenceBrief(event, results),
        completedAt: new Date().toISOString()
      });
    }

    return {
      requestId,
      status: hasCompletedProvider ? 'COMPLETED' : results.some(result => result.status === 'FALLBACK') ? 'DEGRADED' : 'FAILED',
      results,
      consensus: aggregateAdvice(results),
      completedAt: new Date().toISOString()
    };
  }

  markProviderExecutionVerified(provider, verifiedAt = new Date().toISOString()) {
    const status = this.statusCache?.providers?.find(item => item.id === provider);
    if (!status || provider !== 'gpt' || status.status !== 'CONFIG_ERROR') return;
    status.ready = true;
    status.status = 'READY_WITH_CONFIG_WARNING';
    status.authMode = 'chatgpt_subscription';
    status.executionVerifiedAt = verifiedAt;
    status.detail = '연결 설정을 확인할 부분이 있지만 현재 의견 요청은 가능합니다.';
    status.nextStep = '필요하면 연결 설정을 확인해 주세요. 지금 의견 요청은 가능합니다.';
  }

  async getProviderStatus({ force = false } = {}) {
    if (!this.enabled) {
      return {
        enabled: false,
        checkedAt: new Date().toISOString(),
        providers: this.getProviderDefinitions().map(definition => ({
          id: definition.id,
          label: definition.label,
          installed: false,
          ready: false,
          status: 'DISABLED',
          subscriptionLabel: definition.subscriptionLabel,
          detail: '현재 의견 기능을 사용할 수 없습니다.'
        }))
      };
    }
    if (!force && this.statusCache && Date.now() - this.statusCacheAt < this.statusCacheTtlMs) {
      return this.statusCache;
    }

    // Status probes spawn the same local CLIs as consultations, so they share
    // the serialized execution lane: a probe can never overlap a sibling probe
    // or an in-flight consultation. Parallel `codex login status` init takes
    // 30-40s and made concurrent `claude` calls time out.
    const providers = [];
    for (const provider of Object.keys(AI_PROVIDER_DEFINITIONS)) {
      const definition = AI_PROVIDER_DEFINITIONS[provider];
      const statusArgs = provider === 'gpt' ? ['login', 'status'] : ['auth', 'status'];
      try {
        const result = await this.enqueueProviderExecution(() => this.runProvider(provider, '', {
          timeoutMs: Math.min(this.timeoutMs, 8_000),
          statusArgs
        }));
        const output = `${result.stdout}\n${result.stderr}`;
        let parsed = null;
        try {
          parsed = JSON.parse(result.stdout.trim());
        } catch {
          // Codex status is text on some versions.
        }
        const loggedIn = provider === 'gpt'
          ? parsed?.loggedIn === true || /logged in using chatgpt|loggedin["': =]+true/i.test(output)
          : parsed?.loggedIn === true || /claude\.ai/i.test(output) || parsed?.authMethod === 'claude.ai';
        providers.push({
          id: provider,
          label: definition.label,
          installed: true,
          ready: loggedIn,
          status: loggedIn ? 'READY' : 'NOT_AUTHENTICATED',
          authMode: loggedIn ? (provider === 'gpt' ? 'chatgpt_subscription' : 'claude_subscription') : null,
          subscriptionLabel: definition.subscriptionLabel,
          subscriptionType: typeof parsed?.subscriptionType === 'string' ? truncate(parsed.subscriptionType, 80) : null,
          detail: loggedIn ? '사용 가능' : '계정 로그인이 필요합니다.',
          nextStep: loggedIn ? null : `${definition.label} 계정에 로그인한 뒤 다시 확인해 주세요.`,
          canAttemptWithoutUserConfig: provider === 'gpt' && this.gptIgnoreUserConfig === true
        });
      } catch (error) {
        const errorDetail = error?.detail || '';
        const unauthenticated = provider === 'claude' &&
          (/loggedIn["': =]+false/i.test(errorDetail) || /authMethod["': =]+none/i.test(errorDetail));
        const detail = error?.code === 'ENOENT'
            ? `${definition.label}에 연결할 수 없습니다. 연결 프로그램 설치 여부를 확인해 주세요.`
          : unauthenticated
            ? 'Claude 계정에 로그인해 주세요.'
          : /config|invalid type|설정/i.test(error?.detail || '') && provider === 'gpt'
            ? 'ChatGPT 계정 연결 설정을 불러오지 못했습니다. 연결 상태를 확인해 주세요.'
            : '로그인 상태를 확인하지 못했습니다.';
        const configurationError = provider === 'gpt' && /config|invalid type|설정/i.test(errorDetail);
        providers.push({
          id: provider,
          label: definition.label,
          installed: error?.code !== 'ENOENT',
          ready: false,
          status: error?.code === 'ENOENT'
            ? 'NOT_INSTALLED'
            : unauthenticated
              ? 'NOT_AUTHENTICATED'
              : configurationError
                ? 'CONFIG_ERROR'
                : 'UNAVAILABLE',
          authMode: null,
          subscriptionLabel: definition.subscriptionLabel,
          detail,
          canAttemptWithoutUserConfig: provider === 'gpt' && configurationError && this.gptIgnoreUserConfig === true,
          nextStep: error?.code === 'ENOENT'
            ? '서비스 연결 프로그램과 계정 상태를 확인해 주세요.'
            : unauthenticated
              ? 'Claude 계정으로 로그인해 주세요.'
              : configurationError
            ? 'ChatGPT 계정 연결 설정을 확인해 주세요.'
                : '서비스 계정 연결 상태를 확인해 주세요.'
        });
      }
    }

    this.statusCache = {
      enabled: true,
      checkedAt: new Date().toISOString(),
      usesApiKeys: false,
      policy: '연결한 ChatGPT 또는 Claude 계정으로 의견을 요청합니다. 자동 주문은 실행하지 않습니다.',
      providers
    };
    this.statusCacheAt = Date.now();
    return this.statusCache;
  }
}

export default AIAdvisorService;


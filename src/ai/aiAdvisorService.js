import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_CHARS = 80_000;
const MAX_RATIONALE_CHARS = 1_200;
const MAX_RISK_CHARS = 280;

export const AI_PROVIDER_DEFINITIONS = Object.freeze({
  gpt: Object.freeze({
    id: 'gpt',
    label: 'GPT / Codex',
    executableEnv: 'AI_CODEX_BIN',
    defaultExecutable: 'codex',
    subscriptionLabel: 'ChatGPT 구독 세션'
  }),
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude',
    executableEnv: 'AI_CLAUDE_BIN',
    defaultExecutable: 'claude',
    subscriptionLabel: 'claude.ai 구독 세션'
  })
});

const ACTION_ALIASES = Object.freeze({
  BUY: 'BUY',
  LONG: 'BUY',
  매수: 'BUY',
  SELL: 'SELL',
  SHORT: 'SELL',
  매도: 'SELL',
  HOLD: 'HOLD',
  WAIT: 'WAIT',
  관망: 'WAIT',
  NO_ACTION: 'WAIT',
  NONE: 'WAIT'
});

function truncate(value, maxLength) {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function redactMessage(value) {
  return truncate(value, 500)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email redacted]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[id redacted]')
    .replace(/\/Users\/[^\s/:]+/g, '/Users/[redacted]')
    .replace(/(authorization|bearer|token|api[_ -]?key|secret)[=: ]+[^\s,;]+/gi, '$1=[redacted]');
}

function normalizeConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const percent = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function normalizeAction(value) {
  const key = String(value ?? '').trim().toUpperCase();
  return ACTION_ALIASES[key] || 'WAIT';
}

/**
 * Normalize a user/provider provider selection to the two supported
 * subscription-backed adapters. `both` is intentionally expanded here so
 * the rest of the service never has to special-case it.
 */
export function normalizeProviderSelection(value) {
  const values = Array.isArray(value) ? value : [value ?? 'both'];
  const normalized = values.flatMap(item => {
    const key = String(item ?? '').trim().toLowerCase();
    if (key === 'both' || key === 'all' || key === 'gpt+claude' || key === 'claude+gpt') {
      return ['gpt', 'claude'];
    }
    if (key === 'openai' || key === 'chatgpt' || key === 'codex') return ['gpt'];
    if (key === 'anthropic') return ['claude'];
    return Object.hasOwn(AI_PROVIDER_DEFINITIONS, key) ? [key] : [];
  });
  return [...new Set(normalized)];
}

function findBalancedJsonObjects(text) {
  const source = String(text ?? '');
  const objects = [];

  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '{') continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === '{') depth += 1;
      if (character === '}') depth -= 1;
      if (depth === 0) {
        const candidate = source.slice(start, index + 1);
        try {
          objects.push(JSON.parse(candidate));
        } catch {
          // A larger wrapper may contain a non-JSON fragment. Keep scanning.
        }
        break;
      }
    }
  }

  return objects;
}

function walkForAdvice(value, visited = new Set()) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const text = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      const parsed = JSON.parse(text);
      return walkForAdvice(parsed, visited);
    } catch {
      for (const candidate of findBalancedJsonObjects(text)) {
        const result = walkForAdvice(candidate, visited);
        if (result) return result;
      }
      return null;
    }
  }
  if (typeof value !== 'object' || visited.has(value)) return null;
  visited.add(value);

  if (Object.hasOwn(value, 'action') || Object.hasOwn(value, 'decision')) {
    const decision = Object.hasOwn(value, 'decision') && value.decision && typeof value.decision === 'object'
      ? value.decision
      : value;
    if (Object.hasOwn(decision, 'action')) return decision;
  }

  for (const nested of Object.values(value)) {
    const result = walkForAdvice(nested, visited);
    if (result) return result;
  }
  return null;
}

/**
 * Provider output is deliberately parsed defensively. Codex --json emits
 * JSONL envelopes while Claude --output-format json emits a result envelope;
 * both can contain a JSON object in their final text field.
 */
export function parseAdviceResponse(rawOutput) {
  const text = String(rawOutput ?? '').trim();
  const candidates = [];

  try {
    candidates.push(JSON.parse(text));
  } catch {
    // The provider may have emitted JSONL or markdown around the object.
  }

  for (const line of text.split(/\r?\n/)) {
    try {
      candidates.push(JSON.parse(line));
    } catch {
      // Ignore non-JSON progress lines.
    }
  }

  candidates.push(...findBalancedJsonObjects(text));

  for (const candidate of candidates) {
    const result = walkForAdvice(candidate);
    if (result) return result;
  }

  const direct = walkForAdvice(text);
  if (direct) return direct;
  throw new Error('AI 응답에서 판단 JSON을 찾지 못했습니다');
}

export function normalizeAdvice(value, metadata = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const risks = Array.isArray(source.risks)
    ? source.risks
      .map(risk => truncate(risk, MAX_RISK_CHARS))
      .filter(Boolean)
      .slice(0, 5)
    : source.risk
      ? [truncate(source.risk, MAX_RISK_CHARS)]
      : [];

  return {
    action: normalizeAction(source.action ?? source.decision),
    confidence: normalizeConfidence(source.confidence),
    horizon: truncate(source.horizon || source.timeHorizon || '단기 관찰', 120),
    rationale: truncate(source.rationale || source.reason || source.summary || '구체적 근거가 부족해 관망합니다.', MAX_RATIONALE_CHARS),
    risks,
    invalidation: truncate(source.invalidation || source.invalidationCondition || '추가 확인 필요', 360),
    provider: metadata.provider || null,
    requestId: metadata.requestId || null,
    receivedAt: metadata.receivedAt || new Date().toISOString()
  };
}

function compactPromptValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map(compactPromptValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, nested]) => [key, compactPromptValue(nested)]));
  }
  return typeof value === 'string' ? truncate(value, 500) : value;
}

export function buildAdvisorPrompt({ event, context = {}, session = {} }) {
  const payload = {
    event: compactPromptValue(event),
    context: compactPromptValue(context),
    session: {
      name: truncate(session.name || 'manual consultation', 100),
      horizon: truncate(session.horizon || 'short-term', 80)
    }
  };

  return [
    'You are a read-only trading decision advisor inside CoinPilot.',
    'This is market commentary, not an order request. Never place an order, call an exchange API, alter strategy settings, or imply that your answer was executed.',
    'Use only the supplied snapshot. If evidence is incomplete or stale, choose WAIT and explain why.',
    'Return JSON only with exactly these fields: action (BUY|SELL|HOLD|WAIT), confidence (0..100), horizon, rationale, risks (array of strings), invalidation.',
    'A BUY or SELL is an advisory opinion only. The existing settings-based automation remains the sole automated execution path.',
    `SNAPSHOT_JSON:\n${JSON.stringify(payload)}`
  ].join('\n\n');
}

function stripSubscriptionApiKeys(environment = process.env) {
  const next = { ...environment };
  for (const key of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN'
  ]) {
    delete next[key];
  }
  return next;
}

function providerArgs(provider, prompt, model) {
  if (provider === 'gpt') {
    const args = [
      'exec',
      '--ignore-user-config',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--ask-for-approval', 'never',
      '--color', 'never',
      '--json'
    ];
    if (model) args.push('--model', model);
    args.push(prompt);
    return args;
  }

  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--no-session-persistence',
    '--permission-mode', 'plan',
    '--disallowed-tools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,TodoWrite',
    '--no-chrome'
  ];
  if (model) args.push('--model', model);
  return args;
}

function commandFailure(provider, executable, error, stdout = '', stderr = '') {
  const wrapped = new Error(
    error?.code === 'ENOENT'
      ? `${AI_PROVIDER_DEFINITIONS[provider].label} CLI를 찾지 못했습니다`
      : error?.code === 'AI_TIMEOUT'
        ? `${AI_PROVIDER_DEFINITIONS[provider].label} 응답 시간 초과`
        : `${AI_PROVIDER_DEFINITIONS[provider].label} CLI 실행 실패`
  );
  wrapped.code = error?.code || 'AI_PROVIDER_ERROR';
  wrapped.provider = provider;
  wrapped.executable = executable;
  wrapped.detail = redactMessage(stderr || stdout || error?.message || 'unknown error');
  return wrapped;
}

export class AIAdvisorService {
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot || process.cwd();
    const configuredEnabled = options.enabled ?? options.config?.aiAdvisorEnabled ?? process.env.AI_ADVISOR_ENABLED !== 'false';
    this.enabled = configuredEnabled !== false;
    this.timeoutMs = Math.max(3_000, Number(options.timeoutMs || options.config?.aiAdvisorTimeoutMs || process.env.AI_ADVISOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
    this.models = {
      gpt: options.models?.gpt || options.config?.aiGptModel || process.env.AI_GPT_MODEL || '',
      claude: options.models?.claude || options.config?.aiClaudeModel || process.env.AI_CLAUDE_MODEL || ''
    };
    this.executables = {
      gpt: options.executables?.gpt || options.config?.aiCodexBin || process.env.AI_CODEX_BIN || 'codex',
      claude: options.executables?.claude || options.config?.aiClaudeBin || process.env.AI_CLAUDE_BIN || 'claude'
    };
    this.runner = options.runner || ((provider, prompt, runnerOptions) => this.runProvider(provider, prompt, runnerOptions));
    this.statusCache = null;
    this.statusCacheAt = 0;
    this.statusCacheTtlMs = Math.max(5_000, Number(options.statusCacheTtlMs || 30_000));
  }

  getProviderDefinitions() {
    return Object.values(AI_PROVIDER_DEFINITIONS).map(definition => ({
      ...definition,
      executable: this.executables[definition.id]
    }));
  }

  async runProvider(provider, prompt, { timeoutMs = this.timeoutMs, statusArgs = null } = {}) {
    const executable = this.executables[provider];
    const args = statusArgs || providerArgs(provider, prompt, this.models[provider]);
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
        error: redactMessage(error?.detail || error?.message || error),
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
        error: 'AI 자문 기능이 비활성화되어 있습니다.'
      };
    }

    const providers = normalizeProviderSelection(provider);
    if (providers.length === 0) throw new Error('지원하는 AI provider를 선택해주세요');
    if (!event || typeof event !== 'object') throw new Error('자문할 monitoring event가 필요합니다');

    const requestId = randomUUID();
    const results = await Promise.all(providers.map(item => this.askProvider(item, {
      event,
      context,
      session,
      requestId
    })));

    return {
      requestId,
      status: results.some(result => result.status === 'COMPLETED') ? 'COMPLETED' : 'FAILED',
      results,
      completedAt: new Date().toISOString()
    };
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
          detail: 'AI 자문 기능이 비활성화되어 있습니다.'
        }))
      };
    }
    if (!force && this.statusCache && Date.now() - this.statusCacheAt < this.statusCacheTtlMs) {
      return this.statusCache;
    }

    const providers = await Promise.all(Object.keys(AI_PROVIDER_DEFINITIONS).map(async provider => {
      const definition = AI_PROVIDER_DEFINITIONS[provider];
      const executable = this.executables[provider];
      const statusArgs = provider === 'gpt' ? ['login', 'status'] : ['auth', 'status'];
      try {
        const result = await this.runProvider(provider, '', {
          timeoutMs: Math.min(this.timeoutMs, 8_000),
          statusArgs
        });
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
        return {
          id: provider,
          label: definition.label,
          installed: true,
          ready: loggedIn,
          status: loggedIn ? 'READY' : 'NOT_AUTHENTICATED',
          authMode: loggedIn ? (provider === 'gpt' ? 'chatgpt_subscription' : 'claude_subscription') : null,
          subscriptionLabel: definition.subscriptionLabel,
          subscriptionType: typeof parsed?.subscriptionType === 'string' ? truncate(parsed.subscriptionType, 80) : null,
          detail: loggedIn ? '로컬 구독 세션 사용 가능' : 'CLI 로그인 상태를 확인해주세요.'
        };
      } catch (error) {
        const detail = error?.code === 'ENOENT'
          ? 'CLI가 설치되어 있지 않습니다.'
          : /config|invalid type|설정/i.test(error?.detail || '') && provider === 'gpt'
            ? 'Codex 사용자 설정을 읽지 못했습니다. 자문 실행은 사용자 설정을 무시하는 읽기 전용 모드로 시도합니다.'
            : '로그인 상태를 확인하지 못했습니다.';
        return {
          id: provider,
          label: definition.label,
          installed: error?.code !== 'ENOENT',
          ready: false,
          status: error?.code === 'ENOENT' ? 'NOT_INSTALLED' : 'UNAVAILABLE',
          authMode: null,
          subscriptionLabel: definition.subscriptionLabel,
          detail
        };
      }
    }));

    this.statusCache = {
      enabled: true,
      checkedAt: new Date().toISOString(),
      usesApiKeys: false,
      policy: '구독 기반 로컬 CLI 자문만 사용하며, API 키를 저장하거나 주문을 실행하지 않습니다.',
      providers
    };
    this.statusCacheAt = Date.now();
    return this.statusCache;
  }
}

export default AIAdvisorService;

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PROVIDER_FAILURE_COOLDOWN_MS = 30_000;
const DEFAULT_EVALUATION_MINUTES = 5;
const DEFAULT_EVALUATION_NEUTRAL_BAND_PERCENT = 0.3;
const MAX_OUTPUT_CHARS = 80_000;
const MAX_RATIONALE_CHARS = 1_200;
const MAX_RISK_CHARS = 280;

export const AI_PROVIDER_DEFINITIONS = Object.freeze({
  gpt: Object.freeze({
    id: 'gpt',
    label: 'ChatGPT',
    executableEnv: 'AI_CODEX_BIN',
    defaultExecutable: 'codex',
    subscriptionLabel: 'ChatGPT 구독'
  }),
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude',
    executableEnv: 'AI_CLAUDE_BIN',
    defaultExecutable: 'claude',
    subscriptionLabel: 'Claude 구독'
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

function displayAction(value) {
  return ({ BUY: '매수', SELL: '매도', HOLD: '보유', WAIT: '관망' })[normalizeAction(value)];
}

function displayProvider(value) {
  return AI_PROVIDER_DEFINITIONS[value]?.label || String(value || '의견 서비스');
}

function resolveEvaluationMinutes(value, fallback = DEFAULT_EVALUATION_MINUTES) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.max(1, Math.min(1_440, Math.round(numeric)))
    : fallback;
}

function resolveNeutralBandPercent(value, fallback = DEFAULT_EVALUATION_NEUTRAL_BAND_PERCENT) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0
    ? Math.max(0, Math.min(10, numeric))
    : fallback;
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
  throw new Error('응답을 확인할 수 없습니다. 다시 요청해 주세요.');
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
    rationale: truncate(source.rationale || source.reason || source.summary || '제공된 자료만으로는 판단하기 어렵습니다.', MAX_RATIONALE_CHARS),
    risks,
    invalidation: truncate(source.invalidation || source.invalidationCondition || '판단을 바꿀 조건이 제시되지 않았습니다.', 360),
    provider: metadata.provider || null,
    mode: metadata.mode || 'AI_PROVIDER',
    requestId: metadata.requestId || null,
    receivedAt: metadata.receivedAt || new Date().toISOString()
  };
}

export function aggregateAdvice(results = []) {
  const completed = results.filter(result =>
    result?.status === 'COMPLETED' && result.advice && result.provider !== 'local-brief'
  );
  if (completed.length === 0) return null;

  const counts = new Map();
  for (const result of completed) {
    const action = normalizeAction(result.advice.action);
    counts.set(action, (counts.get(action) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [winningAction, winningCount] = ranked[0];
  const agreementRatio = winningCount / completed.length;
  const conflict = completed.length > 1 && agreementRatio < 1;
  const singleProvider = completed.length === 1;
  const quorum = completed.length >= 2 && !conflict;
  const averageConfidence = Math.round(completed.reduce((sum, result) => sum + normalizeConfidence(result.advice.confidence), 0) / completed.length);
  const providerNames = completed.map(result =>
    `${result.providerLabel || displayProvider(result.provider)}: ${displayAction(result.advice.action)}`
  );

  return {
    ...normalizeAdvice({
      action: conflict ? 'WAIT' : winningAction,
      confidence: conflict
        ? Math.min(50, Math.round(averageConfidence * agreementRatio))
        : singleProvider ? Math.min(60, averageConfidence) : averageConfidence,
      horizon: conflict ? '의견 비교 보류' : completed[0].advice.horizon,
      rationale: conflict
        ? `두 서비스의 의견이 달라 매수·매도 대신 관망으로 표시합니다. ${providerNames.join(', ')}.`
        : singleProvider
          ? `이번 결과는 ${providerNames.join(', ')} 한 곳의 의견입니다. 다른 서비스와 비교하지 않았습니다.`
          : `${completed.length}개 서비스의 의견입니다. ${providerNames.join(', ')}.`,
      risks: conflict
        ? ['두 서비스의 의견이 다릅니다.', '의견이 다를 때는 관망으로 표시합니다.']
        : singleProvider ? ['한 서비스의 의견만 확인했습니다.', '다른 서비스와 비교하지 않았습니다.'] : [],
      invalidation: conflict ? '새 신호가 나타나면 의견을 다시 비교할 수 있습니다.' : completed[0].advice.invalidation
    }, { provider: 'consensus', mode: 'AI_CONSENSUS' }),
    agreementRatio,
    providerCount: completed.length,
    providers: completed.map(result => result.provider),
    conflict,
    quorum,
    singleProvider
  };
}

export function buildLocalEvidenceBrief(event, providerFailures = []) {
  const snapshot = event?.snapshot || {};
  const indicators = snapshot.indicators || snapshot;
  const rebound = indicators.rebound || snapshot.rebound || {};
  const rsi = Number(indicators.rsi ?? snapshot.rsi);
  const volumeRatio = Number(indicators.volumeRatio ?? rebound.volumeRatio ?? snapshot.volumeRatio);
  const closeStrength = Number(indicators.closeStrength ?? rebound.closeStrength ?? snapshot.closeStrength);
  const freshness = snapshot.freshness || snapshot.candleFreshness || {};
  const regime = snapshot.marketRegime || {};
  const facts = [];
  if (Number.isFinite(rsi)) facts.push(`RSI ${rsi.toFixed(2)}`);
  if (Number.isFinite(volumeRatio)) facts.push(`거래량 배수 ${volumeRatio.toFixed(2)}`);
  if (Number.isFinite(closeStrength)) facts.push(`종가 강도 ${closeStrength.toFixed(2)}`);
  if (rebound.reboundConfirmed === true) facts.push('반등 확정');
  if (freshness.valid === false) facts.push('시세 캔들 시각 확인 필요');
  if (regime.confirmed === false) facts.push('전체 시장 방향 조건 미충족');
  if (event?.action) facts.push(`자동매매 신호 ${displayAction(event.action)}`);
  const failureNames = providerFailures
    .map(result => result.providerLabel || displayProvider(result.provider))
    .filter(Boolean);
  const eventLabels = {
    BUY_SIGNAL: '매수 신호',
    SELL_SIGNAL: '매도 신호',
    REBOUND_CANDIDATE: '반등 후보',
    BREAKING_NEWS: '속보',
    BUNDLE_SUGGESTION: '리밸런싱 제안',
    TRADE_EXECUTED: '체결'
  };
  const coin = event?.coin ? String(event.coin).replace(/^KRW-/, '') : '시장 전체';
  const eventLabel = eventLabels[event?.type] || '시장 정보';

  return normalizeAdvice({
    action: 'WAIT',
    confidence: 0,
    horizon: '정보 요약',
    rationale: `서비스 의견을 받지 못해 확인된 데이터만 정리했습니다. ${coin} · ${eventLabel} · ${facts.join(' · ') || '추가 지표 없음'}. 매수·매도 권고는 아닙니다.`,
    risks: [
      '의견을 받으려면 서비스 계정에 로그인해야 합니다.',
      ...(failureNames.length > 0 ? [`응답을 받지 못한 서비스: ${failureNames.join(', ')}`] : []),
      ...(freshness.valid === false ? ['시세 자료가 오래되었거나 일부 빠짐'] : []),
      ...(regime.confirmed === false ? ['전체 시장 방향 조건 미충족'] : [])
    ].slice(0, 5),
    invalidation: '서비스 연결을 확인한 뒤 다시 요청해 주세요.'
  }, { provider: 'local-brief', mode: 'LOCAL_EVIDENCE_ONLY' });
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
  const evaluation = context?.evaluation || {};
  const evaluationMinutes = resolveEvaluationMinutes(
    evaluation.horizonMinutes ?? evaluation.evaluationMinutes ?? session.evaluationMinutes
  );
  const neutralBandPercent = resolveNeutralBandPercent(evaluation.neutralBandPercent);
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
    `The outcome evaluator treats price movement within ±${neutralBandPercent}% over ${evaluationMinutes} minute(s) as cost-neutral after fees and slippage. Do not choose BUY or SELL for a move that is only inside this band; require evidence that plausibly clears this exact threshold.`,
    'If the supplied current rebound or price-change percentage is itself below that band and the snapshot does not provide an explicit forward expected-move estimate or catalyst that clears the band, do not assume unseen follow-through from generic indicator strength; choose WAIT.',
    'For a fresh BUY_SIGNAL with reboundConfirmed=true, evaluate the confirmed BUY candidate directly rather than defaulting to WAIT merely because this is advisory. Choose BUY only when the supplied evidence plausibly exceeds the stated neutral band after transaction costs; choose WAIT only when a concrete contradiction, rejection reason, stale/incomplete input, or insufficient net movement remains.',
    'For a fresh SELL_SIGNAL with a confirmed sell condition, apply the same independent cost-aware judgment. Do not mirror event.action blindly.',
    'Write every user-facing field in concise, natural Korean for an individual investor. Keep rationale to one or two short sentences, list at most three specific risks, and state invalidation as an observable condition.',
    'Do not mention that you are an AI or language model, repeat the prompt, add generic filler, invent missing values, or claim an order was placed or profit was realized.',
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

function providerArgs(provider, prompt, model, { ignoreUserConfig = true } = {}) {
  if (provider === 'gpt') {
    const args = ['--ask-for-approval', 'never', 'exec'];
    if (ignoreUserConfig) args.push('--ignore-user-config');
    args.push(
      '--ephemeral',
      '--ignore-rules',
      '--sandbox', 'read-only',
      '--color', 'never',
      '--json'
    );
    if (model) args.push('--model', model);
    args.push('-');
    return args;
  }

  const args = [
    '-p',
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
      ? `${AI_PROVIDER_DEFINITIONS[provider].label} 응답을 받을 수 없습니다. 연결 프로그램을 확인해 주세요.`
      : error?.code === 'AI_TIMEOUT'
        ? `${AI_PROVIDER_DEFINITIONS[provider].label} 응답이 늦어져 의견을 받지 못했습니다.`
        : `${AI_PROVIDER_DEFINITIONS[provider].label} 의견을 받지 못했습니다. 연결 상태를 확인해 주세요.`
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
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    const configuredEnabled = options.enabled ?? options.config?.aiAdvisorEnabled ?? process.env.AI_ADVISOR_ENABLED !== 'false';
    this.enabled = configuredEnabled !== false;
    this.timeoutMs = Math.max(3_000, Number(options.timeoutMs || options.config?.aiAdvisorTimeoutMs || process.env.AI_ADVISOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
    this.evaluationMinutes = resolveEvaluationMinutes(
      options.evaluationMinutes ?? options.config?.aiEvaluationMinutes ?? process.env.AI_EVALUATION_MINUTES
    );
    this.evaluationNeutralBandPercent = resolveNeutralBandPercent(
      options.evaluationNeutralBandPercent ?? options.config?.aiEvaluationNeutralBandPercent ?? process.env.AI_EVALUATION_NEUTRAL_BAND_PERCENT
    );
    this.models = {
      gpt: options.models?.gpt || options.config?.aiGptModel || process.env.AI_GPT_MODEL || '',
      claude: options.models?.claude || options.config?.aiClaudeModel || process.env.AI_CLAUDE_MODEL || ''
    };
    this.allowLocalBrief = options.allowLocalBrief ?? options.config?.aiLocalBriefEnabled ?? process.env.AI_LOCAL_BRIEF_ENABLED !== 'false';
    this.executables = {
      gpt: options.executables?.gpt || options.config?.aiCodexBin || process.env.AI_CODEX_BIN || 'codex',
      claude: options.executables?.claude || options.config?.aiClaudeBin || process.env.AI_CLAUDE_BIN || 'claude'
    };
    // The application invocation intentionally isolates Codex from a broken
    // user config. Keep the warning visible, but do not let `codex login
    // status` block an execution path that can still authenticate and answer.
    this.gptIgnoreUserConfig = options.gptIgnoreUserConfig ??
      options.config?.aiCodexIgnoreUserConfig ??
      process.env.AI_CODEX_IGNORE_USER_CONFIG !== 'false';
    this.argumentBuilder = options.argumentBuilder || providerArgs;
    this.runner = options.runner || ((provider, prompt, runnerOptions) => this.runProvider(provider, prompt, runnerOptions));
    this.preflightProviderStatus = options.preflightProviderStatus ?? !options.runner;
    // Local subscription CLIs can contend while they initialize models,
    // plugins, or their own state stores. Serialize provider executions so a
    // healthy Claude/GPT session is not made to time out by a sibling CLI.
    this.providerExecutionTail = Promise.resolve();
    this.providerFailureCooldownMs = Math.max(0, Number(
      options.providerFailureCooldownMs ?? options.config?.aiProviderFailureCooldownMs ??
      process.env.AI_PROVIDER_FAILURE_COOLDOWN_MS ?? DEFAULT_PROVIDER_FAILURE_COOLDOWN_MS
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

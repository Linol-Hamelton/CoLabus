'use strict';

// One liveness for the dispatcher (S4-T04, R-L3-004.6 / R-L3-004.8). Pure: time arrives in every sample.
// The operator watchdog is a WARN view of the same verdicts (warnView), never a second canon.

const MIN = 60 * 1000;

const DEFAULT_STALL_MIN = 10;
const DEFAULT_HARD_MIN = 120;
const MAX_WAKES = 3;

const ERROR_PATTERNS = {
  AUTH_ERROR: [
    /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status|error|code)\W{0,3}(?:401|403)\b/i,
    /\b(?:401|403)\W{0,3}(?:Unauthori[sz]ed|Forbidden)\b/i,
    /\bunauthori[sz]ed\b|not logged in|log ?in required|authenticat\w* (?:failed|error|required)|invalid[ _](?:api[ _-]?key|token|credentials)/i
  ],
  RATE_LIMIT: [
    /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status|error|code)\W{0,3}429\b/i,
    /\b429\W{0,3}Too Many Requests\b/i,
    /\brate[ _-]?limit(?:ed|[ _](?:error|exceeded|reached|hit))|too many requests\b/i
  ],
  QUOTA_EXHAUSTED: [
    /\bquota[ _](?:exceeded|exhausted|reached|error)|exceeded (?:your|the) (?:current )?quota|insufficient[ _](?:credit|balance|funds|quota)|credit balance is too low|usage limit (?:reached|exceeded)|limit (?:reached|exceeded)|hit your (?:usage )?limit|RESOURCE_EXHAUSTED\b/i
  ],
  MODEL_UNAVAILABLE: [
    /\bmodel\b.*?\b(?:not found|not available|unavailable|does not exist|unsupported)\b|\bunknown model\b/i
  ],
  NETWORK_ERROR: [
    /\b(?:ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network error)\b/i
  ],
  PROVIDER_ERROR: [
    /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status|error|code)\W{0,3}(?:500|502|503|504|529)\b/i,
    /\b(?:500|502|503|504|529)\W{0,3}(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|Overloaded)\b/i,
    /\bprovider error|service unavailable|overloaded_error|(?:server|model|api|service)(?: is)? overloaded\b/i
  ]
};

const ERROR_TEXT = new RegExp(
  Object.values(ERROR_PATTERNS)
    .flatMap(patterns => patterns.map(p => p.source))
    .join('|'),
  'i'
);

const RETRY_TEXT = /\bretry(?:ing)?\b|\bretries\b|\bbacking off\b|\bwaiting \d+(?:\.\d+)? ?(?:ms|s|sec|seconds?)\b/i;

function limitError(message) {
  const e = new Error(message);
  e.code = 'LIMIT_RANGE';
  return e;
}

function intInRange(value, lo, hi) {
  return typeof value === 'number' && Number.isInteger(value) && value >= lo && value <= hi;
}

// The dispatch file may set the idle interval 5..120 min (hardMin 10..720 stays as the file already allowed it).
function resolveLimits({ stallMin, hardMin } = {}) {
  if (stallMin !== undefined && !intInRange(stallMin, 5, 120)) {
    throw limitError(`stallMin must be an integer between 5 and 120; got ${String(stallMin)}`);
  }
  if (hardMin !== undefined && !intInRange(hardMin, 10, 720)) {
    throw limitError(`hardMin must be an integer between 10 and 720; got ${String(hardMin)}`);
  }
  return {
    stallMs: (stallMin === undefined ? DEFAULT_STALL_MIN : stallMin) * MIN,
    hardMs: (hardMin === undefined ? DEFAULT_HARD_MIN : hardMin) * MIN,
    maxWakes: MAX_WAKES
  };
}

// A line is progress only when it is the agent's own, non-blank, and neither an error nor a retry notice.
function isProgressLine(line) {
  const text = String(line).trim();
  if (!text) return false;
  if (RETRY_TEXT.test(text)) return false;
  if (ERROR_TEXT.test(text)) return false;
  return true;
}

// The wake count of one step, shared by every attempt of a wake chain, so supervisor and tracker cannot disagree.
function createWakeBudget(maxWakes = MAX_WAKES) {
  let used = 0;
  return {
    used: () => used,
    exhausted: () => used >= maxWakes,
    take() {
      if (used >= maxWakes) return { action: 'FALLEN', class: 'STALL' };
      used++;
      return { action: 'WAKE', n: used };
    }
  };
}

// firstLaunchAt anchors the hard ceiling; idleStartAt (default: the same moment) anchors the first idle window,
// so an attempt launched later than the step (a resume, a fresh retry) opens its own window at its own start.
function createTracker({ limits, firstLaunchAt, idleStartAt = firstLaunchAt, wakeBudget = createWakeBudget(limits.maxWakes) }) {
  let lastProgressAt = idleStartAt;

  function tick(sample) {
    const now = sample.now;
    const elapsedMs = now - firstLaunchAt;
    // 1. hard ceiling: every tick, progress never resets it, a wake never moves it
    if (elapsedMs >= limits.hardMs) {
      return { verdict: 'TIMEOUT', idleMs: now - lastProgressAt, elapsedMs, state: 'BLOCKED', resume: false };
    }
    // 2. progress: only the agent's own signals; heartbeat, tree mtime and CPU are not read
    const lines = Array.isArray(sample.ownLines) ? sample.ownLines : [];
    if (sample.outputsChanged || sample.journalsChanged || lines.some(isProgressLine)) {
      lastProgressAt = now;
    }
    // 3. idle
    const idleMs = now - lastProgressAt;
    return { verdict: idleMs >= limits.stallMs ? 'STALL' : 'OK', idleMs, elapsedMs };
  }

  // A wake opens a new idle window; the fourth idle stretch is FALLEN of class STALL.
  function wake(now) {
    const taken = wakeBudget.take();
    if (taken.action === 'WAKE') lastProgressAt = now;
    return taken;
  }

  return { tick, wake };
}

function fallenOf(record) {
  return Boolean(record) && record.state === 'FAILED' && record.class === 'STALL';
}

function warnView(tickResult) {
  if (!tickResult || (tickResult.verdict !== 'STALL' && tickResult.verdict !== 'TIMEOUT')) return null;
  return { level: 'WARN', kill: false, verdict: tickResult.verdict };
}

module.exports = {
  resolveLimits,
  createTracker,
  createWakeBudget,
  isProgressLine,
  fallenOf,
  warnView,
  ERROR_PATTERNS,
  ERROR_TEXT,
  RETRY_TEXT
};

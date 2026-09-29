const LEGACY_ERROR_TIMESTAMP = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/;

/**
 * Select recent error entries from a bounded log suffix. Supports current
 * structured JSONL and the legacy timestamped multi-line format.
 */
export function parseRecentLogErrors(lines, { limit = 10, maxCharacters = 2000 } = {}) {
  const entries = [];
  let currentLegacyEntry = '';
  const flushLegacyEntry = () => {
    if (currentLegacyEntry.trim()) entries.push(currentLegacyEntry.trim());
    currentLegacyEntry = '';
  };

  for (const value of Array.isArray(lines) ? lines : []) {
    const line = String(value);
    if (LEGACY_ERROR_TIMESTAMP.test(line)) {
      flushLegacyEntry();
      currentLegacyEntry = line;
      continue;
    }
    if (currentLegacyEntry) {
      currentLegacyEntry += `\n${line}`;
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.level === 'error') entries.push(line);
    }
  }
  flushLegacyEntry();

  const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
  const boundedCharacters = Number.isInteger(maxCharacters) && maxCharacters > 0
    ? Math.min(maxCharacters, 20_000)
    : 2000;
  return entries.slice(-boundedLimit).map(entry => (
    entry.length > boundedCharacters
      ? `${entry.substring(0, boundedCharacters)}...(truncated)`
      : entry
  ));
}

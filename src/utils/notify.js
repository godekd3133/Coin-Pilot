import axios from 'axios';

/**
 * Minimal external push via ntfy.sh — no account, no keys; the topic name is
 * the capability. Disabled unless a topic is configured. Fire-and-forget:
 * notification failures must never break a trading loop.
 */
export function createNotifier({ topic = '', baseUrl = 'https://ntfy.sh', timeoutMs = 5000 } = {}) {
  const enabled = Boolean(topic);
  async function send(title, body, tags = []) {
    if (!enabled) return false;
    try {
      await axios.post(`${baseUrl}/${topic}`, body, {
        timeout: timeoutMs,
        headers: { Title: title, Tags: tags.join(','), Priority: 'default' }
      });
      return true;
    } catch {
      return false;
    }
  }
  return { enabled, send };
}

import fs from 'node:fs';
import http2 from 'node:http2';
import { createHash, createPrivateKey, createSign, randomUUID } from 'node:crypto';
import { writeDurableJson } from '../runtime/durableJson.js';

export function createApnsSender(env = process.env) {
  const keyFile = env.APNS_KEY_FILE;
  const keyId = env.APNS_KEY_ID;
  const teamId = env.APNS_TEAM_ID;
  const topic = env.APNS_TOPIC || 'com.godekd3133.coinpilot';
  if (!keyFile || !keyId || !teamId) return null;
  const privateKey = createPrivateKey(fs.readFileSync(keyFile));
  let cachedToken;
  let tokenAt = 0;
  return async (device, event) => {
    const now = Math.floor(Date.now() / 1000);
    if (!cachedToken || now - tokenAt > 1200) {
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({ iss: teamId, iat: now })).toString('base64url');
      const signer = createSign('sha256').update(`${header}.${claims}`);
      const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      cachedToken = `${header}.${claims}.${signature}`;
      tokenAt = now;
    }
    const origin = device.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    return new Promise(resolve => {
      const session = http2.connect(origin);
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        session.destroy();
        resolve(result);
      };
      session.on('error', () => finish({ status: 0, reason: 'connection_failed' }));
      session.setTimeout(10000, () => finish({ status: 0, reason: 'timeout' }));
      const request = session.request({
        ':method': 'POST', ':path': `/3/device/${device.token}`,
        authorization: `bearer ${cachedToken}`, 'apns-topic': topic,
        'apns-push-type': 'alert', 'apns-priority': '10',
        'apns-collapse-id': event.id,
        'apns-expiration': String(Math.floor(new Date(event.createdAt).getTime() / 1000) + 86400)
      });
      let status = 0;
      let body = '';
      request.on('response', headers => { status = Number(headers[':status']); });
      request.setEncoding('utf8');
      request.on('data', chunk => { if (body.length < 4096) body += chunk; });
      request.on('error', () => finish({ status: 0, reason: 'request_failed' }));
      request.on('end', () => {
        let reason = null;
        try { reason = JSON.parse(body).reason || null; } catch { /* successful responses have no body */ }
        finish({ status, reason });
      });
      const label = event.trade.mode === 'LIVE' ? '실거래' : '모의거래';
      const action = event.trade.type === 'BUY' ? '매수' : '매도';
      const coin = event.trade.coin.replace(/^KRW-/, '');
      request.end(JSON.stringify({
        aps: { alert: { title: `${label} · ${coin} ${action}`, body: `${action} 주문이 체결됐습니다. 앱에서 거래 내역을 확인하세요.` },
          sound: 'default', 'thread-id': `coinpilot-${event.trade.mode}` },
        eventId: event.id, mode: event.trade.mode, market: event.trade.coin
      }));
    });
  };
}

export class OrderPushService {
  constructor({ file, mode, sender = null, logger = console, now = () => Date.now() }) {
    this.file = file;
    this.mode = mode;
    this.sender = sender;
    this.logger = logger;
    this.now = now;
    this.error = null;
    this.timer = null;
    this.inFlight = false;
    this.state = { version: 1, mode, devices: {}, events: [] };
    if (file && fs.existsSync(file)) {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (record.version !== 1 || record.mode !== mode || !record.devices || !Array.isArray(record.events)) {
        throw new Error('주문 알림 기록을 읽을 수 없습니다.');
      }
      this.state = record;
    }
  }

  save(next) {
    if (this.file) writeDurableJson(this.file, next);
    this.state = next;
    this.error = null;
  }

  register({ deviceId, token, environment }) {
    if (!/^[a-f0-9-]{36}$/i.test(deviceId || '') || !/^[a-f0-9]{32,512}$/i.test(token || '') ||
        !['sandbox', 'production'].includes(environment)) throw new Error('알림 기기 정보가 잘못됐습니다.');
    if (Object.keys(this.state.devices).length >= 50 && !this.state.devices[deviceId]) throw new Error('알림 기기 수 제한에 도달했습니다.');
    const devices = { ...this.state.devices };
    for (const [id, device] of Object.entries(devices)) {
      if (id !== deviceId && device.token === token) delete devices[id];
    }
    devices[deviceId] = { token, environment, enabled: true, registeredAt: new Date(this.now()).toISOString() };
    this.save({ ...this.state, devices });
    return this.summary();
  }

  unregister(deviceId) {
    const devices = { ...this.state.devices };
    delete devices[deviceId];
    this.save({ ...this.state, devices });
  }

  enqueue(trade) {
    if (!['BUY', 'SELL'].includes(trade?.type) || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(trade?.coin || '') ||
        (trade.mode && trade.mode !== this.mode)) return null;
    const id = createHash('sha256').update(`${this.mode}|${trade.orderId || trade.eventId || randomUUID()}`).digest('hex');
    if (this.state.events.some(event => event.id === id)) return id;
    const deliveries = {};
    for (const [deviceId, device] of Object.entries(this.state.devices)) {
      if (device.enabled) deliveries[deviceId] = { status: 'queued', attempts: 0, nextAttemptAt: 0 };
    }
    const event = { id, createdAt: new Date(this.now()).toISOString(),
      trade: { type: trade.type, coin: trade.coin, mode: this.mode,
        orderId: trade.orderId || null, price: trade.price || null, volume: trade.volume || null }, deliveries };
    const events = [...this.state.events, event];
    while (events.length > 1000) {
      const index = events.findIndex(item => !Object.values(item.deliveries).some(d => d.status === 'queued'));
      if (index < 0) throw new Error('주문 알림 대기열이 가득 찼습니다.');
      events.splice(index, 1);
    }
    this.save({ ...this.state, events });
    return id;
  }

  start() {
    if (!this.sender || this.timer) return;
    this.timer = setInterval(() => { this.flush().catch(error => { this.error = error.message; }); }, 5000);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async flush() {
    if (!this.sender || this.inFlight) return;
    this.inFlight = true;
    try {
      // Access the current state after each await: registrations and new events
      // can arrive while APNs is in flight and must never be overwritten.
      for (const eventId of this.state.events.map(event => event.id)) {
        for (const deviceId of Object.keys(this.state.events.find(event => event.id === eventId)?.deliveries || {})) {
          let event = this.state.events.find(item => item.id === eventId);
          const delivery = event?.deliveries[deviceId];
          const device = this.state.devices[deviceId];
          if (!event || delivery.status !== 'queued' || delivery.nextAttemptAt > this.now()) continue;
          const expired = this.now() - new Date(event.createdAt).getTime() > 86400000;
          let result;
          if (!device?.enabled || expired) result = { status: 410, reason: expired ? 'expired' : 'device_removed' };
          else {
            try { result = await this.sender({ ...device }, event); }
            catch { result = { status: 0, reason: 'send_failed' }; }
          }
          event = this.state.events.find(item => item.id === eventId);
          if (!event) continue;
          const attempts = delivery.attempts + 1;
          const permanent = [400, 403, 404, 410].includes(result.status) || attempts >= 10;
          const outcome = result.status === 200 ? 'accepted' : permanent ? 'failed' : 'queued';
          const nextDelivery = { status: outcome, attempts, reason: result.reason || null,
            updatedAt: new Date(this.now()).toISOString(), nextAttemptAt: this.now() + Math.min(3600000, 5000 * (2 ** attempts)) };
          const devices = { ...this.state.devices };
          if (['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(result.reason) &&
              devices[deviceId]?.token === device?.token) devices[deviceId] = { ...devices[deviceId], enabled: false };
          this.save({ ...this.state, devices, events: this.state.events.map(item => item.id === eventId
            ? { ...item, deliveries: { ...item.deliveries, [deviceId]: nextDelivery } } : item) });
        }
      }
    } finally { this.inFlight = false; }
  }

  summary() {
    const deliveries = this.state.events.flatMap(event => Object.values(event.deliveries));
    return { configured: Boolean(this.sender), registeredDevices: Object.values(this.state.devices).filter(device => device.enabled).length,
      events: this.state.events.length, queued: deliveries.filter(d => d.status === 'queued').length,
      accepted: deliveries.filter(d => d.status === 'accepted').length, failed: deliveries.filter(d => d.status === 'failed').length,
      lastEventAt: this.state.events.at(-1)?.createdAt || null, error: this.error };
  }
}

export function manualTradeNotifications(body, request, mode) {
  if (!body || typeof body !== 'object') return [];
  const notifications = [];
  const requestId = request.get?.('Idempotency-Key') || randomUUID();
  function visit(item, side = null, depth = 0) {
    if (!item || typeof item !== 'object' || depth > 5) return;
    if (Array.isArray(item)) { item.forEach(row => visit(row, side, depth + 1)); return; }
    const market = item.coin || item.market;
    const type = item.type || item.action || side || request.body?.action || (request.path?.endsWith('/sell') ? 'SELL' : 'BUY');
    const observed = ['filled', 'partial'].includes(item.fill?.status);
    if (market && (mode === 'LIVE' ? observed : body.success === true && Number(item.volume || item.quantity) > 0)) {
      notifications.push({ type, coin: market, mode, price: item.price || item.fill?.averagePrice,
        volume: item.volume || item.quantity || item.fill?.executedVolume,
        orderId: item.fill?.orderId, eventId: `${requestId}|${type}|${market}` });
    }
    for (const key of ['trades', 'orders', 'results', 'buy', 'sell']) {
      if (item[key]) visit(item[key], key === 'buy' ? 'BUY' : key === 'sell' ? 'SELL' : side, depth + 1);
    }
  }
  visit(body);
  return notifications;
}

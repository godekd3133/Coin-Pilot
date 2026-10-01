/**
 * 서버발송 실시간 이벤트 허브.
 *
 * Socket.IO와 SSE(GET /api/stream) 클라이언트에게 같은 이벤트를 fan-out한다.
 * 네이티브 iOS 앱처럼 Socket.IO를 쓰지 않는 클라이언트가 같은 브로드캐스트를
 * 받을 수 있게 하는 것이 목적이며, HTTP 라우팅과 알림 규칙은 소유하지 않는다.
 */
const SSE_HEARTBEAT_MS = 25_000;

export class RealtimeHub {
  constructor({ io = null, heartbeatMs = SSE_HEARTBEAT_MS } = {}) {
    this.io = io;
    this.sseClients = new Set();
    this.sseHeartbeat = setInterval(() => {
      for (const client of this.sseClients) {
        try {
          client.write(': hb\n\n');
        } catch {
          this.sseClients.delete(client);
        }
      }
    }, heartbeatMs);
    this.sseHeartbeat.unref?.();
  }

  /** Socket.IO 인스턴스는 서버 생성 중에 지연 바인딩될 수 있다. */
  attachIo(io) {
    this.io = io;
  }

  /** GET /api/stream 핸들러. */
  addSseClient(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    res.write('event: connected\ndata: {"ok":true}\n\n');
    this.sseClients.add(res);
    const cleanup = () => this.sseClients.delete(res);
    req.on('close', cleanup);
    res.on('error', cleanup);
  }

  hasClients() {
    return (this.io?.engine?.clientsCount || 0) > 0 || this.sseClients.size > 0;
  }

  emit(name, payload) {
    this.io?.emit(name, payload);
    if (this.sseClients.size === 0) return;
    const frame = `event: ${name}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(frame);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  stop() {
    if (this.sseHeartbeat) {
      clearInterval(this.sseHeartbeat);
      this.sseHeartbeat = null;
    }
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch { /* already closed */ }
    }
    this.sseClients.clear();
  }
}

export default RealtimeHub;

import { DurableObject } from 'cloudflare:workers';

// Signaling only. Do not add storage, alarms, attachments, or payload logging here.
export class WhisperRoom extends DurableObject {
  sender = null;
  recipient = null;
  closed = false;
  expiresAt = 0;
  stage = 'waiting';

  fetch(request) {
    const role = new URL(request.url).pathname.split('/').at(-1);
    if (!['sender', 'recipient'].includes(role)) return new Response(null, { status: 404 });
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 });
    if (this.closed || (this.expiresAt && Date.now() >= this.expiresAt)) {
      this.close(1000, 'Expired');
      return new Response(null, { status: 410 });
    }
    if (role === 'recipient' && !this.sender) return new Response(null, { status: 410 });
    if (this[role]) return new Response(null, { status: 409 });
    if (this.sender && this.sender.readyState !== WebSocket.OPEN) {
      this.close(1000, 'Sender left');
      return new Response(null, { status: 410 });
    }

    const [client, socket] = Object.values(new WebSocketPair());
    socket.accept();
    this[role] = socket;
    if (role === 'sender') {
      this.expiresAt = Date.now() + 600_000;
      this.expiryTimer = setTimeout(() => this.close(1000, 'Expired'), 600_000);
    }
    let lastPing = 0;
    socket.addEventListener('message', (event) => {
      if (this.closed) return;
      if (Date.now() >= this.expiresAt) { this.close(1000, 'Expired'); return; }
      try {
        if (typeof event.data !== 'string' || event.data.length > 24_000
          || new TextEncoder().encode(event.data).length > 24_000) throw new Error();
        const message = JSON.parse(event.data);
        if (!message || Array.isArray(message) || typeof message !== 'object') throw new Error();
        if (message.type === 'ping' && Object.keys(message).length === 1) {
          if (lastPing && Date.now() - lastPing < 10_000) throw new Error();
          lastPing = Date.now();
          socket.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        const expected = role === 'sender' ? 'offer' : 'answer';
        if (!this.recipient || message.type !== expected || Object.keys(message).length !== 3
          || typeof message.sdp !== 'string' || message.sdp.length > 16_384
          || new TextEncoder().encode(message.sdp).length > 16_384
          || !message.sdp.startsWith('v=0\r\n') || !message.sdp.includes('m=application ')
          || !message.sdp.includes('a=fingerprint:sha-256 ')
          || typeof message.mac !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(message.mac)
          || this.stage !== (expected === 'offer' ? 'offer' : 'answer')) throw new Error();
        this.stage = expected === 'offer' ? 'answer' : 'connected';
        const target = role === 'sender' ? this.recipient : this.sender;
        target.send(JSON.stringify({ type: message.type, sdp: message.sdp, mac: message.mac }));
        if (expected === 'answer') {
          clearTimeout(this.connectionTimer);
          this.connectionTimer = setTimeout(() => this.close(1000, 'Connection timed out'), 45_000);
        }
      } catch {
        this.close(1008, 'Invalid signaling');
      }
    });
    socket.addEventListener('close', () => this.close(1000, 'Peer left'));
    socket.addEventListener('error', () => this.close(1011, 'Connection lost'));
    socket.send(JSON.stringify({ type: 'ready', expiresAt: this.expiresAt }));
    if (role === 'recipient') {
      this.stage = 'offer';
      this.connectionTimer = setTimeout(() => this.close(1000, 'Connection timed out'), 30_000);
      this.sender.send(JSON.stringify({ type: 'peer' }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.expiryTimer);
    clearTimeout(this.connectionTimer);
    for (const socket of [this.sender, this.recipient]) {
      if (socket?.readyState === WebSocket.OPEN) socket.close(code, reason);
    }
    this.sender = null;
    this.recipient = null;
  }
}

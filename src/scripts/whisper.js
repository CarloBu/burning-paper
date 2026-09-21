import {
  randomToken, deriveWhisperKeys, signDescription, verifyDescription, encryptWhisper, decryptWhisper,
} from './whisper-crypto.js';

const CONNECTION_ERROR = 'These networks could not connect directly. Try another network or create a Sealed Letter.';
const SIGNALING_ERROR = 'Could not reach the Whisper service. Check your connection and try again.';
const DELIVERY_ERROR = 'Delivery could not be confirmed. The recipient may have received it. Create a new secret if needed.';
const CLOSED_ERROR = 'This whisper has faded. Ask for a new link.';

export function whisperSupported() {
  return window.isSecureContext && Boolean(crypto.subtle) && typeof RTCPeerConnection === 'function';
}

export function createWhisper(text, callbacks) {
  return new WhisperSession('sender', randomToken(), randomToken(), callbacks, text);
}

export function receiveWhisper(id, secret, callbacks) {
  return new WhisperSession('recipient', id, secret, callbacks);
}

class WhisperSession {
  constructor(role, id, secret, callbacks, text = '') {
    this.role = role;
    this.id = id;
    this.callbacks = callbacks;
    this.fragment = role === 'sender' ? `live.v1.${id}.${secret}` : '';
    this.expiresAt = Date.now() + 600_000;
    this.done = false;
    this.sent = false;
    this.received = false;
    this.remoteAuthenticated = false;
    this.descriptionReceived = false;
    this.negotiating = false;
    this.signalQueue = Promise.resolve();
    this.dataQueue = Promise.resolve();
    this.setDeadline(30_000, SIGNALING_ERROR);
    void this.start(secret, text).catch((error) => this.fail(error));
  }

  async start(secret, text) {
    if (!whisperSupported()) throw new Error('Whisper needs a browser with WebRTC and a secure connection.');
    const keys = await deriveWhisperKeys(this.id, secret);
    if (!this.checkDeadline()) return;
    this.keys = keys;
    if (this.role === 'sender') {
      const payload = await encryptWhisper(this.id, keys.encryption, text);
      text = '';
      if (!this.checkDeadline()) return;
      this.payload = payload;
    }
    const url = new URL(`/api/whisper/${this.id}/${this.role}`, location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', (event) => {
      this.signalQueue = this.signalQueue.then(async () => {
        if (!this.checkDeadline()) return;
        const message = this.parseMessage(event.data, 24_000);
        await this.onSignal(message);
      }).catch((error) => this.fail(error));
    });
    this.socket.addEventListener('error', () => this.fail(new Error(
      this.role === 'sender' && !this.registered ? SIGNALING_ERROR : CLOSED_ERROR,
    )));
    this.socket.addEventListener('close', () => {
      if (this.received) this.close();
      else this.fail(new Error(this.role === 'sender' && !this.registered ? SIGNALING_ERROR : CLOSED_ERROR));
    });
    this.heartbeat = setInterval(() => {
      if (this.checkDeadline() && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15_000);
  }

  parseMessage(data, maximum) {
    if (typeof data !== 'string' || data.length > maximum || new TextEncoder().encode(data).length > maximum) {
      throw new Error('Invalid Whisper response.');
    }
    const message = JSON.parse(data);
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid Whisper response.');
    return message;
  }

  async onSignal(message) {
    if (message.type === 'pong' && Object.keys(message).length === 1) return;
    if (message.type === 'ready') {
      if (this.registered || Object.keys(message).length !== 2 || !Number.isFinite(message.expiresAt)
        || message.expiresAt <= Date.now()) throw new Error(CLOSED_ERROR);
      this.registered = true;
      this.expiresAt = Math.min(this.expiresAt, message.expiresAt);
      if (this.role === 'sender') {
        this.setDeadline(this.expiresAt - Date.now(), 'This whisper has faded. Create a new link.');
        this.callbacks.ready?.({ fragment: this.fragment, expiresAt: this.expiresAt });
      } else {
        this.setDeadline(30_000, CONNECTION_ERROR);
      }
      return;
    }
    if (!this.registered) throw new Error('Unexpected Whisper response.');
    if (message.type === 'peer' && Object.keys(message).length === 1 && this.role === 'sender' && !this.negotiating) {
      this.negotiating = true;
      this.setDeadline(30_000, CONNECTION_ERROR);
      this.callbacks.progress?.('Your recipient is connecting. Keep this tab open.');
      this.createPeer();
      this.bindChannel(this.peer.createDataChannel('whisper', { ordered: true, protocol: 'whisper-v1' }));
      await this.peer.setLocalDescription(await this.peer.createOffer());
      await this.sendDescription();
      return;
    }
    const expected = this.role === 'sender' ? 'answer' : 'offer';
    if (this.descriptionReceived || message.type !== expected) throw new Error('Unexpected Whisper response.');
    this.descriptionReceived = true;
    const description = await verifyDescription(this.id, this.keys.authentication, message, expected);
    if (!this.checkDeadline()) return;
    if (this.role === 'recipient') {
      this.negotiating = true;
      this.createPeer();
    }
    if (!this.peer) throw new Error('Unexpected Whisper response.');
    // The authenticated SDP binds the peer's DTLS certificate to the link secret.
    this.remoteAuthenticated = true;
    await this.peer.setRemoteDescription(description);
    if (!this.checkDeadline()) return;
    if (this.role === 'recipient') {
      await this.peer.setLocalDescription(await this.peer.createAnswer());
      await this.sendDescription();
    }
  }

  createPeer() {
    this.peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
    this.peer.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed', 'disconnected'].includes(this.peer?.connectionState)) {
        if (this.received) this.close();
        else this.fail(new Error(CONNECTION_ERROR));
      }
    });
    this.peer.addEventListener('datachannel', ({ channel }) => {
      if (this.role !== 'recipient' || this.channel || !this.remoteAuthenticated) {
        channel.close();
        this.fail(new Error('Unexpected Whisper connection.'));
        return;
      }
      try { this.bindChannel(channel); }
      catch (error) { this.fail(error); }
    });
  }

  async sendDescription() {
    const peer = this.peer;
    if (peer.iceGatheringState !== 'complete') {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          peer.removeEventListener('icegatheringstatechange', onChange);
          this.cancelGathering = null;
        };
        const onChange = () => {
          if (peer.iceGatheringState === 'complete') { cleanup(); resolve(); }
        };
        this.cancelGathering = () => { cleanup(); reject(new Error(CLOSED_ERROR)); };
        peer.addEventListener('icegatheringstatechange', onChange);
        onChange();
      });
    }
    if (!this.checkDeadline()) return;
    const message = await signDescription(this.id, this.keys.authentication, peer.localDescription);
    if (!this.checkDeadline()) return;
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error(CLOSED_ERROR);
    this.socket.send(JSON.stringify(message));
  }

  bindChannel(channel) {
    if (channel.label !== 'whisper' || channel.protocol !== 'whisper-v1' || !channel.ordered
      || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
      channel.close();
      throw new Error('Unexpected Whisper connection.');
    }
    this.channel = channel;
    channel.addEventListener('open', () => {
      if (!this.checkDeadline()) return;
      if (!this.remoteAuthenticated) { this.fail(new Error('Unauthenticated Whisper connection.')); return; }
      if (this.role === 'sender') {
        if (this.sent || !this.payload) { this.fail(new Error(CLOSED_ERROR)); return; }
        // Claim before sending. An ambiguous delivery must never return to waiting.
        this.sent = true;
        this.setDeadline(15_000, DELIVERY_ERROR);
        try {
          channel.send(JSON.stringify(this.payload));
          this.payload = null;
          this.callbacks.progress?.('Sending your whisper…');
        } catch (error) { this.fail(error); }
      } else {
        this.setDeadline(15_000, CONNECTION_ERROR);
      }
    });
    channel.addEventListener('message', (event) => {
      this.dataQueue = this.dataQueue.then(async () => {
        if (!this.checkDeadline()) return;
        if (!this.remoteAuthenticated) throw new Error('Unauthenticated Whisper connection.');
        const message = this.parseMessage(event.data, 8192);
        if (this.role === 'sender') {
          if (!this.sent || message.type !== 'received' || Object.keys(message).length !== 1) {
            throw new Error('Invalid delivery acknowledgement.');
          }
          const delivered = this.callbacks.delivered;
          this.close();
          delivered?.();
          return;
        }
        if (this.receiving) throw new Error('This whisper was already received.');
        this.receiving = true;
        const text = await decryptWhisper(this.id, this.keys.encryption, message);
        if (!this.checkDeadline()) return;
        channel.send(JSON.stringify({ type: 'received' }));
        this.received = true;
        this.keys = null;
        clearTimeout(this.deadlineTimer);
        this.callbacks.received?.(text);
        // Give the ordered acknowledgement time to leave before local teardown.
        this.cleanupTimer = setTimeout(() => this.close(), 1000);
      }).catch((error) => this.fail(error));
    });
    channel.addEventListener('error', () => this.fail(new Error(CONNECTION_ERROR)));
    channel.addEventListener('close', () => {
      if (this.received) this.close();
      else this.fail(new Error(CLOSED_ERROR));
    });
  }

  setDeadline(milliseconds, message) {
    clearTimeout(this.deadlineTimer);
    this.deadline = Date.now() + milliseconds;
    this.deadlineMessage = message;
    const check = () => {
      if (this.checkDeadline() && !this.received) {
        this.deadlineTimer = setTimeout(check, Math.max(1, Math.min(this.deadline, this.expiresAt) - Date.now()));
      }
    };
    this.deadlineTimer = setTimeout(check, Math.max(0, milliseconds));
  }

  checkDeadline() {
    if (this.done) return false;
    if (!this.received && (Date.now() >= this.expiresAt || Date.now() >= this.deadline)) {
      this.fail(new Error(this.deadlineMessage));
      return false;
    }
    return true;
  }

  fail(error) {
    if (this.done) return;
    if (this.received) { this.close(); return; }
    const report = this.callbacks.error;
    const message = this.sent ? DELIVERY_ERROR
      : error?.name === 'OperationError' ? 'This whisper could not be decrypted. Ask for a new link.'
      : error instanceof Error && error.message ? error.message : CLOSED_ERROR;
    this.close();
    report?.(message);
  }

  close() {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.deadlineTimer);
    clearTimeout(this.cleanupTimer);
    clearInterval(this.heartbeat);
    this.cancelGathering?.();
    this.channel?.close();
    this.peer?.close();
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, 'Whisper closed');
    this.payload = null;
    this.keys = null;
    this.fragment = '';
    this.callbacks = {};
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';

const origin = 'https://burning-paper.test';
const sockets = [];
let requestNumber = 0;
const token = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function upgrade(id, role, headers = {}, method = 'GET') {
  return exports.default.fetch(`${origin}/api/whisper/${id}/${role}`, {
    method,
    headers: { Origin: origin, Upgrade: 'websocket', 'CF-Connecting-IP': `203.0.113.${++requestNumber}`, ...headers },
  });
}

async function connect(id, role) {
  const response = await upgrade(id, role);
  expect(response.status).toBe(101);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self' wss://burning-paper.test;");
  const socket = response.webSocket;
  const messages = [];
  const readers = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (readers.length) readers.shift()(message);
    else messages.push(message);
  });
  const closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
  socket.accept();
  sockets.push(socket);
  return {
    socket, closed,
    next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => readers.push(resolve)),
    send: (message) => socket.send(JSON.stringify(message)),
  };
}

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'Test complete');
  }
});

const description = (type) => ({
  type,
  sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA:BB\r\n',
  mac: 'A'.repeat(43),
});

async function pair() {
  const id = token();
  const sender = await connect(id, 'sender');
  expect((await sender.next()).type).toBe('ready');
  const recipient = await connect(id, 'recipient');
  expect((await recipient.next()).type).toBe('ready');
  expect(await sender.next()).toEqual({ type: 'peer' });
  return { id, sender, recipient };
}

describe('Whisper signaling', () => {
  it('forwards only one offer and answer without persisting room data', async () => {
    const { id, sender, recipient } = await pair();
    sender.send(description('offer'));
    expect(await recipient.next()).toEqual(description('offer'));
    recipient.send(description('answer'));
    expect(await sender.next()).toEqual(description('answer'));
    await runInDurableObject(env.WHISPERS.getByName(id), async (_, state) => {
      expect((await state.storage.list()).size).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('does not let a recipient create a missing session', async () => {
    expect((await upgrade(token(), 'recipient')).status).toBe(410);
  });

  it('rejects duplicate senders and competing recipients without closing the pair', async () => {
    const { id, sender, recipient } = await pair();
    expect((await upgrade(id, 'sender')).status).toBe(409);
    const competitors = await Promise.all([upgrade(id, 'recipient'), upgrade(id, 'recipient')]);
    expect(competitors.map((response) => response.status)).toEqual([409, 409]);
    sender.send(description('offer'));
    expect(await recipient.next()).toEqual(description('offer'));
  });

  it('closes the peer and refuses reuse when the sender leaves', async () => {
    const { id, sender, recipient } = await pair();
    sender.socket.close(1000, 'Leaving');
    await recipient.closed;
    expect((await upgrade(id, 'recipient')).status).toBe(410);
    expect((await upgrade(id, 'sender')).status).toBe(410);
  });

  it('loses the session on restart instead of recovering it', async () => {
    const id = token();
    const sender = await connect(id, 'sender');
    await sender.next();
    await expect(runInDurableObject(env.WHISPERS.getByName(id), (_, state) => {
      state.abort('Restart live session');
    })).rejects.toThrow();
    expect((await upgrade(id, 'recipient')).status).toBe(410);
  });

  it('refuses expired rooms even before the timer callback', async () => {
    const id = token();
    const sender = await connect(id, 'sender');
    await sender.next();
    await runInDurableObject(env.WHISPERS.getByName(id), (instance) => { instance.expiresAt = Date.now() - 1; });
    expect((await upgrade(id, 'recipient')).status).toBe(410);
    await sender.closed;
  });

  it.each([
    { type: 'secret', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'do-not-forward' },
    { ...description('offer'), key: 'do-not-forward' },
    { ...description('offer'), mac: 'invalid' },
    { ...description('offer'), sdp: 'A'.repeat(20_000) },
    { type: 'offer', sdp: 'not an SDP', mac: 'A'.repeat(43) },
  ])('closes on unexpected or malformed signaling %#', async (message) => {
    const { sender, recipient } = await pair();
    sender.send(message);
    expect((await recipient.closed).code).toBe(1008);
  });

  it('rejects binary frames', async () => {
    const { sender, recipient } = await pair();
    sender.socket.send(new Uint8Array([1, 2, 3]));
    expect((await recipient.closed).code).toBe(1008);
  });

  it('rejects an answer before the offer', async () => {
    const { sender, recipient } = await pair();
    recipient.send(description('answer'));
    expect((await sender.closed).code).toBe(1008);
  });

  it('rejects repeated offers rather than allowing renegotiation', async () => {
    const { sender, recipient } = await pair();
    sender.send(description('offer'));
    await recipient.next();
    sender.send(description('offer'));
    expect((await recipient.closed).code).toBe(1008);
  });

  it('bounds heartbeat traffic', async () => {
    const id = token();
    const sender = await connect(id, 'sender');
    await sender.next();
    sender.send({ type: 'ping' });
    expect(await sender.next()).toEqual({ type: 'pong' });
    sender.send({ type: 'ping' });
    expect((await sender.closed).code).toBe(1008);
  });

  it.each([{ Origin: '' }, { Origin: 'https://elsewhere.test' }, { 'Sec-Fetch-Site': 'cross-site' }])(
    'rejects untrusted upgrade context %j', async (headers) => {
      expect((await upgrade(token(), 'sender', headers)).status).toBe(403);
    },
  );

  it('requires canonical identifiers, known roles, GET and a websocket upgrade', async () => {
    expect((await upgrade('invalid', 'sender')).status).toBe(400);
    expect((await upgrade(`${'A'.repeat(42)}B`, 'sender')).status).toBe(400);
    expect((await upgrade(token(), 'unknown')).status).toBe(404);
    expect((await upgrade(token(), 'sender', { Upgrade: '' }, 'POST')).status).toBe(405);
    expect((await upgrade(token(), 'sender', { Upgrade: '' })).status).toBe(426);
  });

  it('rate limits connection attempts before opening a room', async () => {
    let response;
    for (let index = 0; index < 31; index++) {
      response = await upgrade(token(), 'recipient', { 'CF-Connecting-IP': '198.51.100.155' });
    }
    expect(response.status).toBe(429);
  });
});

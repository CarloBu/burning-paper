import { encode, decode } from './crypto.js';

const encoder = new TextEncoder();
const context = (id) => encoder.encode(`burning-paper/whisper/v1/${id}`);

export function randomToken() {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

export function readWhisperLink(fragment) {
  const match = /^live\.v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(fragment);
  if (!match) throw new Error('Invalid Whisper link.');
  decode(match[1], 32, 32).fill(0);
  decode(match[2], 32, 32).fill(0);
  return { id: match[1], secret: match[2] };
}

export async function deriveWhisperKeys(id, secret) {
  const raw = decode(secret, 32, 32);
  const salt = decode(id, 32, 32);
  try {
    const root = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    const derive = (purpose, algorithm, usages) => crypto.subtle.deriveKey({
      name: 'HKDF', hash: 'SHA-256', salt,
      info: encoder.encode(`burning-paper/whisper/v1/${purpose}`),
    }, root, algorithm, false, usages);
    const [encryption, authentication] = await Promise.all([
      derive('message', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
      derive('signaling', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']),
    ]);
    return { encryption, authentication };
  } finally {
    raw.fill(0);
    salt.fill(0);
  }
}

function descriptionBytes(id, type, sdp) {
  if (!['offer', 'answer'].includes(type) || typeof sdp !== 'string' || sdp.length > 16_384
    || !sdp.startsWith('v=0\r\n') || !sdp.includes('a=fingerprint:sha-256 ')
    || !sdp.includes('m=application ') || encoder.encode(sdp).length > 16_384) {
    throw new Error('Invalid connection description.');
  }
  return encoder.encode(JSON.stringify(['whisper-v1', id, type, sdp]));
}

export async function signDescription(id, authentication, description) {
  const { type, sdp } = description;
  const bytes = descriptionBytes(id, type, sdp);
  const mac = await crypto.subtle.sign('HMAC', authentication, bytes);
  return { type, sdp, mac: encode(new Uint8Array(mac)) };
}

export async function verifyDescription(id, authentication, message, expectedType) {
  if (!message || Array.isArray(message) || Object.keys(message).length !== 3 || message.type !== expectedType) {
    throw new Error('Unexpected connection description.');
  }
  const bytes = descriptionBytes(id, message.type, message.sdp);
  const mac = decode(message.mac, 32, 32);
  if (!await crypto.subtle.verify('HMAC', authentication, mac, bytes)) {
    throw new Error('The Whisper link could not authenticate this connection. Ask for a new link.');
  }
  return { type: message.type, sdp: message.sdp };
}

export async function encryptWhisper(id, encryption, text) {
  const plaintext = encoder.encode(text);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    if (!plaintext.length || plaintext.length > 4096) throw new Error('Use between 1 and 4,096 bytes.');
    const ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM', iv, tagLength: 128, additionalData: context(id),
    }, encryption, plaintext);
    return { type: 'secret', iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptWhisper(id, encryption, message) {
  if (!message || Array.isArray(message) || Object.keys(message).length !== 3 || message.type !== 'secret') {
    throw new Error('Invalid Whisper message.');
  }
  const iv = decode(message.iv, 12, 12);
  const ciphertext = decode(message.ciphertext, 17, 4112);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({
    name: 'AES-GCM', iv, tagLength: 128, additionalData: context(id),
  }, encryption, ciphertext));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } finally {
    plaintext.fill(0);
    ciphertext.fill(0);
  }
}

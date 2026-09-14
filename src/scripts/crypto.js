export function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decode(text, minBytes, maxBytes) {
  if (typeof text !== 'string' || text.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error('Invalid encrypted data.');
  }
  const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
  if (bytes.length < minBytes || bytes.length > maxBytes || encode(bytes) !== text) {
    bytes.fill(0);
    throw new Error('Invalid encrypted data.');
  }
  return bytes;
}

export async function readSecretLink(fragment) {
  const match = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(fragment);
  if (!match) throw new Error('Invalid secret link.');
  decode(match[1], 32, 32);
  const rawKey = decode(match[2], 32, 32);
  try {
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    return { id: match[1], key };
  } finally {
    rawKey.fill(0);
  }
}

export async function encryptSecret(text) {
  const plaintext = new TextEncoder().encode(text);
  if (plaintext.length === 0 || plaintext.length > 4096) throw new Error('Use between 1 and 4,096 bytes.');
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, plaintext);
    return { key: encode(rawKey), payload: { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) } };
  } finally {
    rawKey.fill(0);
    plaintext.fill(0);
  }
}

export async function decryptSecret(payload, key) {
  const iv = decode(payload.iv, 12, 12);
  const ciphertext = decode(payload.ciphertext, 17, 4112);
  const buffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, ciphertext);
  const plaintext = new Uint8Array(buffer);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } finally {
    plaintext.fill(0);
  }
}

import { DurableObject } from 'cloudflare:workers';

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(self)',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export class Paper extends DurableObject {
  async store(payload) {
    const expiresAt = Date.now() + 86_400_000;
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put('secret', { ...payload, expiresAt });
      await txn.setAlarm(expiresAt);
    });
  }

  async consume() {
    // The read and deletion commit together; competing requests cannot both win.
    return this.ctx.storage.transaction(async (txn) => {
      const secret = await txn.get('secret');
      await txn.delete('secret');
      await txn.deleteAlarm();
      if (!secret || secret.expiresAt <= Date.now()) return null;
      return { iv: secret.iv, ciphertext: secret.ciphertext };
    });
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

function fail(status, message) {
  throw Response.json({ error: message }, { status });
}

async function readJson(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
    fail(415, 'Please send JSON.');
  }
  if (!request.body) fail(400, 'The request is empty.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        fail(413, 'This secret is too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Invalid request.');
    return body;
  } catch {
    fail(400, 'Invalid request.');
  }
}

function validBase64(value, minBytes, maxBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const canonical = btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return canonical === value && decoded.length >= minBytes && decoded.length <= maxBytes;
  } catch {
    return false;
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') fail(405, 'Method not allowed.');
    return env.ASSETS.fetch(request);
  }
  if (url.pathname !== '/api/secrets' && url.pathname !== '/api/reveal') fail(404, 'Not found.');
  if (request.method !== 'POST') fail(405, 'Method not allowed.');
  if (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    fail(403, 'Open Burning Paper directly to continue.');
  }
  const { success } = await env.RATE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' });
  if (!success) fail(429, 'Too many requests. Please wait a minute.');
  const body = await readJson(request);

  if (url.pathname === '/api/secrets') {
    if (Object.keys(body).length !== 2 || !validBase64(body.iv, 12, 12) || !validBase64(body.ciphertext, 17, 4112)) {
      fail(400, 'Invalid encrypted secret.');
    }
    const id = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await env.PAPERS.getByName(id).store({ iv: body.iv, ciphertext: body.ciphertext });
    return Response.json({ id }, { status: 201 });
  }

  if (Object.keys(body).length !== 1 || !validBase64(body.id, 32, 32)) fail(400, 'Invalid secret link.');
  const secret = await env.PAPERS.getByName(body.id).consume();
  if (!secret) fail(410, 'This secret was already opened or has expired.');
  return Response.json(secret);
}

export default {
  async fetch(request, env) {
    let response;
    try {
      response = await route(request, env);
    } catch (error) {
      response = error instanceof Response
        ? error
        : Response.json({ error: 'Something went wrong. Please try again later.' }, { status: 500 });
    }
    const secured = new Response(response.body, response);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value);
    secured.headers.delete('ETag');
    secured.headers.delete('Last-Modified');
    return secured;
  },
};

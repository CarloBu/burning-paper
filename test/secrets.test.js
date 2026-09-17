import { env, exports } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const origin = 'https://burning-paper.test';
let requestNumber = 0;
function post(path, body, headers = {}) {
  return exports.default.fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': `192.0.2.${++requestNumber}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// A valid AES-GCM-sized opaque payload, independent of the encryption helper.
const payload = { iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AQEBAQEBAQEBAQEBAQEBAQE' };
async function create() {
  const response = await post('/api/secrets', payload);
  expect(response.status).toBe(201);
  return response.json();
}

describe('one-time storage', () => {
  it('returns ciphertext once and removes it from live storage', async () => {
    const { id } = await create();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const first = await post('/api/reveal', { id });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(payload);
    expect((await post('/api/reveal', { id })).status).toBe(410);
    await runInDurableObject(env.PAPERS.getByName(id), async (_, state) => {
      expect((await state.storage.list()).size).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('allows only one of twelve simultaneous retrievals', async () => {
    const { id } = await create();
    const responses = await Promise.all(Array.from({ length: 12 }, () => post('/api/reveal', { id })));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 410)).toHaveLength(11);
  });

  it('preserves consumption across object restarts even when the response is discarded', async () => {
    const { id } = await create();
    await evictDurableObject(env.PAPERS.getByName(id));
    const response = await post('/api/reveal', { id });
    expect(response.status).toBe(200);
    await response.body.cancel();
    await evictDurableObject(env.PAPERS.getByName(id));
    expect((await post('/api/reveal', { id })).status).toBe(410);
  });

  it('does not consume on GET or HEAD, including link previews', async () => {
    const { id } = await create();
    for (const method of ['GET', 'HEAD']) {
      expect((await exports.default.fetch(`${origin}/api/reveal`, { method })).status).toBe(405);
    }
    expect((await post('/api/reveal', { id })).status).toBe(200);
  });

  it('refuses expired records even before their cleanup alarm runs', async () => {
    const { id } = await create();
    await runInDurableObject(env.PAPERS.getByName(id), async (_, state) => {
      const record = await state.storage.get('secret');
      await state.storage.put('secret', { ...record, expiresAt: Date.now() - 1 });
    });
    expect((await post('/api/reveal', { id })).status).toBe(410);
    await runInDurableObject(env.PAPERS.getByName(id), async (_, state) => {
      expect(await state.storage.get('secret')).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('schedules a 24-hour alarm and deletes unopened secrets', async () => {
    const before = Date.now();
    const { id } = await create();
    const stub = env.PAPERS.getByName(id);
    await runInDurableObject(stub, async (_, state) => {
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(before + 86_400_000);
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 86_400_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.alarm();
      expect(await state.storage.get('secret')).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect((await post('/api/reveal', { id })).status).toBe(410);
  });
});

describe('request boundaries', () => {
  it('rejects cross-origin requests without consuming the secret', async () => {
    const { id } = await create();
    expect((await post('/api/reveal', { id }, { Origin: 'https://elsewhere.test' })).status).toBe(403);
    expect((await post('/api/reveal', { id })).status).toBe(200);
  });

  it.each([
    { Origin: '' },
    { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ])('rejects untrusted browser context %j without consuming', async (headers) => {
    const { id } = await create();
    expect((await post('/api/reveal', { id }, headers)).status).toBe(403);
    expect((await post('/api/reveal', { id })).status).toBe(200);
  });

  it('rejects extra reveal fields without consuming', async () => {
    const { id } = await create();
    expect((await post('/api/reveal', { id, key: 'must-not-be-sent' })).status).toBe(400);
    expect((await post('/api/reveal', { id })).status).toBe(200);
  });

  it.each([
    null,
    {},
    { ...payload, iv: 'bad' },
    { ...payload, ciphertext: 'plain text' },
    { ...payload, ciphertext: 'AQ' },
    { ...payload, key: 'must-not-be-sent' },
  ])('rejects invalid create payload %j', async (body) => {
    expect((await post('/api/secrets', body)).status).toBe(400);
  });

  it.each([
    [16, 400],
    [17, 201],
    [4112, 201],
    [4113, 400],
  ])('enforces the decoded ciphertext limit for %i bytes', async (size, expectedStatus) => {
    const ciphertext = btoa('\0'.repeat(size)).replace(/=+$/, '');
    const response = await post('/api/secrets', { ...payload, ciphertext });
    expect(response.status).toBe(expectedStatus);
    if (expectedStatus === 201) {
      const { id } = await response.json();
      expect(await (await post('/api/reveal', { id })).json()).toEqual({ ...payload, ciphertext });
    }
  });

  it('rejects noncanonical Base64 rather than accepting aliases', async () => {
    expect((await post('/api/secrets', { ...payload, ciphertext: 'AQEBAQEBAQEBAQEBAQEBAQF' })).status).toBe(400);
    expect((await post('/api/reveal', { id: `${'A'.repeat(42)}B` })).status).toBe(400);
  });

  it('limits input size, including bodies without Content-Length', async () => {
    expect((await post('/api/secrets', { ...payload, ciphertext: 'A'.repeat(9000) })).status).toBe(413);
  });

  it('rejects malformed JSON and incorrect content type', async () => {
    const response = await exports.default.fetch(`${origin}/api/secrets`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{',
    });
    expect(response.status).toBe(400);
    expect((await post('/api/secrets', payload, { 'Content-Type': 'text/plain' })).status).toBe(415);
  });

  it('rate limits repeated requests from the same source', async () => {
    const responses = [];
    for (let index = 0; index < 31; index++) {
      responses.push(await post('/api/reveal', { id: 'invalid' }, { 'CF-Connecting-IP': '198.51.100.99' }));
    }
    expect(responses.at(-1).status).toBe(429);
    expect(responses.at(-1).headers.get('Cache-Control')).toContain('no-store');
  });

  it('instructs browsers and intermediaries not to cache successful or failed responses', async () => {
    for (const response of [
      await post('/api/secrets', payload),
      await post('/api/reveal', { id: 'invalid' }),
      await post('/api/reveal', await create()),
      await exports.default.fetch(`${origin}/robots.txt`),
      await exports.default.fetch(`${origin}/missing-file`),
    ]) {
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
      expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=');
      expect(response.headers.has('ETag')).toBe(false);
      expect(response.headers.has('Last-Modified')).toBe(false);
    }
  });
});

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



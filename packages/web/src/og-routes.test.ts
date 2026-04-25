import { mkdtemp, readdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type MomentRecord, deriveWorldClock } from '@tina/shared';
import { describe, expect, test } from 'vitest';
import { MomentStore } from './moments.js';
import { OG_HEIGHT, OG_WIDTH } from './og-image.js';
import { OgCache, OgRoutes } from './og-routes.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function mockReq(
  opts: {
    headers?: Record<string, string>;
    remoteAddress?: string;
  } = {},
): IncomingMessage {
  const stream = Readable.from([]) as unknown as IncomingMessage;
  stream.method = 'GET';
  stream.url = '/';
  stream.headers = opts.headers ?? {};
  (stream as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
  };
  return stream;
}

type MockRes = ServerResponse & {
  statusCode: number;
  body: Buffer;
  responseHeaders: Record<string, string | string[]>;
};

function mockRes(): MockRes {
  const state = {
    statusCode: 0,
    body: Buffer.alloc(0),
    responseHeaders: {} as Record<string, string | string[]>,
  };
  const res = {
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(v: number) {
      state.statusCode = v;
    },
    get body() {
      return state.body;
    },
    get responseHeaders() {
      return state.responseHeaders;
    },
    writeHead(status: number, headers?: Record<string, string | string[]>) {
      state.statusCode = status;
      if (headers) Object.assign(state.responseHeaders, headers);
      return this;
    },
    setHeader(name: string, value: string | string[]) {
      state.responseHeaders[name] = value;
    },
    end(body?: string | Buffer) {
      if (body == null) state.body = Buffer.alloc(0);
      else if (typeof body === 'string') state.body = Buffer.from(body);
      else state.body = Buffer.from(body); // copy to widen ArrayBufferLike → ArrayBuffer
    },
  } as unknown as MockRes;
  return res;
}

function mkStore(): { store: MomentStore; record: MomentRecord; second: MomentRecord } {
  const idGen = (() => {
    let n = 0;
    return () => `mom${++n}`;
  })();
  const store = new MomentStore({ maxMoments: 10, idGenerator: idGen });
  const record = store.captureClose(
    {
      sessionId: 's1',
      simTime: 14 * 3600,
      openedAt: 14 * 3600,
      transcript: [{ speakerId: 'mei', text: 'hi', at: 14 * 3600 }],
      participants: [
        { id: 'mei', name: 'Mei', named: true, color: '#ffaaaa' },
        { id: 'rin', name: 'Rin', named: true, color: '#aaffff' },
      ],
      zone: 'garden',
      closeReason: 'idle',
    },
    deriveWorldClock(14 * 3600, 30),
  );
  const second = store.captureClose(
    {
      sessionId: 's2',
      simTime: 15 * 3600,
      openedAt: 15 * 3600,
      transcript: [{ speakerId: 'kai', text: 'yo', at: 15 * 3600 }],
      participants: [
        { id: 'kai', name: 'Kai', named: true, color: '#ffffaa' },
        { id: 'mei', name: 'Mei', named: true, color: '#ffaaaa' },
      ],
      zone: 'cafe',
      closeReason: 'idle',
    },
    deriveWorldClock(15 * 3600, 30),
  );
  return { store, record, second };
}

describe('OgCache', () => {
  test('round-trips a buffer in memory mode', async () => {
    const cache = new OgCache({ maxEntries: 5 });
    expect(await cache.get('mom1')).toBeNull();
    const buf = Buffer.from('hello-png');
    await cache.set('mom1', buf);
    expect(await cache.get('mom1')).toEqual(buf);
  });

  test('rejects invalid id patterns', async () => {
    const cache = new OgCache({ maxEntries: 5 });
    await cache.set('../etc/passwd', Buffer.from('x'));
    expect(await cache.get('../etc/passwd')).toBeNull();
  });

  test('LRU evicts oldest beyond cap', async () => {
    const cache = new OgCache({ maxEntries: 2 });
    await cache.set('a', Buffer.from('A'));
    await cache.set('b', Buffer.from('B'));
    await cache.set('c', Buffer.from('C'));
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).not.toBeNull();
    expect(await cache.get('c')).not.toBeNull();
    expect(cache.size()).toBe(2);
  });

  test('hit promotes to MRU', async () => {
    const cache = new OgCache({ maxEntries: 2 });
    await cache.set('a', Buffer.from('A'));
    await cache.set('b', Buffer.from('B'));
    await cache.get('a'); // promote a
    await cache.set('c', Buffer.from('C')); // evicts b, not a
    expect(await cache.get('a')).not.toBeNull();
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('c')).not.toBeNull();
  });

  test('disk-backed mode persists files and unlinks on eviction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ogcache-'));
    const cache = new OgCache({ dir, maxEntries: 2 });
    await cache.set('a', Buffer.from('A'));
    await cache.set('b', Buffer.from('B'));
    let files = await readdir(dir);
    expect(files.sort()).toEqual(['a.png', 'b.png']);
    await cache.set('c', Buffer.from('C')); // evicts a
    // Eviction is fire-and-forget — give it a tick.
    await new Promise((r) => setTimeout(r, 10));
    files = await readdir(dir);
    expect(files.sort()).toEqual(['b.png', 'c.png']);
    // Reading from disk on hit.
    const got = await cache.get('b');
    expect(got).not.toBeNull();
    expect(got!.toString()).toBe('B');
  });

  test('reset clears in-memory state but leaves disk files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ogcache-reset-'));
    const cache = new OgCache({ dir, maxEntries: 5 });
    await cache.set('a', Buffer.from('A'));
    cache.reset();
    expect(cache.size()).toBe(0);
    expect(await cache.get('a')).toBeNull();
    const files = await readdir(dir);
    expect(files).toContain('a.png');
  });
});

describe('OgRoutes.handleOgImage', () => {
  test('returns 200 PNG for a known moment, sets cache headers', async () => {
    const { store, record } = mkStore();
    const cache = new OgCache({ maxEntries: 10 });
    const routes = new OgRoutes({ store, cache });
    const res = mockRes();
    await routes.handleOgImage(mockReq(), res, record.id);
    expect(res.statusCode).toBe(200);
    expect(res.responseHeaders['content-type']).toBe('image/png');
    expect(res.responseHeaders['x-og-cache']).toBe('miss');
    expect(res.responseHeaders['cache-control']).toMatch(/immutable/);
    expect(res.body.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(res.body.readUInt32BE(16)).toBe(OG_WIDTH);
    expect(res.body.readUInt32BE(20)).toBe(OG_HEIGHT);
  });

  test('second hit returns cached PNG with x-og-cache: hit', async () => {
    const { store, record } = mkStore();
    const cache = new OgCache({ maxEntries: 10 });
    const routes = new OgRoutes({ store, cache });
    const res1 = mockRes();
    await routes.handleOgImage(mockReq(), res1, record.id);
    const res2 = mockRes();
    await routes.handleOgImage(mockReq(), res2, record.id);
    expect(res2.responseHeaders['x-og-cache']).toBe('hit');
    expect(res2.body.equals(res1.body)).toBe(true);
  });

  test('returns 404 for unknown id', async () => {
    const { store } = mkStore();
    const cache = new OgCache({ maxEntries: 10 });
    const routes = new OgRoutes({ store, cache });
    const res = mockRes();
    await routes.handleOgImage(mockReq(), res, 'no-such-mom');
    expect(res.statusCode).toBe(404);
  });

  test('returns 404 for invalid id pattern', async () => {
    const { store } = mkStore();
    const cache = new OgCache({ maxEntries: 10 });
    const routes = new OgRoutes({ store, cache });
    const res = mockRes();
    await routes.handleOgImage(mockReq(), res, '../etc/passwd');
    expect(res.statusCode).toBe(404);
  });

  test('rate-limits past per-IP window', async () => {
    const { store, record } = mkStore();
    const cache = new OgCache({ maxEntries: 10 });
    const routes = new OgRoutes({ store, cache, perIpPerMin: 2, globalPerMin: 100 });
    for (let i = 0; i < 2; i++) {
      const res = mockRes();
      await routes.handleOgImage(mockReq({ remoteAddress: '1.2.3.4' }), res, record.id);
      expect(res.statusCode).toBe(200);
    }
    const res = mockRes();
    await routes.handleOgImage(mockReq({ remoteAddress: '1.2.3.4' }), res, record.id);
    expect(res.statusCode).toBe(429);
    expect(res.responseHeaders['retry-after']).toBeDefined();
  });

  test('rate-limits past global window', async () => {
    const { store, record } = mkStore();
    const cache = new OgCache({ maxEntries: 10 });
    const routes = new OgRoutes({ store, cache, perIpPerMin: 1000, globalPerMin: 1 });
    const res1 = mockRes();
    await routes.handleOgImage(mockReq({ remoteAddress: '1.1.1.1' }), res1, record.id);
    expect(res1.statusCode).toBe(200);
    const res2 = mockRes();
    await routes.handleOgImage(mockReq({ remoteAddress: '2.2.2.2' }), res2, record.id);
    expect(res2.statusCode).toBe(429);
  });

  test('calls onRender(id, ip) on a successful 200', async () => {
    const { store, record } = mkStore();
    const cache = new OgCache({ maxEntries: 10 });
    const calls: Array<[string, string]> = [];
    const routes = new OgRoutes({
      store,
      cache,
      onRender: (id, ip) => calls.push([id, ip]),
    });
    const res = mockRes();
    await routes.handleOgImage(mockReq({ remoteAddress: '5.5.5.5' }), res, record.id);
    expect(calls).toEqual([[record.id, '5.5.5.5']]);
  });

  test('does not call onRender on 404 or 429', async () => {
    const { store, record } = mkStore();
    const cache = new OgCache({ maxEntries: 10 });
    const calls: Array<[string, string]> = [];
    const routes = new OgRoutes({
      store,
      cache,
      perIpPerMin: 2,
      globalPerMin: 100,
      onRender: (id, ip) => calls.push([id, ip]),
    });
    // 404 (unknown id) — still consumes a rate-limit slot but must not call onRender.
    const res404 = mockRes();
    await routes.handleOgImage(mockReq({ remoteAddress: '9.9.9.9' }), res404, 'unknown');
    expect(res404.statusCode).toBe(404);
    // 200 — counted
    const res200 = mockRes();
    await routes.handleOgImage(mockReq({ remoteAddress: '9.9.9.9' }), res200, record.id);
    expect(res200.statusCode).toBe(200);
    // 429 — third request blocked
    const res429 = mockRes();
    await routes.handleOgImage(mockReq({ remoteAddress: '9.9.9.9' }), res429, record.id);
    expect(res429.statusCode).toBe(429);
    expect(calls).toEqual([[record.id, '9.9.9.9']]);
  });

  test('different moments produce different cache entries', async () => {
    const { store, record, second } = mkStore();
    const cache = new OgCache({ maxEntries: 10 });
    const routes = new OgRoutes({ store, cache });
    const res1 = mockRes();
    const res2 = mockRes();
    await routes.handleOgImage(mockReq(), res1, record.id);
    await routes.handleOgImage(mockReq(), res2, second.id);
    expect(res1.body.equals(res2.body)).toBe(false);
    expect(routes.cacheSize()).toBe(2);
  });

  test('uses x-forwarded-for for client IP rate limiting', async () => {
    const { store, record } = mkStore();
    const cache = new OgCache({ maxEntries: 10 });
    const routes = new OgRoutes({ store, cache, perIpPerMin: 1, globalPerMin: 100 });
    const r1 = mockRes();
    await routes.handleOgImage(
      mockReq({ headers: { 'x-forwarded-for': '4.4.4.4, 1.1.1.1' } }),
      r1,
      record.id,
    );
    const r2 = mockRes();
    await routes.handleOgImage(
      mockReq({ headers: { 'x-forwarded-for': '4.4.4.4, 1.1.1.1' } }),
      r2,
      record.id,
    );
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(429);
  });

  test('cache LRU evicts under sustained traffic — no unbounded growth', async () => {
    const { store } = mkStore();
    const cache = new OgCache({ maxEntries: 3 });
    const routes = new OgRoutes({ store, cache });
    // Mint 10 distinct moments, render OG for each; cache should stay at 3.
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const rec = store.captureClose(
        {
          sessionId: `sess-${i}`,
          simTime: 16 * 3600 + i * 60,
          openedAt: 16 * 3600 + i * 60,
          transcript: [{ speakerId: 'a', text: 'x', at: 16 * 3600 + i * 60 }],
          participants: [
            { id: 'a', name: 'A', named: true, color: '#ffaaaa' },
            { id: 'b', name: 'B', named: true, color: '#aaffff' },
          ],
          zone: 'z',
          closeReason: 'idle',
        },
        deriveWorldClock(16 * 3600 + i * 60, 30),
      );
      ids.push(rec.id);
      const res = mockRes();
      await routes.handleOgImage(mockReq(), res, rec.id);
      expect(res.statusCode).toBe(200);
    }
    expect(routes.cacheSize()).toBe(3);
  });
});

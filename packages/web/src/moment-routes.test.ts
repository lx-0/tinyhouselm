import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { type MomentRecord, deriveWorldClock } from '@tina/shared';
import { RelationshipStore } from '@tina/sim';
import { describe, expect, test } from 'vitest';
import { MomentRoutes } from './moment-routes.js';
import { MomentStore } from './moments.js';

function mockReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  remoteAddress?: string;
}): IncomingMessage {
  const stream = Readable.from(
    opts.body ? [Buffer.from(opts.body)] : [],
  ) as unknown as IncomingMessage;
  stream.method = opts.method ?? 'POST';
  stream.url = opts.url ?? '/';
  stream.headers = opts.headers ?? {};
  (stream as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
  };
  return stream;
}

type MockRes = ServerResponse & {
  statusCode: number;
  body: string;
  responseHeaders: Record<string, string | string[]>;
};

function mockRes(): MockRes {
  const state = {
    statusCode: 0,
    body: '',
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
    end(body?: string) {
      state.body = body ?? '';
    },
  } as unknown as MockRes;
  return res;
}

function mkStore(): { store: MomentStore; record: MomentRecord } {
  const store = new MomentStore({
    maxMoments: 10,
    idGenerator: (() => {
      let n = 0;
      return () => `mom${++n}`;
    })(),
  });
  const record = store.captureClose(
    {
      sessionId: 's1',
      simTime: 15 * 3600 + 14 * 60,
      openedAt: 15 * 3600,
      transcript: [
        { speakerId: 'mei', text: 'hi there', at: 15 * 3600 },
        { speakerId: 'hiro', text: 'hey', at: 15 * 3600 + 2 },
      ],
      participants: [
        { id: 'mei', name: 'Mei', named: true, color: '#ffaaaa' },
        { id: 'hiro', name: 'Hiro', named: true, color: '#aaffff' },
      ],
      zone: 'cafe',
      closeReason: 'idle',
    },
    deriveWorldClock(15 * 3600 + 14 * 60, 30),
  );
  return { store, record };
}

function alwaysOk() {
  return { ok: true } as const;
}

describe('MomentRoutes.handleMomentJson', () => {
  test('returns 200 + JSON for a known id', () => {
    const { store, record } = mkStore();
    const routes = new MomentRoutes({ store, checkAdmin: alwaysOk });
    const res = mockRes();
    routes.handleMomentJson(res, record.id);
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.id).toBe(record.id);
    expect(parsed.headline).toBe(record.headline);
    expect(parsed.transcript).toHaveLength(2);
  });

  test('returns 404 for unknown id', () => {
    const { store } = mkStore();
    const routes = new MomentRoutes({ store, checkAdmin: alwaysOk });
    const res = mockRes();
    routes.handleMomentJson(res, 'does-not-exist');
    expect(res.statusCode).toBe(404);
  });

  test('returns 404 for invalid id patterns', () => {
    const { store } = mkStore();
    const routes = new MomentRoutes({ store, checkAdmin: alwaysOk });
    const res = mockRes();
    routes.handleMomentJson(res, '../etc/passwd');
    expect(res.statusCode).toBe(404);
  });
});

describe('MomentRoutes.handleMomentPage', () => {
  test('renders HTML with OG tags on 200', () => {
    const { store, record } = mkStore();
    const routes = new MomentRoutes({
      store,
      publicBaseUrl: 'https://tinyhouse.up.railway.app',
      checkAdmin: alwaysOk,
    });
    const res = mockRes();
    routes.handleMomentPage(res, record.id);
    expect(res.statusCode).toBe(200);
    expect(res.responseHeaders['content-type']).toContain('text/html');
    expect(res.body).toContain('og:type');
    expect(res.body).toContain('og:title');
    expect(res.body).toContain('og:description');
    expect(res.body).toContain(
      `og:url" content="https://tinyhouse.up.railway.app/moment/${record.id}`,
    );
    expect(res.body).toContain(record.headline);
    expect(res.body).toContain('hi there');
    expect(res.body).toContain('Mei');
  });

  test('emits og:image + twitter:card=summary_large_image meta (TINA-616)', () => {
    const { store, record } = mkStore();
    const routes = new MomentRoutes({
      store,
      publicBaseUrl: 'https://tinyhouse.up.railway.app',
      checkAdmin: alwaysOk,
    });
    const res = mockRes();
    routes.handleMomentPage(res, record.id);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(
      `og:image" content="https://tinyhouse.up.railway.app/moment/${record.id}/og.png"`,
    );
    expect(res.body).toContain('og:image:width" content="1200"');
    expect(res.body).toContain('og:image:height" content="630"');
    expect(res.body).toContain('og:image:type" content="image/png"');
    expect(res.body).toContain('twitter:card" content="summary_large_image"');
    expect(res.body).toContain(
      `twitter:image" content="https://tinyhouse.up.railway.app/moment/${record.id}/og.png"`,
    );
  });

  test('escapes user-controlled text to prevent XSS', () => {
    const store = new MomentStore({
      maxMoments: 10,
      idGenerator: () => 'xss1',
    });
    store.captureClose(
      {
        sessionId: 'xss-s',
        simTime: 1000,
        openedAt: 900,
        transcript: [{ speakerId: 'a', text: '<script>alert(1)</script>', at: 900 }],
        participants: [
          { id: 'a', name: '<b>Hacker</b>', named: false, color: null },
          { id: 'b', name: 'Normal', named: false, color: null },
        ],
        zone: 'cafe',
        closeReason: 'idle',
      },
      deriveWorldClock(1000, 30),
    );
    const routes = new MomentRoutes({ store, checkAdmin: alwaysOk });
    const res = mockRes();
    routes.handleMomentPage(res, 'xss1');
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
    expect(res.body).toContain('&lt;b&gt;Hacker&lt;/b&gt;');
  });

  test('returns 404 HTML when id is unknown', () => {
    const { store } = mkStore();
    const routes = new MomentRoutes({ store, checkAdmin: alwaysOk });
    const res = mockRes();
    routes.handleMomentPage(res, 'missing');
    expect(res.statusCode).toBe(404);
    expect(res.responseHeaders['content-type']).toContain('text/html');
    expect(res.body).toContain('moment not found');
  });
});

describe('MomentRoutes.handleShare', () => {
  test('returns id + public URL for a known sessionId', async () => {
    const { store, record } = mkStore();
    const routes = new MomentRoutes({
      store,
      publicBaseUrl: 'https://tinyhouse.up.railway.app',
      checkAdmin: alwaysOk,
    });
    const res = mockRes();
    await routes.handleShare(
      mockReq({ method: 'POST', body: JSON.stringify({ sessionId: 's1' }) }),
      res,
    );
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.id).toBe(record.id);
    expect(parsed.url).toBe(`https://tinyhouse.up.railway.app/moment/${record.id}`);
  });

  test('returns 404 when sessionId has no moment', async () => {
    const { store } = mkStore();
    const routes = new MomentRoutes({ store, checkAdmin: alwaysOk });
    const res = mockRes();
    await routes.handleShare(
      mockReq({ method: 'POST', body: JSON.stringify({ sessionId: 'unknown' }) }),
      res,
    );
    expect(res.statusCode).toBe(404);
  });

  test('returns 400 on missing sessionId', async () => {
    const { store } = mkStore();
    const routes = new MomentRoutes({ store, checkAdmin: alwaysOk });
    const res = mockRes();
    await routes.handleShare(mockReq({ method: 'POST', body: JSON.stringify({}) }), res);
    expect(res.statusCode).toBe(400);
  });

  test('respects admin gate', async () => {
    const { store } = mkStore();
    const routes = new MomentRoutes({
      store,
      checkAdmin: () => ({ ok: false, status: 401, error: 'admin token required' }) as const,
    });
    const res = mockRes();
    await routes.handleShare(
      mockReq({ method: 'POST', body: JSON.stringify({ sessionId: 's1' }) }),
      res,
    );
    expect(res.statusCode).toBe(401);
  });

  test('surfaces the current arc label on the share page for named pairs (TINA-207)', () => {
    const { store, record } = mkStore();
    const relationships = new RelationshipStore();
    // Force a warming window: three closes with good turn count.
    relationships.recordClose({
      a: 'mei',
      b: 'hiro',
      simTime: 100,
      turnCount: 6,
    });
    relationships.recordClose({
      a: 'mei',
      b: 'hiro',
      simTime: 200,
      turnCount: 6,
    });
    relationships.rolloverDay(8 * 86400);
    const routes = new MomentRoutes({ store, checkAdmin: alwaysOk, relationships });
    const res = mockRes();
    routes.handleMomentPage(res, record.id);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('class="arc"');
    expect(res.body).toContain('data-arc="warming"');
    expect(res.body).toContain('Mei &amp; Hiro — warming');
  });

  test('omits arc label when no relationships store is configured', () => {
    const { store, record } = mkStore();
    const routes = new MomentRoutes({ store, checkAdmin: alwaysOk });
    const res = mockRes();
    routes.handleMomentPage(res, record.id);
    expect(res.body).not.toContain('class="arc"');
  });

  test('omits arc label when pair has no recorded history yet', () => {
    const { store, record } = mkStore();
    const relationships = new RelationshipStore();
    const routes = new MomentRoutes({ store, checkAdmin: alwaysOk, relationships });
    const res = mockRes();
    routes.handleMomentPage(res, record.id);
    expect(res.body).not.toContain('class="arc"');
  });

  test('omits arc label when either participant is procedural', () => {
    const store = new MomentStore({ maxMoments: 10, idGenerator: () => 'mix1' });
    store.captureClose(
      {
        sessionId: 'mix-s',
        simTime: 1000,
        openedAt: 900,
        transcript: [{ speakerId: 'mei', text: 'hi', at: 900 }],
        participants: [
          { id: 'mei', name: 'Mei', named: true, color: '#ffaaaa' },
          { id: 'stranger', name: 'Stranger', named: false, color: null },
        ],
        zone: 'cafe',
        closeReason: 'idle',
      },
      deriveWorldClock(1000, 30),
    );
    const relationships = new RelationshipStore();
    relationships.recordClose({ a: 'mei', b: 'stranger', simTime: 10, turnCount: 4 });
    const routes = new MomentRoutes({ store, checkAdmin: alwaysOk, relationships });
    const res = mockRes();
    routes.handleMomentPage(res, 'mix1');
    expect(res.body).not.toContain('class="arc"');
  });

  test('renders the viewer-nudged pill when isSessionNudged returns a direction (TINA-275)', () => {
    const { store, record } = mkStore();
    const routes = new MomentRoutes({
      store,
      checkAdmin: alwaysOk,
      isSessionNudged: (sid) => (sid === record.sessionId ? 'spark' : null),
    });
    const res = mockRes();
    routes.handleMomentPage(res, record.id);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('class="nudge"');
    expect(res.body).toContain('data-nudge="spark"');
    expect(res.body).toContain('viewer-nudged');
  });

  test('omits the nudge pill when the session was never nudged', () => {
    const { store, record } = mkStore();
    const routes = new MomentRoutes({
      store,
      checkAdmin: alwaysOk,
      isSessionNudged: () => null,
    });
    const res = mockRes();
    routes.handleMomentPage(res, record.id);
    expect(res.body).not.toContain('class="nudge"');
  });

  test('omits the nudge pill when either participant is procedural', () => {
    const store = new MomentStore({ maxMoments: 10, idGenerator: () => 'mix-n' });
    store.captureClose(
      {
        sessionId: 'mix-ns',
        simTime: 1000,
        openedAt: 900,
        transcript: [{ speakerId: 'mei', text: 'hi', at: 900 }],
        participants: [
          { id: 'mei', name: 'Mei', named: true, color: '#ffaaaa' },
          { id: 'stranger', name: 'Stranger', named: false, color: null },
        ],
        zone: 'cafe',
        closeReason: 'idle',
      },
      deriveWorldClock(1000, 30),
    );
    const routes = new MomentRoutes({
      store,
      checkAdmin: alwaysOk,
      isSessionNudged: () => 'spark',
    });
    const res = mockRes();
    routes.handleMomentPage(res, 'mix-n');
    expect(res.body).not.toContain('class="nudge"');
  });

  test('renders group-variant moment with group badge + no transcript (TINA-345)', () => {
    const store = new MomentStore({ maxMoments: 10, idGenerator: () => 'grp1' });
    store.captureGroup(
      {
        sessionId: 'grp-sess',
        simTime: 15 * 3600,
        participants: [
          { id: 'mei', name: 'Mei', named: true, color: '#ffaaaa' },
          { id: 'hiro', name: 'Hiro', named: true, color: '#aaffff' },
          { id: 'ava', name: 'Ava', named: true, color: '#ffee88' },
        ],
        zone: 'Town Square',
      },
      deriveWorldClock(15 * 3600, 30),
    );
    const routes = new MomentRoutes({ store, checkAdmin: alwaysOk });
    const res = mockRes();
    routes.handleMomentPage(res, 'grp1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Mei, Hiro, and Ava met at Town Square');
    expect(res.body).toContain('class="group-badge"');
    expect(res.body).toContain('group moment · 3 named');
    expect(res.body).toContain('co-presence record');
    expect(res.body).not.toContain('class="transcript"');
  });

  test('surfaces pairwise arc labels on a group moment when all pairs are named', () => {
    const store = new MomentStore({ maxMoments: 10, idGenerator: () => 'grp2' });
    store.captureGroup(
      {
        sessionId: 'grp-arcs',
        simTime: 15 * 3600,
        participants: [
          { id: 'mei', name: 'Mei', named: true, color: null },
          { id: 'hiro', name: 'Hiro', named: true, color: null },
          { id: 'ava', name: 'Ava', named: true, color: null },
        ],
        zone: 'cafe',
      },
      deriveWorldClock(15 * 3600, 30),
    );
    const relationships = new RelationshipStore();
    // Give each pair enough closes to land on a non-new arc so we can assert
    // the label shows up in the render.
    for (const [a, b] of [
      ['mei', 'hiro'],
      ['mei', 'ava'],
      ['hiro', 'ava'],
    ] as const) {
      relationships.recordClose({ a, b, simTime: 10, turnCount: 6 });
      relationships.recordClose({ a, b, simTime: 60, turnCount: 6 });
    }
    const routes = new MomentRoutes({ store, checkAdmin: alwaysOk, relationships });
    const res = mockRes();
    routes.handleMomentPage(res, 'grp2');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('class="group-arcs"');
    // Expect all three pairs to have a labelled chip inside the group-arcs strip.
    expect(res.body).toContain('Mei &amp; Hiro');
    expect(res.body).toContain('Mei &amp; Ava');
    expect(res.body).toContain('Hiro &amp; Ava');
  });

  test('rate-limits per-IP and returns 429', async () => {
    const { store } = mkStore();
    const nowMs = 1_000_000;
    const routes = new MomentRoutes({
      store,
      checkAdmin: alwaysOk,
      perIpSharePerMin: 2,
      globalSharePerMin: 100,
      now: () => nowMs,
    });
    const body = JSON.stringify({ sessionId: 's1' });
    for (let i = 0; i < 2; i++) {
      const res = mockRes();
      await routes.handleShare(mockReq({ method: 'POST', body }), res);
      expect(res.statusCode).toBe(200);
    }
    const limited = mockRes();
    await routes.handleShare(mockReq({ method: 'POST', body }), limited);
    expect(limited.statusCode).toBe(429);
    expect(limited.responseHeaders['retry-after']).toBeDefined();
  });
});

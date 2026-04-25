import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { MomentRecord } from '@tina/shared';
import type { ArcLabel, RelationshipStore } from '@tina/sim';
import type { MomentStore } from './moments.js';
import { composeMomentOg } from './og-image.js';

/**
 * `/moment/:id/og.png` rendering + caching (TINA-616).
 *
 * - Pure-Node renderer (see `og-image.ts`) — no headless browser.
 * - Disk-backed LRU cache, default 500 entries. In-memory map tracks order;
 *   PNG bytes live on disk so the resident set stays small. On eviction the
 *   file is unlinked so `MOMENT_OG_CACHE_DIR` doesn't grow unbounded.
 * - Per-IP + global rate limiter, mirrors `/moment/:id`.
 * - Calls `onRender(visitorId, momentId)` after a successful 200 so the
 *   server can bump the `momentOgRenders` sticky-metrics counter with
 *   per-(visitor, moment) per-day dedup (TINA-145 instrumentation shape).
 */

export type OgLogger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
) => void;

const noopLog: OgLogger = () => {};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const WINDOW_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_PER_IP_PER_MIN = 60;
const DEFAULT_GLOBAL_PER_MIN = 600;

export interface OgCacheOptions {
  /** Optional dir for on-disk PNGs. Undefined = pure in-memory cache. */
  dir?: string;
  maxEntries?: number;
  log?: OgLogger;
  /** Swap fs operations for tests. */
  reader?: (path: string) => Promise<Buffer | null>;
  writer?: (path: string, body: Buffer) => Promise<void>;
  unlinker?: (path: string) => Promise<void>;
}

async function defaultReader(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function defaultWriter(path: string, body: Buffer): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf('/')) || '.';
  await mkdir(dir, { recursive: true });
  await writeFile(path, body);
}

async function defaultUnlinker(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * Disk-backed LRU. Order is tracked by a `Map` whose keys we re-insert on
 * hit (Maps preserve insertion order, oldest-first). On eviction the disk
 * file is removed asynchronously — failures are logged but never thrown.
 */
export class OgCache {
  private readonly dir: string | undefined;
  private readonly max: number;
  private readonly log: OgLogger;
  private readonly reader: (path: string) => Promise<Buffer | null>;
  private readonly writer: (path: string, body: Buffer) => Promise<void>;
  private readonly unlinker: (path: string) => Promise<void>;
  /** Insertion-order tracker. Value is the in-memory PNG buffer if dir is unset. */
  private readonly order = new Map<string, Buffer | null>();

  constructor(opts: OgCacheOptions = {}) {
    this.dir = opts.dir;
    this.max = Math.max(1, Math.floor(opts.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.log = opts.log ?? noopLog;
    this.reader = opts.reader ?? defaultReader;
    this.writer = opts.writer ?? defaultWriter;
    this.unlinker = opts.unlinker ?? defaultUnlinker;
  }

  size(): number {
    return this.order.size;
  }

  /** Read a PNG from cache. Returns null on miss. Promotes to MRU on hit. */
  async get(id: string): Promise<Buffer | null> {
    if (!ID_PATTERN.test(id)) return null;
    const cached = this.order.get(id);
    if (cached === undefined) return null;
    // Promote to MRU.
    this.order.delete(id);
    this.order.set(id, cached);
    if (cached !== null) return cached;
    if (!this.dir) return null;
    try {
      return await this.reader(this.pathFor(id));
    } catch (err) {
      this.log('warn', 'og.cache.read.error', {
        id,
        message: err instanceof Error ? err.message : String(err),
      });
      // Stale entry — drop it so a future request re-renders cleanly.
      this.order.delete(id);
      return null;
    }
  }

  /** Write a PNG to cache. Evicts the oldest entry if past `max`. */
  async set(id: string, png: Buffer): Promise<void> {
    if (!ID_PATTERN.test(id)) return;
    // If we already had it, drop the old slot so the size check is exact.
    if (this.order.has(id)) this.order.delete(id);
    if (this.dir) {
      try {
        await this.writer(this.pathFor(id), png);
      } catch (err) {
        this.log('warn', 'og.cache.write.error', {
          id,
          message: err instanceof Error ? err.message : String(err),
        });
        // Fall through — we still want to serve this request, just don't pollute cache.
        return;
      }
      this.order.set(id, null);
    } else {
      this.order.set(id, png);
    }
    while (this.order.size > this.max) {
      const oldest = this.order.keys().next();
      if (oldest.done) break;
      const evictId = oldest.value;
      this.order.delete(evictId);
      if (this.dir) {
        // Fire-and-forget — we never block a request on cleanup.
        this.unlinker(this.pathFor(evictId)).catch((err) => {
          this.log('warn', 'og.cache.unlink.error', {
            id: evictId,
            message: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }

  /** Drop everything from memory. Disk files are left alone. */
  reset(): void {
    this.order.clear();
  }

  private pathFor(id: string): string {
    if (!this.dir) throw new Error('og cache: pathFor called with no dir');
    return join(this.dir, `${id}.png`);
  }
}

interface Bucket {
  count: number;
  windowStart: number;
}

const formatArcHeadline = (label: ArcLabel, p1: string, p2: string): string =>
  `${p1} & ${p2} — ${label}`;

export interface OgRouteOptions {
  store: MomentStore;
  cache: OgCache;
  /** Optional relationship store — surfaces an arc chip on named×named cards. */
  relationships?: RelationshipStore | null;
  perIpPerMin?: number;
  globalPerMin?: number;
  /**
   * Hook called after a successful 200 response. Server uses this to bump
   * the `momentOgRenders` sticky-metrics counter with per-(visitor, moment)
   * dedup (mirrors `recordCharacterProfileView`).
   */
  onRender?: (id: string, ip: string) => void;
  log?: OgLogger;
  now?: () => number;
}

export class OgRoutes {
  private readonly store: MomentStore;
  private readonly cache: OgCache;
  private readonly relationships: RelationshipStore | null;
  private readonly perIpRate: number;
  private readonly globalRate: number;
  private readonly onRender: ((id: string, ip: string) => void) | undefined;
  private readonly log: OgLogger;
  private readonly now: () => number;
  private readonly perIp = new Map<string, Bucket>();
  private readonly globalBucket: Bucket = { count: 0, windowStart: 0 };

  constructor(opts: OgRouteOptions) {
    this.store = opts.store;
    this.cache = opts.cache;
    this.relationships = opts.relationships ?? null;
    this.perIpRate = opts.perIpPerMin ?? DEFAULT_PER_IP_PER_MIN;
    this.globalRate = opts.globalPerMin ?? DEFAULT_GLOBAL_PER_MIN;
    this.onRender = opts.onRender;
    this.log = opts.log ?? noopLog;
    this.now = opts.now ?? (() => Date.now());
  }

  cacheSize(): number {
    return this.cache.size();
  }

  /**
   * GET /moment/:id/og.png. Public. 200 PNG on hit, 404 on unknown id, 429
   * on rate-limit. Cache-Control is set to `public, max-age=86400, immutable`
   * — the moment record is stable once captured, so social-media crawlers
   * can hold the bytes for the whole share window.
   */
  async handleOgImage(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    if (!ID_PATTERN.test(id)) {
      writePlain(res, 404, 'not found');
      return;
    }
    const ip = clientIp(req);
    const rate = this.checkRate(ip);
    if (!rate.ok) {
      res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
      writePlain(res, 429, 'rate limited');
      return;
    }
    const rec = this.store.get(id);
    if (!rec) {
      writePlain(res, 404, 'not found');
      return;
    }
    let png: Buffer;
    let cacheHit = false;
    const t0 = this.now();
    const cached = await this.cache.get(id);
    if (cached) {
      png = cached;
      cacheHit = true;
    } else {
      png = composeMomentOg(rec, this.optionsFor(rec));
      // Write to cache fire-and-forget — never block the response on it.
      void this.cache.set(id, png).catch((err) => {
        this.log('warn', 'og.cache.set.error', {
          id,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(png.length),
      'cache-control': 'public, max-age=86400, immutable',
      'x-og-cache': cacheHit ? 'hit' : 'miss',
    });
    res.end(png);
    this.log('info', 'og.render', {
      id,
      cacheHit,
      bytes: png.length,
      ms: this.now() - t0,
    });
    this.onRender?.(id, ip);
  }

  private optionsFor(rec: MomentRecord): { arcLabel?: string; arcHeadline?: string } {
    if (!this.relationships) return {};
    if (rec.participants.length !== 2) return {};
    const [p1, p2] = rec.participants;
    if (!p1 || !p2 || !p1.named || !p2.named) return {};
    const state = this.relationships.getPair(p1.id, p2.id);
    if (!state) return {};
    return {
      arcLabel: state.arcLabel,
      arcHeadline: formatArcHeadline(state.arcLabel, p1.name, p2.name),
    };
  }

  private checkRate(ip: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const g = this.globalBucket;
    if (now - g.windowStart >= WINDOW_MS) {
      g.windowStart = now;
      g.count = 0;
    }
    if (g.count >= this.globalRate) {
      return { ok: false, retryAfterMs: WINDOW_MS - (now - g.windowStart) };
    }
    let bucket = this.perIp.get(ip);
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
      bucket = { count: 0, windowStart: now };
      this.perIp.set(ip, bucket);
    }
    if (bucket.count >= this.perIpRate) {
      return { ok: false, retryAfterMs: WINDOW_MS - (now - bucket.windowStart) };
    }
    bucket.count += 1;
    g.count += 1;
    return { ok: true };
  }
}

function writePlain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (first) return first.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? '';
}

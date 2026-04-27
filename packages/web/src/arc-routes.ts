import type { IncomingMessage, ServerResponse } from 'node:http';
import { type MomentRecord, deriveWorldClock } from '@tina/shared';
import {
  type ArcLabel,
  type NamedPersona,
  type RelationshipStore,
  computeAffinityDelta,
  simDay,
} from '@tina/sim';
import type { MomentStore } from './moments.js';
import { composeArcOg } from './og-image.js';
import type { OgCache } from './og-routes.js';

/**
 * Per-pair arc page (TINA-813).
 *
 * Reads from the live MomentRecord LRU + RelationshipStore — no new
 * persistence, no LLM, no sim hot-path. Mirrors the routing/limit/sticky
 * shape of `/character/:name` (TINA-482) and `/zone/:name` (TINA-744).
 *
 * Routing:
 *   - `/arc/:nameA-nameB` resolves both halves as named-character first
 *     names (case-insensitive), then sorts the resulting personas by id
 *     ascending and 302-redirects to the canonical slug if the input was
 *     non-canonical.
 *   - 404 if either name doesn't resolve, both names refer to the same
 *     persona, or the safety pattern fails.
 *
 * The "arc history strip" is a 7-step deterministic sparkline computed on
 * the fly from the MomentRecord ring (sum of `computeAffinityDelta` per
 * sim-day). Per-pair "nudges applied" is a session-scoped count derived
 * from the runtime's `isSessionNudged` callback (same source the moment
 * page uses for the nudge pill).
 */

export type ArcLogger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
) => void;

const noopLog: ArcLogger = () => {};

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const WINDOW_MS = 60_000;
const DEFAULT_PER_IP_PER_MIN = 60;
const DEFAULT_GLOBAL_PER_MIN = 600;

const ARC_GLYPHS: Record<ArcLabel, string> = {
  new: '🌀',
  warming: '🌱',
  cooling: '🥶',
  estranged: '🔕',
  steady: '💤',
};

/** How many sim-days the affinity sparkline covers. */
const SPARKLINE_DAYS = 7;

interface Bucket {
  count: number;
  windowStart: number;
}

export interface ArcRouteOptions {
  /** Authored named-persona roster — drives /arc/:slug resolution. */
  named: NamedPersona[];
  /** Read-side moment LRU. */
  moments: MomentStore;
  /** Disk-backed OG cache (separate dir from /moment, /digest, /zone). */
  cache: OgCache;
  /** Required relationships store — without it the page has no arc to surface. */
  relationships: RelationshipStore;
  /**
   * Optional render-time hook to surface per-moment nudge pills (same source
   * the moment page uses). When present, a count of recent moments where the
   * runtime actually applied a viewer nudge is shown alongside the affinity.
   */
  isSessionNudged?: ((sessionId: string) => unknown | null) | null;
  /** Sim speed (seconds-per-real-second) for clock derivation. */
  simSpeed: number;
  /** Snapshot of the current sim time, used for the 7-day sparkline window. */
  currentSimTime: () => number;
  /** Public base URL for canonical/og:url. Falls back to relative paths. */
  publicBaseUrl?: string | null;
  /** Per-IP page hits per minute. Default 60 — mirrors `/zone/:name`. */
  perIpPerMin?: number;
  /** Global ceiling per minute. Default 600. */
  globalPerMin?: number;
  /** How many recent moments to render at most. Default 30 (per spec). */
  maxMoments?: number;
  /** Bumped after a 200 OG render — drives `arcOgRenders` sticky metric. */
  onOgRender?: (canonicalSlug: string, ip: string) => void;
  log?: ArcLogger;
  now?: () => number;
}

export interface ArcPageOutcome {
  status: number;
  /** Canonical pair slug like `hiro-mei`, only set on a 200 hit. */
  canonicalSlug: string | null;
  rateLimited: boolean;
  /** True when the inbound URL was non-canonical and we issued a 302. */
  redirected: boolean;
}

interface ResolvedPair {
  /** Personas in canonical id-sorted order (a.id < b.id). */
  a: NamedPersona;
  b: NamedPersona;
  /** Canonical slug — first names of the id-sorted pair, joined with `-`. */
  canonicalSlug: string;
}

/**
 * Build the lookup table that maps a single first-name slug to its named
 * persona. Manifest id wins on collision so `/arc/<id>-<id>` works even when
 * two characters share a first name (none today, but future-proof).
 */
function buildFirstNameResolver(named: NamedPersona[]): Map<string, NamedPersona> {
  const byKey = new Map<string, NamedPersona>();
  for (const persona of named) {
    const idKey = persona.manifest.id.toLowerCase();
    if (!byKey.has(idKey)) byKey.set(idKey, persona);
    const first = persona.manifest.name.split(/\s+/, 1)[0]?.toLowerCase();
    if (first && !byKey.has(first)) byKey.set(first, persona);
  }
  return byKey;
}

function firstNameSlug(p: NamedPersona): string {
  return (p.manifest.name.split(/\s+/, 1)[0] ?? p.manifest.id).toLowerCase();
}

/**
 * Try every cut point of the input slug to resolve it as `<first>-<first>`.
 * Returns null when no split yields two distinct named personas. Earliest
 * winning split is preferred so canonical short names beat longer fallbacks.
 */
export function resolveArcSlug(
  raw: string,
  resolver: Map<string, NamedPersona>,
): ResolvedPair | null {
  const lower = raw.toLowerCase();
  const parts = lower.split('-');
  if (parts.length < 2) return null;
  for (let i = 1; i < parts.length; i++) {
    const left = parts.slice(0, i).join('-');
    const right = parts.slice(i).join('-');
    if (!left || !right) continue;
    const a = resolver.get(left);
    const b = resolver.get(right);
    if (!a || !b) continue;
    if (a.manifest.id === b.manifest.id) continue;
    // Sort by id ascending — canonical order.
    const [first, second] = a.manifest.id < b.manifest.id ? ([a, b] as const) : ([b, a] as const);
    return {
      a: first,
      b: second,
      canonicalSlug: `${firstNameSlug(first)}-${firstNameSlug(second)}`,
    };
  }
  return null;
}

interface SparklineStep {
  /** 0-indexed sim-day this bucket represents. */
  day: number;
  /** Sum of affinity deltas over this day. Range loosely [-1, +1]. */
  delta: number;
  /** How many moments in this pair landed this day. */
  momentsCount: number;
}

interface ArcPagePayload {
  pair: ResolvedPair;
  arcLabel: ArcLabel;
  affinity: number;
  sharedConversationCount: number;
  lastInteractionSim: number;
  windowStartDay: number;
  moments: MomentRecord[];
  sparkline: SparklineStep[];
  totalMoments: number;
  nudgesApplied: number;
}

export class ArcRoutes {
  private readonly named: NamedPersona[];
  private readonly moments: MomentStore;
  private readonly cache: OgCache;
  private readonly relationships: RelationshipStore;
  private readonly isSessionNudged: ((sessionId: string) => unknown | null) | null;
  private readonly resolver: Map<string, NamedPersona>;
  private readonly simSpeed: number;
  private readonly currentSimTime: () => number;
  private readonly publicBaseUrl: string | null;
  private readonly perIpRate: number;
  private readonly globalRate: number;
  private readonly maxMoments: number;
  private readonly onOgRender?: (canonicalSlug: string, ip: string) => void;
  private readonly log: ArcLogger;
  private readonly now: () => number;
  private readonly perIp = new Map<string, Bucket>();
  private readonly globalBucket: Bucket = { count: 0, windowStart: 0 };

  constructor(opts: ArcRouteOptions) {
    this.named = opts.named;
    this.moments = opts.moments;
    this.cache = opts.cache;
    this.relationships = opts.relationships;
    this.isSessionNudged = opts.isSessionNudged ?? null;
    this.resolver = buildFirstNameResolver(opts.named);
    this.simSpeed = opts.simSpeed;
    this.currentSimTime = opts.currentSimTime;
    this.publicBaseUrl = (opts.publicBaseUrl ?? null)?.replace(/\/+$/, '') ?? null;
    this.perIpRate = opts.perIpPerMin ?? DEFAULT_PER_IP_PER_MIN;
    this.globalRate = opts.globalPerMin ?? DEFAULT_GLOBAL_PER_MIN;
    this.maxMoments = Math.max(1, opts.maxMoments ?? 30);
    this.onOgRender = opts.onOgRender;
    this.log = opts.log ?? noopLog;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * GET /arc/:slug. Public. Returns:
   *  - 200 + HTML on a known pair when the slug is canonical
   *  - 302 to the canonical slug when the input resolves but isn't canonical
   *  - 404 + HTML when either name doesn't resolve, the pair is the same
   *    persona, or the pair has no recorded interactions
   *  - 429 on rate-limit
   */
  handleArcPage(req: IncomingMessage, res: ServerResponse, rawSlug: string): ArcPageOutcome {
    const ip = clientIp(req);
    const rate = this.checkRate(ip);
    if (!rate.ok) {
      res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
      writeHtml(res, 429, simpleErrorPage('slow down', 'Too many arc lookups from this IP.'));
      return { status: 429, canonicalSlug: null, rateLimited: true, redirected: false };
    }
    const decoded = safeDecode(rawSlug);
    if (!decoded || !NAME_PATTERN.test(decoded)) {
      writeHtml(res, 404, notFoundPage(decoded ?? rawSlug, this.named));
      return { status: 404, canonicalSlug: null, rateLimited: false, redirected: false };
    }
    const pair = resolveArcSlug(decoded, this.resolver);
    if (!pair) {
      writeHtml(res, 404, notFoundPage(decoded, this.named));
      return { status: 404, canonicalSlug: null, rateLimited: false, redirected: false };
    }
    if (decoded.toLowerCase() !== pair.canonicalSlug) {
      // 302 → canonical. Mirrors how `/digest/today` routes to `/digest/sd-N`.
      res.writeHead(302, {
        location: `/arc/${pair.canonicalSlug}`,
        'cache-control': 'public, max-age=60',
      });
      res.end();
      return {
        status: 302,
        canonicalSlug: pair.canonicalSlug,
        rateLimited: false,
        redirected: true,
      };
    }
    const payload = this.collectArcData(pair);
    if (!payload) {
      writeHtml(res, 404, notFoundPairPage(pair, this.named));
      return { status: 404, canonicalSlug: null, rateLimited: false, redirected: false };
    }
    const html = this.renderArcHtml(payload);
    writeHtml(res, 200, html);
    return {
      status: 200,
      canonicalSlug: pair.canonicalSlug,
      rateLimited: false,
      redirected: false,
    };
  }

  /** GET /arc/:slug/og.png. Public. 200 PNG on hit, 404 unknown, 429 limited. */
  async handleArcOgImage(
    req: IncomingMessage,
    res: ServerResponse,
    rawSlug: string,
  ): Promise<void> {
    const ip = clientIp(req);
    const rate = this.checkRate(ip);
    if (!rate.ok) {
      res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
      writePlain(res, 429, 'rate limited');
      return;
    }
    const decoded = safeDecode(rawSlug);
    if (!decoded || !NAME_PATTERN.test(decoded)) {
      writePlain(res, 404, 'not found');
      return;
    }
    const pair = resolveArcSlug(decoded, this.resolver);
    if (!pair) {
      writePlain(res, 404, 'not found');
      return;
    }
    const payload = this.collectArcData(pair);
    if (!payload) {
      writePlain(res, 404, 'not found');
      return;
    }
    let png: Buffer;
    let cacheHit = false;
    const t0 = this.now();
    const cached = await this.cache.get(pair.canonicalSlug);
    if (cached) {
      png = cached;
      cacheHit = true;
    } else {
      png = composeArcOg({
        a: { name: payload.pair.a.manifest.name, color: payload.pair.a.manifest.glyph.color },
        b: { name: payload.pair.b.manifest.name, color: payload.pair.b.manifest.glyph.color },
        arcLabel: payload.arcLabel,
        affinity: payload.affinity,
        headline: payload.moments[0]?.headline ?? '',
      });
      // Fire-and-forget — never block the response on the cache write.
      void this.cache.set(pair.canonicalSlug, png).catch((err) => {
        this.log('warn', 'arc.og.cache.set.error', {
          slug: pair.canonicalSlug,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(png.length),
      // Arc OG can drift (new moments, rolled-over labels) but most fetches
      // are crawler-side so the one-minute browser cache mirrors /zone OG.
      'cache-control': 'public, max-age=60',
      'x-og-cache': cacheHit ? 'hit' : 'miss',
    });
    res.end(png);
    this.log('info', 'arc.og.render', {
      slug: pair.canonicalSlug,
      cacheHit,
      bytes: png.length,
      ms: this.now() - t0,
    });
    this.onOgRender?.(pair.canonicalSlug, ip);
  }

  private collectArcData(pair: ResolvedPair): ArcPagePayload | null {
    const aId = pair.a.manifest.id;
    const bId = pair.b.manifest.id;
    const state = this.relationships.getPair(aId, bId);
    // Walk the LRU once: collect matching moments + count nudges in one pass.
    const all = this.moments.list();
    const matching: MomentRecord[] = [];
    let totalMoments = 0;
    let nudgesApplied = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const rec = all[i]!;
      const ids = rec.participants.map((p) => p.id);
      if (!ids.includes(aId) || !ids.includes(bId)) continue;
      totalMoments += 1;
      if (this.isSessionNudged?.(rec.sessionId)) {
        nudgesApplied += 1;
      }
      if (matching.length < this.maxMoments) matching.push(rec);
    }
    if (!state && matching.length === 0) {
      // No recorded interaction at all — 404 per spec.
      return null;
    }
    const arcLabel: ArcLabel = state?.arcLabel ?? 'new';
    const affinity = state?.affinity ?? 0;
    const sharedConversationCount = state?.sharedConversationCount ?? matching.length;
    const lastInteractionSim = state?.lastInteractionSim ?? matching[0]?.simTime ?? 0;
    const windowStartDay = state?.windowStartDay ?? 0;
    const sparkline = this.buildSparkline(matching, totalMoments);
    return {
      pair,
      arcLabel,
      affinity,
      sharedConversationCount,
      lastInteractionSim,
      windowStartDay,
      moments: matching,
      sparkline,
      totalMoments,
      nudgesApplied,
    };
  }

  /**
   * Build a 7-step affinity sparkline keyed to the current sim-day. Each
   * step sums `computeAffinityDelta` over the moments recorded for this pair
   * that day. Uses the same delta function as the live RelationshipStore so
   * the sparkline stays directionally consistent with the headline label.
   */
  private buildSparkline(
    matchingNewestFirst: MomentRecord[],
    totalMoments: number,
  ): SparklineStep[] {
    const today = simDay(this.currentSimTime());
    // Group moments by sim-day, then sort within each day by simTime asc so
    // `sharedConversationCount` grows monotonically when computing deltas.
    const byDay = new Map<number, MomentRecord[]>();
    for (const rec of matchingNewestFirst) {
      const d = simDay(rec.simTime);
      let bucket = byDay.get(d);
      if (!bucket) {
        bucket = [];
        byDay.set(d, bucket);
      }
      bucket.push(rec);
    }
    for (const list of byDay.values()) {
      list.sort((x, y) => x.simTime - y.simTime);
    }
    // Compute the prior shared-count seen *before* the sparkline window so
    // the first day's `computeAffinityDelta` keeps using the same repeat-bonus
    // semantics as the live store. We approximate it by counting moments in
    // `matchingNewestFirst` whose simTime is older than the window start.
    const windowFirstDay = today - (SPARKLINE_DAYS - 1);
    let priorCount = 0;
    let priorLastSim: number | null = null;
    for (const rec of matchingNewestFirst) {
      if (simDay(rec.simTime) < windowFirstDay) {
        priorCount += 1;
        if (priorLastSim === null || rec.simTime > priorLastSim) priorLastSim = rec.simTime;
      }
    }
    // Total moments seen in the LRU may exceed `matchingNewestFirst` once
    // the maxMoments cap kicks in; if so, anchor the prior count to the
    // unbounded total minus what's inside the window.
    const inWindow = matchingNewestFirst.filter(
      (rec) => simDay(rec.simTime) >= windowFirstDay,
    ).length;
    const inferredPrior = Math.max(0, totalMoments - inWindow);
    if (inferredPrior > priorCount) priorCount = inferredPrior;

    const out: SparklineStep[] = [];
    let runningCount = priorCount;
    let runningLast: number | null = priorLastSim;
    for (let i = 0; i < SPARKLINE_DAYS; i++) {
      const day = windowFirstDay + i;
      const bucket = byDay.get(day) ?? [];
      let dayDelta = 0;
      for (const rec of bucket) {
        const delta = computeAffinityDelta({
          turnCount: rec.transcript.length,
          sharedConversationCount: runningCount,
          simTimeSinceLastInteraction: runningLast !== null ? rec.simTime - runningLast : null,
        });
        dayDelta += delta;
        runningCount += 1;
        runningLast = rec.simTime;
      }
      out.push({ day, delta: dayDelta, momentsCount: bucket.length });
    }
    return out;
  }

  private renderArcHtml(payload: ArcPagePayload): string {
    const canonicalUrl = this.buildCanonicalUrl(`/arc/${payload.pair.canonicalSlug}`);
    const ogImageUrl = this.buildCanonicalUrl(`/arc/${payload.pair.canonicalSlug}/og.png`);
    const description = buildArcDescription(payload);
    return renderArcHtmlBody({
      payload,
      canonical: canonicalUrl,
      ogImageUrl,
      ogDescription: description,
      simSpeed: this.simSpeed,
    });
  }

  private buildCanonicalUrl(path: string): string {
    if (this.publicBaseUrl) return `${this.publicBaseUrl}${path}`;
    return path;
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

function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (first) return first.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? '';
}

function writeHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=60',
  });
  res.end(body);
}

function writePlain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function formatAffinity(a: number): string {
  const clamped = Math.max(-1, Math.min(1, a));
  if (Math.abs(clamped) < 0.005) return '0.00';
  const sign = clamped > 0 ? '+' : '−';
  return `${sign}${Math.abs(clamped).toFixed(2)}`;
}

/**
 * Build the OG/page meta description. Empty pairs fall back to a quiet
 * "no moments yet" line so social-card crawlers always get something useful.
 */
export function buildArcDescription(payload: ArcPagePayload, max = 160): string {
  const a = payload.pair.a.manifest.name;
  const b = payload.pair.b.manifest.name;
  const parts: string[] = [
    `${a} & ${b} — ${payload.arcLabel} · affinity ${formatAffinity(payload.affinity)}`,
  ];
  if (payload.moments[0]) parts.push(payload.moments[0].headline);
  return truncate(parts.join(' · '), max);
}

interface RenderInput {
  payload: ArcPagePayload;
  canonical: string;
  ogImageUrl: string;
  ogDescription: string;
  simSpeed: number;
}

function renderArcHtmlBody(input: RenderInput): string {
  const { payload } = input;
  const a = payload.pair.a.manifest;
  const b = payload.pair.b.manifest;
  const arcLabel = payload.arcLabel;
  const arcGlyph = ARC_GLYPHS[arcLabel];
  const title = `${escapeHtml(a.name)} & ${escapeHtml(b.name)} — ${escapeHtml(arcLabel)} — Tinyhouse`;
  const description = escapeHtml(input.ogDescription);
  const canonical = escapeHtml(input.canonical);
  const ogImage = escapeHtml(input.ogImageUrl);
  const lastClock =
    payload.lastInteractionSim > 0
      ? deriveWorldClock(payload.lastInteractionSim, input.simSpeed)
      : null;
  const lastLine = lastClock
    ? `last seen day ${simDay(payload.lastInteractionSim)} · ${String(lastClock.hour).padStart(2, '0')}:${String(lastClock.minute).padStart(2, '0')}`
    : 'no joint moments yet';
  const sparklineHtml = renderSparkline(payload.sparkline);
  const momentsHtml = renderMomentsList(payload.moments, input.simSpeed);
  const headerHtml = renderArcHeader(a, b);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <meta name="description" content="${description}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:site_name" content="tinyhouse" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:type" content="image/png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${ogImage}" />
  <link rel="canonical" href="${canonical}" />
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; padding: 0; background: #0f0d15; color: #e7e5ee; font-family: -apple-system, system-ui, Segoe UI, sans-serif; }
    main { max-width: 760px; margin: 0 auto; padding: 32px 20px 80px; }
    a { color: #b9b0dc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    header.top { display: flex; justify-content: space-between; align-items: center; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: #8888aa; margin-bottom: 18px; }
    header.pair { display: flex; gap: 18px; align-items: center; margin: 8px 0 16px; }
    header.pair .glyph { width: 64px; height: 64px; border-radius: 50%; flex-shrink: 0; position: relative; }
    header.pair .glyph .star { position: absolute; top: -4px; right: -4px; color: #f5c97a; font-size: 14px; }
    header.pair .between { font-size: 22px; color: #f5c97a; line-height: 1; }
    header.pair .who { display: flex; flex-direction: column; }
    header.pair .who .name { font-size: 18px; font-weight: 600; line-height: 1.2; color: #e7e5ee; }
    header.pair .who .name a { color: inherit; }
    header.pair .who .sub { font-size: 11px; color: #8888aa; margin-top: 2px; text-transform: lowercase; letter-spacing: 0.05em; }
    h1 { font-size: 24px; line-height: 1.25; margin: 6px 0 8px; color: #e7e5ee; text-transform: capitalize; }
    .sub { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #8888aa; margin: 0 0 24px; }
    .arc-chip { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 999px; font-size: 12px; background: rgba(185,176,220,0.12); color: #d6d0e6; text-transform: capitalize; margin-right: 6px; margin-bottom: 16px; }
    .arc-chip[data-arc="warming"] { background: rgba(140, 200, 150, 0.16); color: #c8e8cf; }
    .arc-chip[data-arc="cooling"] { background: rgba(150, 180, 230, 0.16); color: #cddaf0; }
    .arc-chip[data-arc="estranged"] { background: rgba(220, 140, 140, 0.16); color: #f0c7c7; }
    .arc-chip[data-arc="steady"] { background: rgba(200, 200, 200, 0.10); color: #cccccc; }
    .arc-chip[data-arc="new"] { background: rgba(245, 201, 122, 0.14); color: #f0d8a8; }
    .arc-chip .glyph { font-size: 14px; }
    .stat-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 24px; }
    .stat-pill { display: inline-flex; align-items: baseline; gap: 6px; padding: 6px 12px; border-radius: 999px; background: rgba(255,255,255,0.05); font-size: 12px; color: #d6d0e6; }
    .stat-pill .num { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #e7e5ee; }
    .stat-pill .key { color: #8888aa; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; }
    section { margin-bottom: 32px; }
    section h2 { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: #8888aa; margin: 0 0 12px; font-weight: 500; }
    .empty { font-size: 12px; color: #55556a; padding: 12px 0; font-style: italic; }
    .sparkline { display: flex; align-items: flex-end; gap: 6px; height: 96px; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .sparkline .bar-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; min-width: 24px; gap: 4px; height: 100%; position: relative; }
    .sparkline .bar { width: 100%; border-radius: 3px 3px 0 0; min-height: 2px; background: rgba(185,176,220,0.55); }
    .sparkline .bar[data-sign="pos"] { background: rgba(140, 200, 150, 0.7); }
    .sparkline .bar[data-sign="neg"] { background: rgba(220, 140, 140, 0.7); }
    .sparkline .bar[data-sign="zero"] { background: rgba(200, 200, 200, 0.18); }
    .sparkline .label { font-family: ui-monospace, Menlo, monospace; font-size: 9px; color: #8888aa; }
    .sparkline-meta { font-size: 11px; color: #8888aa; margin-top: 8px; font-family: ui-monospace, Menlo, monospace; }
    .moment-row { display: flex; gap: 12px; align-items: baseline; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .moment-row:last-child { border-bottom: none; }
    .moment-row .day { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #8888aa; flex-shrink: 0; min-width: 78px; }
    .moment-row .body { flex: 1; }
    .moment-row .headline { font-size: 13px; line-height: 1.4; color: #e7e5ee; }
    .moment-row .meta-line { font-size: 11px; color: #8888aa; margin-top: 4px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .moment-row .meta-line a { color: #b9b0dc; }
    .moment-row .badge { font-size: 9px; padding: 1px 6px; border-radius: 999px; background: rgba(185,176,220,0.18); color: #d6d0e6; letter-spacing: 0.06em; text-transform: uppercase; }
    .moment-row .badge[data-kind="group"] { background: rgba(185,176,220,0.28); color: #efe6ff; }
    footer { margin-top: 40px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #55556a; }
  </style>
</head>
<body>
  <main>
    <header class="top">
      <span>tinyhouse · arc</span>
      <a href="/">live sim →</a>
    </header>
    ${headerHtml}
    <h1>${escapeHtml(a.name)} &amp; ${escapeHtml(b.name)}</h1>
    <div class="sub">${escapeHtml(lastLine)}</div>
    <span class="arc-chip" data-arc="${escapeHtml(arcLabel)}"><span class="glyph">${escapeHtml(arcGlyph)}</span><span>${escapeHtml(arcLabel)} arc</span></span>
    <div class="stat-row">
      <span class="stat-pill"><span class="num">${escapeHtml(formatAffinity(payload.affinity))}</span><span class="key">affinity</span></span>
      <span class="stat-pill"><span class="num">${payload.totalMoments}</span><span class="key">moments</span></span>
      <span class="stat-pill"><span class="num">${payload.sharedConversationCount}</span><span class="key">conversations</span></span>
      <span class="stat-pill"><span class="num">${payload.nudgesApplied}</span><span class="key">nudges</span></span>
    </div>
    <section>
      <h2>Arc history (last ${SPARKLINE_DAYS} days)</h2>
      ${sparklineHtml}
    </section>
    <section>
      <h2>Moments together</h2>
      ${momentsHtml}
    </section>
    <footer>arc · ${escapeHtml(payload.pair.canonicalSlug)} · <a href="/character/${escapeHtml(a.id)}">${escapeHtml(a.name)}</a> · <a href="/character/${escapeHtml(b.id)}">${escapeHtml(b.name)}</a> · <a href="/arcs">all arcs →</a> · <a href="/digest/today">today's digest</a></footer>
  </main>
</body>
</html>`;
}

function renderArcHeader(a: NamedPersona['manifest'], b: NamedPersona['manifest']): string {
  const glyphA = `<div class="glyph" style="background:${escapeHtml(a.glyph.color)}; box-shadow: 0 0 0 3px ${escapeHtml(a.glyph.accent)};"><span class="star">★</span></div>`;
  const glyphB = `<div class="glyph" style="background:${escapeHtml(b.glyph.color)}; box-shadow: 0 0 0 3px ${escapeHtml(b.glyph.accent)};"><span class="star">★</span></div>`;
  return `<header class="pair">
    ${glyphA}
    <div class="who"><span class="name"><a href="/character/${escapeHtml(a.id)}">${escapeHtml(a.name)}</a></span><span class="sub">${escapeHtml(a.archetype)}</span></div>
    <span class="between">&amp;</span>
    <div class="who"><span class="name"><a href="/character/${escapeHtml(b.id)}">${escapeHtml(b.name)}</a></span><span class="sub">${escapeHtml(b.archetype)}</span></div>
    ${glyphB}
  </header>`;
}

function renderSparkline(steps: SparklineStep[]): string {
  // Scale bars relative to the largest absolute delta so a flat week still
  // renders as visible "zero" pads instead of a single tall bar.
  const maxAbs = steps.reduce((m, s) => Math.max(m, Math.abs(s.delta)), 0);
  const heightFor = (delta: number) => {
    if (maxAbs === 0) return 4;
    const pct = Math.min(1, Math.abs(delta) / maxAbs);
    return Math.max(4, Math.round(pct * 84));
  };
  const cols = steps
    .map((s) => {
      const sign = s.delta > 0.001 ? 'pos' : s.delta < -0.001 ? 'neg' : 'zero';
      const h = heightFor(s.delta);
      const title = `day ${s.day} · ${s.momentsCount} moment${s.momentsCount === 1 ? '' : 's'} · Δ ${s.delta >= 0 ? '+' : ''}${s.delta.toFixed(3)}`;
      return `<div class="bar-col" title="${escapeHtml(title)}"><div class="bar" data-sign="${sign}" style="height:${h}px"></div><span class="label">d${s.day}</span></div>`;
    })
    .join('');
  const last = steps[steps.length - 1];
  const meta = last
    ? `latest day ${last.day} · ${last.momentsCount} moment${last.momentsCount === 1 ? '' : 's'} · Δ ${last.delta >= 0 ? '+' : ''}${last.delta.toFixed(2)}`
    : '';
  return `<div class="sparkline">${cols}</div><div class="sparkline-meta">${escapeHtml(meta)}</div>`;
}

function renderMomentsList(records: MomentRecord[], simSpeed: number): string {
  if (records.length === 0) {
    return '<div class="empty">No joint moments yet — check back after they bump into each other.</div>';
  }
  return records
    .map((rec) => {
      const day = simDay(rec.simTime);
      const clock = rec.clock ?? deriveWorldClock(rec.simTime, simSpeed);
      const dayLine = `day ${day} · ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
      const isGroup = (rec.variant ?? 'conversation') === 'group';
      const badges: string[] = [];
      if (isGroup) badges.push('<span class="badge" data-kind="group">group</span>');
      const link = `/moment/${escapeHtml(rec.id)}`;
      const zone = rec.zone
        ? ` · <a href="/zone/${escapeHtml(encodeURIComponent(rec.zone.toLowerCase()))}">${escapeHtml(rec.zone)}</a>`
        : '';
      return `<article class="moment-row"><span class="day">${escapeHtml(dayLine)}</span><div class="body"><div class="headline"><a href="${link}">${escapeHtml(rec.headline)}</a></div><div class="meta-line">${badges.join(' ')}${zone}</div></div></article>`;
    })
    .join('');
}

function notFoundPage(slug: string, named: NamedPersona[]): string {
  const list = named
    .map(
      (p) =>
        `<li><a href="/character/${escapeHtml(p.manifest.id)}">${escapeHtml(p.manifest.name)}</a></li>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>arc not found — tinyhouse</title>
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; padding: 0; background: #0f0d15; color: #e7e5ee; font-family: -apple-system, system-ui, Segoe UI, sans-serif; }
    main { max-width: 480px; margin: 0 auto; padding: 80px 20px; text-align: center; }
    h1 { font-size: 20px; color: #e7e5ee; margin: 0 0 10px; }
    p { color: #8888aa; font-size: 13px; }
    a { color: #b9b0dc; }
    ul { list-style: none; padding: 0; margin: 16px 0; font-size: 13px; }
    ul li { padding: 4px 0; }
    code { background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <h1>arc not found</h1>
    <p>No named pair matched <code>${escapeHtml(slug)}</code>. Try one of these characters:</p>
    <ul>${list}</ul>
    <p><a href="/">back to the live sim</a></p>
  </main>
</body>
</html>`;
}

function notFoundPairPage(pair: ResolvedPair, named: NamedPersona[]): string {
  const list = named
    .map(
      (p) =>
        `<li><a href="/character/${escapeHtml(p.manifest.id)}">${escapeHtml(p.manifest.name)}</a></li>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>no arc yet — tinyhouse</title>
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; padding: 0; background: #0f0d15; color: #e7e5ee; font-family: -apple-system, system-ui, Segoe UI, sans-serif; }
    main { max-width: 480px; margin: 0 auto; padding: 80px 20px; text-align: center; }
    h1 { font-size: 20px; color: #e7e5ee; margin: 0 0 10px; }
    p { color: #8888aa; font-size: 13px; }
    a { color: #b9b0dc; }
    ul { list-style: none; padding: 0; margin: 16px 0; font-size: 13px; }
    ul li { padding: 4px 0; }
  </style>
</head>
<body>
  <main>
    <h1>no arc yet</h1>
    <p>${escapeHtml(pair.a.manifest.name)} and ${escapeHtml(pair.b.manifest.name)} haven't crossed paths yet. Their arc page will appear after their first close.</p>
    <ul>${list}</ul>
    <p><a href="/">back to the live sim</a></p>
  </main>
</body>
</html>`;
}

function simpleErrorPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} — tinyhouse</title>
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; padding: 0; background: #0f0d15; color: #e7e5ee; font-family: -apple-system, system-ui, Segoe UI, sans-serif; }
    main { max-width: 480px; margin: 0 auto; padding: 80px 20px; text-align: center; }
    h1 { font-size: 20px; color: #e7e5ee; margin: 0 0 10px; }
    p { color: #8888aa; font-size: 13px; }
    a { color: #b9b0dc; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(body)}</p>
    <p><a href="/">back to the live sim</a></p>
  </main>
</body>
</html>`;
}

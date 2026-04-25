import type { IncomingMessage, ServerResponse } from 'node:http';
import { type MomentRecord, type SimTime, deriveWorldClock } from '@tina/shared';
import { type ArcLabel, type NudgeDirection, type RelationshipStore, simDay } from '@tina/sim';
import type { MomentStore } from './moments.js';
import { composeDigestOg } from './og-image.js';
import type { OgCache } from './og-routes.js';

/**
 * Per-sim-day moment digest (TINA-684).
 *
 * Aggregates the day's most notable moments from the in-memory MomentRecord
 * LRU + RelationshipStore at request time. No new persistence — the digest is
 * a deterministic projection of state already on disk for moments and arcs.
 *
 * Determinism contract:
 *   buildDigest(sameMomentSet, sameArcs, sameDay) === byte-identical output
 *
 * The composeDigestOg renderer is deterministic for the same digest input,
 * which is what the disk-LRU OG cache key relies on.
 */

export type DigestLogger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
) => void;

const noopLog: DigestLogger = () => {};

const DATE_PATTERN = /^sd-\d{1,6}$/;
const WINDOW_MS = 60_000;
const DEFAULT_PER_IP_PER_MIN = 60;
const DEFAULT_GLOBAL_PER_MIN = 600;
const DEFAULT_TOP_N = 10;

const ARC_GLYPHS: Record<ArcLabel, string> = {
  new: '🌀',
  warming: '🌱',
  cooling: '🥶',
  estranged: '🔕',
  steady: '💤',
};

// Strength order for the deterministic picker. Warming + estranged are
// narratively load-bearing arcs; steady is the least interesting. Used as a
// secondary sort key only — group variant always wins ahead of arc strength.
const ARC_STRENGTH: Record<ArcLabel, number> = {
  warming: 5,
  estranged: 4,
  cooling: 3,
  new: 2,
  steady: 1,
};

const NUDGE_GLYPHS: Record<NudgeDirection, string> = {
  spark: '✨',
  tension: '⚡',
  reconcile: '🤝',
};

export interface DigestEntry {
  rec: MomentRecord;
  /** Best per-pair arc label for this moment's named participants, if any. */
  arc: { label: ArcLabel; glyph: string } | null;
  /** Set when the live nudge tracker still remembers a viewer-applied nudge. */
  nudge: { direction: NudgeDirection; glyph: string } | null;
}

export interface DigestArcChip {
  a: { id: string; name: string };
  b: { id: string; name: string };
  label: ArcLabel;
  glyph: string;
}

export interface Digest {
  /** 0-indexed sim-day. */
  day: number;
  /** Canonical date key: `sd-{day}`. */
  dateKey: string;
  /** Empty when no moments matched this day. */
  entries: DigestEntry[];
  /** First entry, hoisted for header rendering. Null on empty days. */
  top: DigestEntry | null;
  /** Distinct participants across the kept entries, in stable order. */
  participants: MomentRecord['participants'];
  /** Per-pair arc chips for named pairs touched this day. */
  arcsTouched: DigestArcChip[];
  /** Subset of entries that consumed a viewer nudge — surfaced in a strip. */
  nudged: DigestEntry[];
  /** Deterministic page headline. */
  headline: string;
}

export interface BuildDigestOptions {
  /** Cap on retained entries. Default 10. */
  topN?: number;
  /** Optional relationships store — drives arc chips + arc-strength sort. */
  relationships?: RelationshipStore | null;
  /** Optional render-time nudge lookup — drives the nudged callout strip. */
  isSessionNudged?: ((sessionId: string) => NudgeDirection | null) | null;
}

/**
 * Pick the day's top-N moments deterministically. Ranking:
 *   1. group variant first
 *   2. then named×named pairs by current arc strength (warming > estranged > cooling > new > steady)
 *   3. then freshest (largest simTime)
 *   4. then id ascending — stable tiebreak
 */
export function buildDigest(
  allMoments: MomentRecord[],
  day: number,
  opts: BuildDigestOptions = {},
): Digest {
  const topN = Math.max(1, opts.topN ?? DEFAULT_TOP_N);
  const relationships = opts.relationships ?? null;
  const isSessionNudged = opts.isSessionNudged ?? null;

  const sameDay = allMoments.filter((rec) => simDay(rec.simTime) === day);

  const enriched: DigestEntry[] = sameDay.map((rec) => {
    let arc: DigestEntry['arc'] = null;
    if (
      relationships &&
      (rec.variant ?? 'conversation') !== 'group' &&
      rec.participants.length === 2
    ) {
      const [p1, p2] = rec.participants;
      if (p1?.named && p2?.named) {
        const pair = relationships.getPair(p1.id, p2.id);
        if (pair) arc = { label: pair.arcLabel, glyph: ARC_GLYPHS[pair.arcLabel] };
      }
    }
    let nudge: DigestEntry['nudge'] = null;
    if (isSessionNudged) {
      const direction = isSessionNudged(rec.sessionId);
      if (direction) nudge = { direction, glyph: NUDGE_GLYPHS[direction] };
    }
    return { rec, arc, nudge };
  });

  // Pre-compute the rank tuple per entry for clarity. Sort descending where
  // bigger = better (so we negate id for the lex tiebreak, doing it inline).
  enriched.sort((x, y) => {
    const xGroup = (x.rec.variant ?? 'conversation') === 'group' ? 1 : 0;
    const yGroup = (y.rec.variant ?? 'conversation') === 'group' ? 1 : 0;
    if (xGroup !== yGroup) return yGroup - xGroup;
    const xArc = x.arc ? ARC_STRENGTH[x.arc.label] : 0;
    const yArc = y.arc ? ARC_STRENGTH[y.arc.label] : 0;
    if (xArc !== yArc) return yArc - xArc;
    if (x.rec.simTime !== y.rec.simTime) return y.rec.simTime - x.rec.simTime;
    return x.rec.id < y.rec.id ? -1 : x.rec.id > y.rec.id ? 1 : 0;
  });

  const entries = enriched.slice(0, topN);

  const seenParticipantIds = new Set<string>();
  const participants: MomentRecord['participants'] = [];
  for (const e of entries) {
    for (const p of e.rec.participants) {
      if (seenParticipantIds.has(p.id)) continue;
      seenParticipantIds.add(p.id);
      participants.push(p);
    }
  }

  const arcsTouched = collectArcChips(entries, relationships);
  const nudged = entries.filter((e) => e.nudge !== null);
  const top = entries[0] ?? null;
  const dateKey = formatDigestDate(day);
  const headline = buildDigestHeadline(day, top);

  return { day, dateKey, entries, top, participants, arcsTouched, nudged, headline };
}

/**
 * Per-pair arc chips for every named×named pair that appears in any kept
 * entry today, with the current arc label. Stable order: each pair surfaces
 * the first time it's seen during the entries walk, so chip ordering matches
 * the order moments are listed.
 */
function collectArcChips(
  entries: DigestEntry[],
  relationships: RelationshipStore | null,
): DigestArcChip[] {
  if (!relationships) return [];
  const chips: DigestArcChip[] = [];
  const seenKeys = new Set<string>();
  for (const e of entries) {
    const parts = e.rec.participants;
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const p1 = parts[i]!;
        const p2 = parts[j]!;
        if (!p1.named || !p2.named) continue;
        const a = p1.id < p2.id ? p1 : p2;
        const b = p1.id < p2.id ? p2 : p1;
        const key = `${a.id}::${b.id}`;
        if (seenKeys.has(key)) continue;
        const pair = relationships.getPair(a.id, b.id);
        if (!pair) continue;
        seenKeys.add(key);
        chips.push({
          a: { id: a.id, name: a.name },
          b: { id: b.id, name: b.name },
          label: pair.arcLabel,
          glyph: ARC_GLYPHS[pair.arcLabel],
        });
      }
    }
  }
  return chips;
}

export function formatDigestDate(day: number): string {
  return `sd-${day}`;
}

/**
 * Resolve an incoming `:date` segment to a sim-day. Accepts:
 *   - `sd-12` (canonical)
 *   - `today`     → currentDay
 *   - `yesterday` → currentDay - 1
 * Returns null on anything else (including negative days).
 */
export function parseDigestDate(
  raw: string,
  currentSimDay: number,
): { day: number; canonical: string } | null {
  if (raw === 'today') {
    return { day: currentSimDay, canonical: formatDigestDate(currentSimDay) };
  }
  if (raw === 'yesterday') {
    const day = currentSimDay - 1;
    if (day < 0) return null;
    return { day, canonical: formatDigestDate(day) };
  }
  if (!DATE_PATTERN.test(raw)) return null;
  const day = Number.parseInt(raw.slice(3), 10);
  if (!Number.isFinite(day) || day < 0) return null;
  return { day, canonical: formatDigestDate(day) };
}

export function buildDigestHeadline(day: number, top: DigestEntry | null): string {
  if (!top) return `TINA — Sim-Day ${day}: a quiet day`;
  return `TINA — Sim-Day ${day}: ${top.rec.headline}`;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export interface DigestRouteOptions {
  store: MomentStore;
  cache: OgCache;
  /** Source of "current sim-day" for the today/yesterday aliases. */
  currentSimTime: () => SimTime;
  relationships?: RelationshipStore | null;
  isSessionNudged?: ((sessionId: string) => NudgeDirection | null) | null;
  /** Public base URL for canonical/og:url. Falls back to relative paths. */
  publicBaseUrl?: string | null;
  /** Sim speed (seconds-per-real-second) for clock derivation. */
  simSpeed: number;
  perIpPerMin?: number;
  globalPerMin?: number;
  topN?: number;
  /** Hook called after a successful 200 OG render — drives `digestOgRenders`. */
  onOgRender?: (canonicalDate: string, ip: string) => void;
  log?: DigestLogger;
  now?: () => number;
}

export interface DigestPageOutcome {
  status: number;
  /** Canonical date key when the response was a 200, else null. */
  canonicalDate: string | null;
  rateLimited: boolean;
}

/**
 * GET /digest/:date and /digest/:date/og.png. Public, no auth. Aggregates
 * from the live MomentRecord LRU on every request — no per-day file, no
 * background pre-render. The OG image is cached by canonical date in the
 * disk-LRU passed in via `opts.cache`.
 */
export class DigestRoutes {
  private readonly store: MomentStore;
  private readonly cache: OgCache;
  private readonly currentSimTime: () => SimTime;
  private readonly relationships: RelationshipStore | null;
  private readonly isSessionNudged: ((sessionId: string) => NudgeDirection | null) | null;
  private readonly publicBaseUrl: string | null;
  private readonly simSpeed: number;
  private readonly perIpRate: number;
  private readonly globalRate: number;
  private readonly topN: number;
  private readonly onOgRender?: (canonicalDate: string, ip: string) => void;
  private readonly log: DigestLogger;
  private readonly now: () => number;
  private readonly perIp = new Map<string, Bucket>();
  private readonly globalBucket: Bucket = { count: 0, windowStart: 0 };

  constructor(opts: DigestRouteOptions) {
    this.store = opts.store;
    this.cache = opts.cache;
    this.currentSimTime = opts.currentSimTime;
    this.relationships = opts.relationships ?? null;
    this.isSessionNudged = opts.isSessionNudged ?? null;
    this.publicBaseUrl = (opts.publicBaseUrl ?? null)?.replace(/\/+$/, '') ?? null;
    this.simSpeed = opts.simSpeed;
    this.perIpRate = opts.perIpPerMin ?? DEFAULT_PER_IP_PER_MIN;
    this.globalRate = opts.globalPerMin ?? DEFAULT_GLOBAL_PER_MIN;
    this.topN = Math.max(1, opts.topN ?? DEFAULT_TOP_N);
    this.onOgRender = opts.onOgRender;
    this.log = opts.log ?? noopLog;
    this.now = opts.now ?? (() => Date.now());
  }

  cacheSize(): number {
    return this.cache.size();
  }

  /** Surface the current sim-day so server.ts can mint the "Today's digest" link. */
  todayKey(): string {
    return formatDigestDate(simDay(this.currentSimTime()));
  }

  handleDigestPage(req: IncomingMessage, res: ServerResponse, rawDate: string): DigestPageOutcome {
    const ip = clientIp(req);
    const rate = this.checkRate(ip);
    if (!rate.ok) {
      res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
      writeHtml(res, 429, simpleErrorPage('slow down', 'Too many digest lookups from this IP.'));
      return { status: 429, canonicalDate: null, rateLimited: true };
    }
    const today = simDay(this.currentSimTime());
    const parsed = parseDigestDate(rawDate, today);
    if (!parsed) {
      writeHtml(res, 404, notFoundPage(rawDate));
      return { status: 404, canonicalDate: null, rateLimited: false };
    }
    const digest = buildDigest(this.store.list(), parsed.day, {
      topN: this.topN,
      relationships: this.relationships,
      isSessionNudged: this.isSessionNudged,
    });
    const html = this.renderDigestHtml(digest, parsed.canonical);
    writeHtml(res, 200, html);
    return { status: 200, canonicalDate: parsed.canonical, rateLimited: false };
  }

  async handleDigestOgImage(
    req: IncomingMessage,
    res: ServerResponse,
    rawDate: string,
  ): Promise<void> {
    const ip = clientIp(req);
    const rate = this.checkRate(ip);
    if (!rate.ok) {
      res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
      writePlain(res, 429, 'rate limited');
      return;
    }
    const today = simDay(this.currentSimTime());
    const parsed = parseDigestDate(rawDate, today);
    if (!parsed) {
      writePlain(res, 404, 'not found');
      return;
    }
    const digest = buildDigest(this.store.list(), parsed.day, {
      topN: this.topN,
      relationships: this.relationships,
      isSessionNudged: this.isSessionNudged,
    });
    let png: Buffer;
    let cacheHit = false;
    const t0 = this.now();
    const cached = await this.cache.get(parsed.canonical);
    if (cached) {
      png = cached;
      cacheHit = true;
    } else {
      png = composeDigestOg({
        day: digest.day,
        headline: digest.headline,
        momentsCount: digest.entries.length,
        participants: digest.participants.map((p) => ({
          name: p.name,
          named: p.named,
          color: p.color,
        })),
      });
      // Fire-and-forget — never block the response on the cache write.
      void this.cache.set(parsed.canonical, png).catch((err) => {
        this.log('warn', 'digest.cache.set.error', {
          dateKey: parsed.canonical,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(png.length),
      // Today's digest can change on the next conversation close; only freeze
      // historical days hard. Today is fine to cache for a minute.
      'cache-control':
        parsed.day === today ? 'public, max-age=60' : 'public, max-age=86400, immutable',
      'x-og-cache': cacheHit ? 'hit' : 'miss',
    });
    res.end(png);
    this.log('info', 'digest.og.render', {
      dateKey: parsed.canonical,
      cacheHit,
      bytes: png.length,
      ms: this.now() - t0,
    });
    this.onOgRender?.(parsed.canonical, ip);
  }

  private renderDigestHtml(digest: Digest, canonicalDate: string): string {
    return renderDigestHtml({
      digest,
      canonical: this.buildCanonicalUrl(`/digest/${canonicalDate}`),
      ogImageUrl: this.buildCanonicalUrl(`/digest/${canonicalDate}/og.png`),
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

function buildDigestDescription(digest: Digest, max = 160): string {
  if (digest.entries.length === 0) {
    return `Sim-Day ${digest.day} on TinyHouse — no notable moments yet.`;
  }
  const parts: string[] = [];
  parts.push(`Sim-Day ${digest.day} on TinyHouse`);
  parts.push(`${digest.entries.length} moments`);
  if (digest.top) parts.push(digest.top.rec.headline);
  return truncate(parts.join(' · '), max);
}

interface RenderInput {
  digest: Digest;
  canonical: string;
  ogImageUrl: string;
  simSpeed: number;
}

function renderDigestHtml(input: RenderInput): string {
  const { digest, canonical, ogImageUrl, simSpeed } = input;
  const title = escapeHtml(digest.headline);
  const description = escapeHtml(buildDigestDescription(digest));
  const canonicalEsc = escapeHtml(canonical);
  const ogImageEsc = escapeHtml(ogImageUrl);

  const participantChips = digest.participants
    .map((p) => {
      const color = p.color ?? '#b9b0dc';
      const star = p.named ? '<span class="star">★</span>' : '';
      const inner = `<span class="sw" style="background:${escapeHtml(color)}"></span>${star}${escapeHtml(p.name)}`;
      return p.named
        ? `<a class="chip" href="/character/${escapeHtml(p.id)}">${inner}</a>`
        : `<span class="chip">${inner}</span>`;
    })
    .join('');

  const arcChipsHtml = digest.arcsTouched.length
    ? `<div class="arcs">${digest.arcsTouched
        .map(
          (chip) =>
            `<span class="arc" data-arc="${escapeHtml(chip.label)}"><span class="glyph">${escapeHtml(chip.glyph)}</span><span>${escapeHtml(chip.a.name)} & ${escapeHtml(chip.b.name)} — ${escapeHtml(chip.label)}</span></span>`,
        )
        .join('')}</div>`
    : '';

  const nudgedHtml = digest.nudged.length
    ? `<section class="nudged">
        <h2>Viewer-nudged today</h2>
        <ul>
          ${digest.nudged
            .map((e) => {
              const link = `/moment/${escapeHtml(e.rec.id)}`;
              const dir = e.nudge?.direction ?? 'spark';
              const glyph = e.nudge?.glyph ?? '✨';
              return `<li><span class="nudge" data-nudge="${escapeHtml(dir)}"><span class="glyph">${escapeHtml(glyph)}</span><span>${escapeHtml(dir)}</span></span> <a href="${link}">${escapeHtml(e.rec.headline)}</a></li>`;
            })
            .join('')}
        </ul>
      </section>`
    : '';

  const rowsHtml = digest.entries.length
    ? digest.entries.map((e) => renderEntryRow(e, simSpeed)).join('')
    : '<div class="empty">No moments captured this sim-day yet — check back after the agents have settled.</div>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title} — tinyhouse</title>
  <meta name="description" content="${description}" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${canonicalEsc}" />
  <meta property="og:site_name" content="tinyhouse" />
  <meta property="og:image" content="${ogImageEsc}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:type" content="image/png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${ogImageEsc}" />
  <link rel="canonical" href="${canonicalEsc}" />
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; padding: 0; background: #0f0d15; color: #e7e5ee; font-family: -apple-system, system-ui, Segoe UI, sans-serif; }
    main { max-width: 760px; margin: 0 auto; padding: 32px 20px 80px; }
    a { color: #b9b0dc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    header.top { display: flex; justify-content: space-between; align-items: center; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: #8888aa; margin-bottom: 18px; }
    h1 { font-size: 22px; line-height: 1.3; margin: 0 0 14px; color: #e7e5ee; }
    .sub { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #8888aa; margin: 0 0 18px; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 18px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,0.05); font-size: 12px; color: #e7e5ee; }
    .chip .sw { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .chip .star { color: #f5c97a; margin-right: 2px; }
    .arcs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 22px; }
    .arc { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 11px; background: rgba(185,176,220,0.10); color: #d6d0e6; }
    .arc[data-arc="warming"] { background: rgba(140, 200, 150, 0.14); color: #c8e8cf; }
    .arc[data-arc="cooling"] { background: rgba(150, 180, 230, 0.14); color: #cddaf0; }
    .arc[data-arc="estranged"] { background: rgba(220, 140, 140, 0.14); color: #f0c7c7; }
    .arc[data-arc="steady"] { background: rgba(200, 200, 200, 0.10); color: #cccccc; }
    .arc[data-arc="new"] { background: rgba(245, 201, 122, 0.14); color: #f0d8a8; }
    .arc .glyph { font-size: 12px; }
    section.nudged { margin: 0 0 24px; padding: 14px 16px; border: 1px solid rgba(245, 201, 122, 0.25); border-radius: 8px; background: rgba(245, 201, 122, 0.06); }
    section.nudged h2 { margin: 0 0 8px; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: #f0d8a8; font-weight: 500; }
    section.nudged ul { list-style: none; padding: 0; margin: 0; }
    section.nudged li { font-size: 12px; padding: 4px 0; color: #e7e5ee; display: flex; align-items: center; gap: 8px; }
    .nudge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 10px; background: rgba(245, 201, 122, 0.18); color: #f6e0b0; text-transform: uppercase; letter-spacing: 0.06em; }
    .nudge[data-nudge="tension"] { background: rgba(230, 150, 150, 0.18); color: #f2c3c3; }
    .nudge[data-nudge="reconcile"] { background: rgba(150, 210, 180, 0.18); color: #c9e9d6; }
    .nudge .glyph { font-size: 11px; }
    .row { display: flex; gap: 12px; align-items: baseline; padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .row:last-child { border-bottom: none; }
    .row .rank { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #55556a; flex-shrink: 0; min-width: 22px; text-align: right; }
    .row .body { flex: 1; }
    .row .headline { font-size: 14px; line-height: 1.4; color: #e7e5ee; }
    .row .meta-line { font-size: 11px; color: #8888aa; margin-top: 4px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .row .meta-line a { color: #b9b0dc; }
    .row .badge { font-size: 9px; padding: 1px 6px; border-radius: 999px; background: rgba(185,176,220,0.18); color: #d6d0e6; letter-spacing: 0.06em; text-transform: uppercase; }
    .row .badge[data-kind="group"] { background: rgba(185,176,220,0.28); color: #efe6ff; }
    .row .badge[data-kind="nudged"] { background: rgba(245, 201, 122, 0.18); color: #f6e0b0; }
    .row .arc-mini { font-size: 10px; color: #d6d0e6; padding: 1px 6px; border-radius: 999px; background: rgba(185,176,220,0.10); }
    .row .arc-mini[data-arc="warming"] { background: rgba(140, 200, 150, 0.14); color: #c8e8cf; }
    .row .arc-mini[data-arc="cooling"] { background: rgba(150, 180, 230, 0.14); color: #cddaf0; }
    .row .arc-mini[data-arc="estranged"] { background: rgba(220, 140, 140, 0.14); color: #f0c7c7; }
    .row .arc-mini[data-arc="steady"] { background: rgba(200, 200, 200, 0.10); color: #cccccc; }
    .row .arc-mini[data-arc="new"] { background: rgba(245, 201, 122, 0.14); color: #f0d8a8; }
    .empty { padding: 40px 0 20px; text-align: center; color: #8888aa; font-size: 13px; line-height: 1.5; font-style: italic; }
    footer { margin-top: 40px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #55556a; }
  </style>
</head>
<body>
  <main>
    <header class="top">
      <span>tinyhouse · digest</span>
      <a href="/">live sim →</a>
    </header>
    <h1>${title}</h1>
    <div class="sub">sim-day ${digest.day} · ${digest.entries.length} moments</div>
    ${participantChips ? `<div class="chips">${participantChips}</div>` : ''}
    ${arcChipsHtml}
    ${nudgedHtml}
    ${rowsHtml}
    <footer>digest · ${escapeHtml(digest.dateKey)} · <a href="/digest/today">today</a> · <a href="/digest/yesterday">yesterday</a> · <a href="/moments">all moments</a></footer>
  </main>
</body>
</html>`;
}

function renderEntryRow(e: DigestEntry, simSpeed: number): string {
  const rec = e.rec;
  const link = `/moment/${escapeHtml(rec.id)}`;
  const headline = escapeHtml(rec.headline);
  const clock = rec.clock ?? deriveWorldClock(rec.simTime, simSpeed);
  const dayLine = `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
  const isGroup = (rec.variant ?? 'conversation') === 'group';
  const participantHtml = rec.participants
    .map((p) =>
      p.named
        ? `<a href="/character/${escapeHtml(p.id)}">${escapeHtml(p.name)}</a>`
        : escapeHtml(p.name),
    )
    .join(', ');
  const badges: string[] = [];
  if (isGroup) badges.push('<span class="badge" data-kind="group">group</span>');
  if (e.nudge) badges.push('<span class="badge" data-kind="nudged">nudged</span>');
  if (e.arc) {
    badges.push(
      `<span class="arc-mini" data-arc="${escapeHtml(e.arc.label)}">${escapeHtml(e.arc.glyph)} ${escapeHtml(e.arc.label)}</span>`,
    );
  }
  const zoneHtml = rec.zone ? ` · ${escapeHtml(rec.zone)}` : '';
  return `<article class="row"><span class="rank">${dayLine}</span><div class="body"><div class="headline"><a href="${link}">${headline}</a></div><div class="meta-line">${participantHtml}${zoneHtml}${badges.length ? ` · ${badges.join(' ')}` : ''}</div></div></article>`;
}

function notFoundPage(rawDate: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>digest not found — tinyhouse</title>
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; padding: 0; background: #0f0d15; color: #e7e5ee; font-family: -apple-system, system-ui, Segoe UI, sans-serif; }
    main { max-width: 480px; margin: 0 auto; padding: 80px 20px; text-align: center; }
    h1 { font-size: 20px; color: #e7e5ee; margin: 0 0 10px; }
    p { color: #8888aa; font-size: 13px; }
    a { color: #b9b0dc; }
    code { background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <h1>digest not found</h1>
    <p>No digest at <code>${escapeHtml(rawDate)}</code>. Try <a href="/digest/today">today</a> or <a href="/digest/yesterday">yesterday</a>.</p>
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
    <p><a href="/digest/today">today's digest</a> · <a href="/">back to the live sim</a></p>
  </main>
</body>
</html>`;
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type MomentParticipant,
  type MomentRecord,
  type ObjectAffordance,
  type WorldObject,
  type Zone,
  deriveWorldClock,
} from '@tina/shared';
import { simDay } from '@tina/sim';
import type { MomentStore } from './moments.js';
import { composeZoneOg } from './og-image.js';
import type { OgCache } from './og-routes.js';

/**
 * Per-zone "what happened here" page (TINA-744).
 *
 * Reads from the live MomentRecord LRU + world object state — no new
 * persistence, no LLM, no sim hot-path. Mirrors the routing/limit/sticky
 * shape of `/character/:name` (TINA-482) and `/digest/:date` (TINA-684).
 */

export type ZoneLogger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
) => void;

const noopLog: ZoneLogger = () => {};

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const WINDOW_MS = 60_000;
const DEFAULT_PER_IP_PER_MIN = 60;
const DEFAULT_GLOBAL_PER_MIN = 600;

const AFFORDANCE_GLYPH: Record<ObjectAffordance, string> = {
  bench: '🪑',
  music: '🎵',
  food: '🍱',
};

interface Bucket {
  count: number;
  windowStart: number;
}

export interface ZoneRouteOptions {
  /** Read-side moment LRU. */
  moments: MomentStore;
  /** Disk-backed OG cache (separate dir from /moment/:id and /digest). */
  cache: OgCache;
  /**
   * Snapshot of authoritative zones — usually `world.zones`. Never mutated;
   * the page resolver walks it for the canonical name + display info.
   */
  zones: Zone[];
  /**
   * Optional callback returning the live world objects whose `zone` matches.
   * Lets the page reflect intervened-in objects without taking a hard
   * dependency on the World instance from this module.
   */
  listObjectsInZone?: ((canonicalName: string) => WorldObject[]) | null;
  /** Sim speed (seconds-per-real-second) for clock derivation. */
  simSpeed: number;
  /** Public base URL for canonical/og:url. Falls back to relative paths. */
  publicBaseUrl?: string | null;
  /** Per-IP page hits per minute. Default 60 — mirrors `/character/:name`. */
  perIpPerMin?: number;
  /** Global ceiling per minute. Default 600. */
  globalPerMin?: number;
  /** How many recent moments to render at most. Default 20 (per spec). */
  maxMoments?: number;
  /** How many top characters to surface in the strip. Default 6. */
  topCharacters?: number;
  /** Bumped after a 200 OG render — drives `zoneOgRenders` sticky metric. */
  onOgRender?: (canonicalName: string, ip: string) => void;
  log?: ZoneLogger;
  now?: () => number;
}

export interface ZonePageOutcome {
  status: number;
  /** Lowercased canonical zone name, only set on a 200 hit. */
  canonicalName: string | null;
  rateLimited: boolean;
}

interface TopCharacter {
  id: string;
  name: string;
  named: boolean;
  color: string | null;
  appearances: number;
}

interface AffordanceRow {
  id: string;
  label: string;
  affordance: ObjectAffordance | null;
  glyph: string;
}

/**
 * Build a case-insensitive zone resolver. Maps the canonical name, a
 * slugified variant ("Coffee Shop" → "coffee-shop"), and the first word
 * ("coffee shop" → "coffee") to the zone. Earlier entries win on collision
 * so the canonical name is always preferred.
 */
export function buildZoneResolver(zones: Zone[]): Map<string, Zone> {
  const byKey = new Map<string, Zone>();
  for (const zone of zones) {
    const idKey = zone.name.toLowerCase();
    if (!byKey.has(idKey)) byKey.set(idKey, zone);
    const slug = zone.name.toLowerCase().replace(/\s+/g, '-');
    if (!byKey.has(slug)) byKey.set(slug, zone);
    const first = zone.name.split(/\s+/, 1)[0]?.toLowerCase();
    if (first && !byKey.has(first)) byKey.set(first, zone);
  }
  return byKey;
}

export class ZoneRoutes {
  private readonly moments: MomentStore;
  private readonly cache: OgCache;
  private readonly zones: Zone[];
  private readonly byKey: Map<string, Zone>;
  private readonly listObjectsInZone: ((canonicalName: string) => WorldObject[]) | null;
  private readonly simSpeed: number;
  private readonly publicBaseUrl: string | null;
  private readonly perIpRate: number;
  private readonly globalRate: number;
  private readonly maxMoments: number;
  private readonly topCharacters: number;
  private readonly onOgRender?: (canonicalName: string, ip: string) => void;
  private readonly log: ZoneLogger;
  private readonly now: () => number;
  private readonly perIp = new Map<string, Bucket>();
  private readonly globalBucket: Bucket = { count: 0, windowStart: 0 };

  constructor(opts: ZoneRouteOptions) {
    this.moments = opts.moments;
    this.cache = opts.cache;
    this.zones = [...opts.zones];
    this.listObjectsInZone = opts.listObjectsInZone ?? null;
    this.simSpeed = opts.simSpeed;
    this.publicBaseUrl = (opts.publicBaseUrl ?? null)?.replace(/\/+$/, '') ?? null;
    this.perIpRate = opts.perIpPerMin ?? DEFAULT_PER_IP_PER_MIN;
    this.globalRate = opts.globalPerMin ?? DEFAULT_GLOBAL_PER_MIN;
    this.maxMoments = Math.max(1, opts.maxMoments ?? 20);
    this.topCharacters = Math.max(1, opts.topCharacters ?? 6);
    this.onOgRender = opts.onOgRender;
    this.log = opts.log ?? noopLog;
    this.now = opts.now ?? (() => Date.now());
    this.byKey = buildZoneResolver(this.zones);
  }

  /**
   * GET /zone/:name. Public, no auth.
   *   - 200 + HTML on a known zone (case-insensitive)
   *   - 404 + HTML on unknown name or pattern miss
   *   - 429 + small body when the IP/global rate limiter rejects
   */
  handleZonePage(req: IncomingMessage, res: ServerResponse, rawName: string): ZonePageOutcome {
    const ip = clientIp(req);
    const rate = this.checkRate(ip);
    if (!rate.ok) {
      res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
      writeHtml(res, 429, simpleErrorPage('slow down', 'Too many zone lookups from this IP.'));
      return { status: 429, canonicalName: null, rateLimited: true };
    }
    const decoded = safeDecode(rawName);
    if (!decoded || !NAME_PATTERN.test(decoded)) {
      writeHtml(res, 404, notFoundPage(decoded ?? rawName, this.zones));
      return { status: 404, canonicalName: null, rateLimited: false };
    }
    const zone = this.byKey.get(decoded.toLowerCase());
    if (!zone) {
      writeHtml(res, 404, notFoundPage(decoded, this.zones));
      return { status: 404, canonicalName: null, rateLimited: false };
    }
    const canonical = zone.name.toLowerCase();
    const html = this.renderZoneHtml(zone, canonical);
    writeHtml(res, 200, html);
    return { status: 200, canonicalName: canonical, rateLimited: false };
  }

  /** GET /zone/:name/og.png. Public. 200 PNG on hit, 404 unknown, 429 limited. */
  async handleZoneOgImage(
    req: IncomingMessage,
    res: ServerResponse,
    rawName: string,
  ): Promise<void> {
    const ip = clientIp(req);
    const rate = this.checkRate(ip);
    if (!rate.ok) {
      res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
      writePlain(res, 429, 'rate limited');
      return;
    }
    const decoded = safeDecode(rawName);
    if (!decoded || !NAME_PATTERN.test(decoded)) {
      writePlain(res, 404, 'not found');
      return;
    }
    const zone = this.byKey.get(decoded.toLowerCase());
    if (!zone) {
      writePlain(res, 404, 'not found');
      return;
    }
    const canonical = zone.name.toLowerCase();
    const matching = this.collectMoments(zone.name);
    const top = this.collectTopCharacters(matching);
    let png: Buffer;
    let cacheHit = false;
    const t0 = this.now();
    const cached = await this.cache.get(canonical);
    if (cached) {
      png = cached;
      cacheHit = true;
    } else {
      png = composeZoneOg({
        zone: zone.name,
        headline: matching[0]?.headline ?? '',
        momentsCount: matching.length,
        participants: top.map((p) => ({ name: p.name, named: p.named, color: p.color })),
      });
      // Fire-and-forget — never block the response on the cache write.
      void this.cache.set(canonical, png).catch((err) => {
        this.log('warn', 'zone.og.cache.set.error', {
          zone: canonical,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(png.length),
      // Zone OG can drift as new moments land; one-minute browser cache is
      // enough to spare crawlers without freezing stale state.
      'cache-control': 'public, max-age=60',
      'x-og-cache': cacheHit ? 'hit' : 'miss',
    });
    res.end(png);
    this.log('info', 'zone.og.render', {
      zone: canonical,
      cacheHit,
      bytes: png.length,
      ms: this.now() - t0,
    });
    this.onOgRender?.(canonical, ip);
  }

  private renderZoneHtml(zone: Zone, canonical: string): string {
    const matching = this.collectMoments(zone.name);
    const top = this.collectTopCharacters(matching);
    const objects = this.collectAffordances(zone.name);
    const canonicalUrl = this.buildCanonicalUrl(`/zone/${canonical}`);
    const ogImageUrl = this.buildCanonicalUrl(`/zone/${canonical}/og.png`);
    const description = buildZoneDescription(zone.name, matching);
    return renderZoneHtmlBody({
      zone,
      canonical: canonicalUrl,
      ogImageUrl,
      ogDescription: description,
      moments: matching,
      topCharacters: top,
      affordances: objects,
      simSpeed: this.simSpeed,
    });
  }

  private buildCanonicalUrl(path: string): string {
    if (this.publicBaseUrl) return `${this.publicBaseUrl}${path}`;
    return path;
  }

  private collectMoments(zoneName: string): MomentRecord[] {
    const all = this.moments.list();
    const out: MomentRecord[] = [];
    // Walk newest → oldest so we can bail out at maxMoments without sorting
    // the whole LRU. MomentStore preserves insertion order (oldest first).
    for (let i = all.length - 1; i >= 0; i--) {
      const rec = all[i]!;
      if (rec.zone === zoneName) {
        out.push(rec);
        if (out.length >= this.maxMoments) break;
      }
    }
    return out;
  }

  private collectTopCharacters(records: MomentRecord[]): TopCharacter[] {
    const byId = new Map<string, TopCharacter>();
    // Stable secondary order: first-seen-index ensures deterministic output
    // when two characters tie on appearance count.
    const firstSeen = new Map<string, number>();
    let order = 0;
    for (const rec of records) {
      for (const p of rec.participants) {
        const existing = byId.get(p.id);
        if (existing) {
          existing.appearances += 1;
          continue;
        }
        firstSeen.set(p.id, order++);
        byId.set(p.id, {
          id: p.id,
          name: p.name,
          named: p.named,
          color: p.color,
          appearances: 1,
        });
      }
    }
    const arr = [...byId.values()];
    arr.sort((a, b) => {
      if (a.appearances !== b.appearances) return b.appearances - a.appearances;
      return (firstSeen.get(a.id) ?? 0) - (firstSeen.get(b.id) ?? 0);
    });
    if (arr.length > this.topCharacters) arr.length = this.topCharacters;
    return arr;
  }

  private collectAffordances(zoneName: string): AffordanceRow[] {
    if (!this.listObjectsInZone) return [];
    const objs = this.listObjectsInZone(zoneName);
    return objs.map((o) => ({
      id: o.id,
      label: o.label,
      affordance: o.affordance ?? null,
      glyph: o.affordance ? AFFORDANCE_GLYPH[o.affordance] : '◇',
    }));
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

/**
 * Build the OG/page meta description. Empty zones fall back to a quiet
 * "nothing yet" line so social-card crawlers always get something useful.
 */
export function buildZoneDescription(zoneName: string, moments: MomentRecord[], max = 160): string {
  if (moments.length === 0) {
    return `Nothing has happened in ${zoneName} yet on TinyHouse.`;
  }
  const parts: string[] = [`${moments.length} recent moments in ${zoneName}`];
  if (moments[0]) parts.push(moments[0].headline);
  return truncate(parts.join(' · '), max);
}

interface RenderInput {
  zone: Zone;
  canonical: string;
  ogImageUrl: string;
  ogDescription: string;
  moments: MomentRecord[];
  topCharacters: TopCharacter[];
  affordances: AffordanceRow[];
  simSpeed: number;
}

function renderZoneHtmlBody(input: RenderInput): string {
  const zoneName = input.zone.name;
  const title = `${escapeHtml(zoneName)} — Tinyhouse`;
  const description = escapeHtml(input.ogDescription);
  const canonical = escapeHtml(input.canonical);
  const ogImage = escapeHtml(input.ogImageUrl);
  const charactersHtml = renderCharacterStrip(input.topCharacters);
  const affordancesHtml = renderAffordancesRow(input.affordances);
  const momentsHtml = renderMomentsList(zoneName, input.moments, input.simSpeed);
  const tile = `${input.zone.width}×${input.zone.height} @ (${input.zone.x},${input.zone.y})`;

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
    h1 { font-size: 28px; line-height: 1.2; margin: 0 0 6px; color: #e7e5ee; text-transform: capitalize; }
    .sub { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #8888aa; margin: 0 0 24px; }
    section { margin-bottom: 32px; }
    section h2 { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: #8888aa; margin: 0 0 12px; font-weight: 500; }
    .empty { font-size: 12px; color: #55556a; padding: 12px 0; font-style: italic; }
    .characters { display: flex; flex-wrap: wrap; gap: 8px; }
    .char-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,0.05); font-size: 12px; color: #e7e5ee; }
    .char-chip .sw { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .char-chip .star { color: #f5c97a; margin-right: 2px; }
    .char-chip .count { color: #8888aa; font-family: ui-monospace, Menlo, monospace; font-size: 11px; margin-left: 4px; }
    .affordances { display: flex; flex-wrap: wrap; gap: 8px; }
    .aff-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: rgba(185,176,220,0.10); color: #d6d0e6; font-size: 12px; }
    .aff-chip .glyph { font-size: 14px; }
    .aff-chip .kind { color: #8888aa; font-family: ui-monospace, Menlo, monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
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
      <span>tinyhouse · zone</span>
      <a href="/">live sim →</a>
    </header>
    <h1>${escapeHtml(zoneName)}</h1>
    <div class="sub">${escapeHtml(tile)} · <a href="/moments?zone=${escapeHtml(encodeURIComponent(zoneName))}">all moments in ${escapeHtml(zoneName)}</a></div>
    <section>
      <h2>Top characters</h2>
      ${charactersHtml}
    </section>
    <section>
      <h2>Affordance objects</h2>
      ${affordancesHtml}
    </section>
    <section>
      <h2>Recent moments</h2>
      ${momentsHtml}
    </section>
    <footer>zone · ${escapeHtml(zoneName)} · <a href="/moments">all moments</a> · <a href="/digest/today">today's digest</a></footer>
  </main>
</body>
</html>`;
}

function renderCharacterStrip(top: TopCharacter[]): string {
  if (top.length === 0) {
    return '<div class="empty">No characters have appeared in this zone yet.</div>';
  }
  return `<div class="characters">${top
    .map((p) => {
      const color = p.color ?? '#b9b0dc';
      const star = p.named ? '<span class="star">★</span>' : '';
      const inner = `<span class="sw" style="background:${escapeHtml(color)}"></span>${star}${escapeHtml(p.name)}<span class="count">×${p.appearances}</span>`;
      return p.named
        ? `<a class="char-chip" href="/character/${escapeHtml(p.id)}">${inner}</a>`
        : `<span class="char-chip">${inner}</span>`;
    })
    .join('')}</div>`;
}

function renderAffordancesRow(rows: AffordanceRow[]): string {
  if (rows.length === 0) {
    return '<div class="empty">No affordance objects in this zone right now.</div>';
  }
  return `<div class="affordances">${rows
    .map((r) => {
      const kind = r.affordance ? `<span class="kind">${escapeHtml(r.affordance)}</span>` : '';
      return `<span class="aff-chip"><span class="glyph">${escapeHtml(r.glyph)}</span>${escapeHtml(r.label)}${kind}</span>`;
    })
    .join('')}</div>`;
}

function renderMomentsList(zoneName: string, records: MomentRecord[], simSpeed: number): string {
  if (records.length === 0) {
    return `<div class="empty">Nothing has happened in ${escapeHtml(zoneName)} yet — check back after the agents wander through.</div>`;
  }
  return records
    .map((rec) => {
      const day = simDay(rec.simTime);
      const clock = rec.clock ?? deriveWorldClock(rec.simTime, simSpeed);
      const dayLine = `day ${day} · ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
      const isGroup = (rec.variant ?? 'conversation') === 'group';
      const participantHtml = renderParticipants(rec.participants);
      const badges: string[] = [];
      if (isGroup) badges.push('<span class="badge" data-kind="group">group</span>');
      const link = `/moment/${escapeHtml(rec.id)}`;
      return `<article class="moment-row"><span class="day">${escapeHtml(dayLine)}</span><div class="body"><div class="headline"><a href="${link}">${escapeHtml(rec.headline)}</a></div><div class="meta-line">${participantHtml}${badges.length ? ` · ${badges.join(' ')}` : ''}</div></div></article>`;
    })
    .join('');
}

function renderParticipants(parts: MomentParticipant[]): string {
  return parts
    .map((p) =>
      p.named
        ? `<a href="/character/${escapeHtml(p.id)}">${escapeHtml(p.name)}</a>`
        : escapeHtml(p.name),
    )
    .join(', ');
}

function notFoundPage(name: string, zones: Zone[]): string {
  const list = zones
    .map(
      (z) =>
        `<li><a href="/zone/${escapeHtml(z.name.toLowerCase())}">${escapeHtml(z.name)}</a></li>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>zone not found — tinyhouse</title>
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
    <h1>zone not found</h1>
    <p>No zone matched <code>${escapeHtml(name)}</code>.</p>
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

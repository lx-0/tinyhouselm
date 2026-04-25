import type { IncomingMessage, ServerResponse } from 'node:http';
import { type MomentRecord, type SimTime, deriveWorldClock } from '@tina/shared';
import {
  type ArcLabel,
  type NamedPersona,
  type RelationshipStore,
  type ScheduleEntry,
  simDay,
} from '@tina/sim';
import type { MomentStore } from './moments.js';
import type { ObservabilityAffordanceEvent, ObservabilityStore } from './observability.js';

export interface CharacterRouteOptions {
  /** Authored named-persona roster — drives /character/:name resolution. */
  named: NamedPersona[];
  /** Recent moments source. */
  moments: MomentStore;
  /** Optional relationships store — drives the "current arcs" row. */
  relationships?: RelationshipStore | null;
  /** Affordance ring buffer — drives the "recent affordance uses" list. */
  observability: ObservabilityStore;
  /** Sim speed (seconds-per-real-second) for deriving WorldClock from a SimTime. */
  simSpeed: number;
  /**
   * Public base URL used for canonical/og:url meta. Same semantics as
   * MomentRoutes — falls back to relative paths in dev.
   */
  publicBaseUrl?: string | null;
  /** Per-IP page hits per minute. Default 60 — same ceiling as `/moment/:id`. */
  perIpPerMin?: number;
  /** Global ceiling per minute. Default 600. */
  globalPerMin?: number;
  now?: () => number;
  /** How many recent moments to render at most. Default 20. */
  maxMoments?: number;
  /** How many recent affordance uses to render at most. Default 10. */
  maxAffordances?: number;
  /** Top-N arcs to surface in the header strip. Default 4. */
  topArcs?: number;
}

/**
 * Result returned to the server so it can decide whether to bump the
 * sticky-metrics view counter and emit a Set-Cookie. We separate that from
 * `ServerResponse.writeHead` so the server keeps ownership of the visitor
 * cookie path (matches how `/moment/:id` is wired).
 */
export interface CharacterPageOutcome {
  status: number;
  /** Canonical id of the resolved persona, only set on a 200 hit. */
  personaId: string | null;
  /** Original name as it appeared in the manifest, for the visitor counter. */
  personaName: string | null;
  /** True when the request was rejected by the per-IP / global limiter. */
  rateLimited: boolean;
}

interface Bucket {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

const ARC_GLYPHS: Record<ArcLabel, string> = {
  new: '🌀',
  warming: '🌱',
  cooling: '🥶',
  estranged: '🔕',
  steady: '💤',
};

interface ArcRow {
  other: { id: string; name: string };
  label: ArcLabel;
  affinity: number;
  sharedConversationCount: number;
  lastInteractionSim: SimTime;
}

/**
 * Build the case-insensitive name resolver shared by `/character/:name`
 * (TINA-482) and `/moments?character=` (TINA-544). Maps manifest id, display-
 * name slug ("Mei Tanaka" → "mei-tanaka"), and first-name to the named
 * persona. Manifest id wins on collision.
 */
export function buildNamedResolver(named: NamedPersona[]): Map<string, NamedPersona> {
  const byKey = new Map<string, NamedPersona>();
  for (const persona of named) {
    const idKey = persona.manifest.id.toLowerCase();
    byKey.set(idKey, persona);
    const slug = persona.manifest.name.toLowerCase().replace(/\s+/g, '-');
    if (!byKey.has(slug)) byKey.set(slug, persona);
    const first = persona.manifest.name.split(/\s+/, 1)[0]?.toLowerCase();
    if (first && !byKey.has(first)) byKey.set(first, persona);
  }
  return byKey;
}

export class CharacterRoutes {
  private readonly named: NamedPersona[];
  private readonly byKey: Map<string, NamedPersona>;
  private readonly moments: MomentStore;
  private readonly relationships: RelationshipStore | null;
  private readonly observability: ObservabilityStore;
  private readonly simSpeed: number;
  private readonly publicBaseUrl: string | null;
  private readonly perIpRate: number;
  private readonly globalRate: number;
  private readonly now: () => number;
  private readonly maxMoments: number;
  private readonly maxAffordances: number;
  private readonly topArcs: number;
  private readonly perIp = new Map<string, Bucket>();
  private readonly globalBucket: Bucket = { count: 0, windowStart: 0 };

  constructor(opts: CharacterRouteOptions) {
    this.named = opts.named;
    this.moments = opts.moments;
    this.relationships = opts.relationships ?? null;
    this.observability = opts.observability;
    this.simSpeed = opts.simSpeed;
    this.publicBaseUrl = (opts.publicBaseUrl ?? null)?.replace(/\/+$/, '') ?? null;
    this.perIpRate = opts.perIpPerMin ?? 60;
    this.globalRate = opts.globalPerMin ?? 600;
    this.now = opts.now ?? (() => Date.now());
    this.maxMoments = Math.max(1, opts.maxMoments ?? 20);
    this.maxAffordances = Math.max(1, opts.maxAffordances ?? 10);
    this.topArcs = Math.max(1, opts.topArcs ?? 4);
    this.byKey = buildNamedResolver(this.named);
  }

  /**
   * GET /character/:name. Public, no auth. Returns:
   *  - 200 + HTML on a known character (case-insensitive)
   *  - 404 + HTML when the name doesn't resolve, or fails the safety pattern
   *  - 429 + small HTML body when the IP/global rate is exceeded
   * Counter / cookie work happens server-side based on `outcome.personaId`.
   */
  handleCharacterPage(
    req: IncomingMessage,
    res: ServerResponse,
    rawName: string,
    canonicalPath?: string,
  ): CharacterPageOutcome {
    const ip = clientIp(req);
    const rate = this.checkRate(ip);
    if (!rate.ok) {
      res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
      writeHtml(res, 429, simpleErrorPage('slow down', 'Too many character lookups from this IP.'));
      return { status: 429, personaId: null, personaName: null, rateLimited: true };
    }
    const decoded = safeDecode(rawName);
    if (!decoded || !NAME_PATTERN.test(decoded)) {
      writeHtml(res, 404, notFoundPage(decoded ?? rawName, this.named));
      return { status: 404, personaId: null, personaName: null, rateLimited: false };
    }
    const persona = this.byKey.get(decoded.toLowerCase());
    if (!persona) {
      writeHtml(res, 404, notFoundPage(decoded, this.named));
      return { status: 404, personaId: null, personaName: null, rateLimited: false };
    }
    const html = this.renderCharacterHtml(
      persona,
      this.buildCanonicalUrl(canonicalPath ?? `/character/${persona.manifest.id}`),
    );
    writeHtml(res, 200, html);
    return {
      status: 200,
      personaId: persona.manifest.id,
      personaName: persona.manifest.name,
      rateLimited: false,
    };
  }

  private renderCharacterHtml(persona: NamedPersona, canonical: string): string {
    const recentMoments = this.collectMoments(persona.manifest.id);
    const arcs = this.collectArcs(persona.manifest.id);
    const affordances = this.observability.recentAffordancesFor(
      persona.manifest.id,
      this.maxAffordances,
    );
    const todaysSchedule = this.collectTodaySchedule(persona.scheduleByHour);
    const ogDescription = buildCharacterOgDescription(persona, arcs, recentMoments);
    return renderCharacterHtmlBody(persona, {
      canonical,
      arcs,
      moments: recentMoments,
      affordances,
      schedule: todaysSchedule,
      simSpeed: this.simSpeed,
      ogDescription,
    });
  }

  private buildCanonicalUrl(path: string): string {
    if (this.publicBaseUrl) return `${this.publicBaseUrl}${path}`;
    return path;
  }

  private collectMoments(id: string): MomentRecord[] {
    const all = this.moments.list();
    const mine: MomentRecord[] = [];
    for (const rec of all) {
      if (rec.participants.some((p) => p.id === id)) mine.push(rec);
    }
    // MomentStore preserves insertion order (oldest first), so reverse before
    // truncating to surface the freshest hits.
    mine.reverse();
    if (mine.length > this.maxMoments) mine.length = this.maxMoments;
    return mine;
  }

  private collectArcs(id: string): ArcRow[] {
    if (!this.relationships) return [];
    const namedIds = new Set(this.named.map((p) => p.manifest.id));
    const out: ArcRow[] = [];
    for (const pair of this.relationships.list()) {
      if (pair.a !== id && pair.b !== id) continue;
      const otherId = pair.a === id ? pair.b : pair.a;
      // Skip pairs where the counterparty isn't a named character — the
      // profile page is only meant to surface authored arcs.
      if (!namedIds.has(otherId)) continue;
      const other = this.named.find((p) => p.manifest.id === otherId);
      if (!other) continue;
      out.push({
        other: { id: other.manifest.id, name: other.manifest.name },
        label: pair.arcLabel,
        affinity: pair.affinity,
        sharedConversationCount: pair.sharedConversationCount,
        lastInteractionSim: pair.lastInteractionSim,
      });
    }
    // "4 strongest" — rank by absolute affinity, then by how many closes the
    // pair has logged so steady high-volume relationships beat noisy ones.
    out.sort((x, y) => {
      const dx = Math.abs(y.affinity) - Math.abs(x.affinity);
      if (dx !== 0) return dx;
      const dc = y.sharedConversationCount - x.sharedConversationCount;
      if (dc !== 0) return dc;
      return y.lastInteractionSim - x.lastInteractionSim;
    });
    if (out.length > this.topArcs) out.length = this.topArcs;
    return out;
  }

  private collectTodaySchedule(scheduleByHour: NamedPersona['scheduleByHour']): ScheduleEntry[] {
    if (!scheduleByHour) return [];
    return [...scheduleByHour.values()].sort((a, b) => a.hour - b.hour);
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

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function affordanceGlyph(affordance: string): string {
  switch (affordance) {
    case 'sit':
      return '🪑';
    case 'play_music':
      return '🎵';
    case 'eat':
      return '🍱';
    default:
      return '◇';
  }
}

function affordanceLabel(affordance: string): string {
  switch (affordance) {
    case 'sit':
      return 'sat at';
    case 'play_music':
      return 'played';
    case 'eat':
      return 'ate at';
    default:
      return affordance.replace(/_/g, ' ');
  }
}

/** Build the OG description from the strongest arc + the freshest moment. */
export function buildCharacterOgDescription(
  persona: NamedPersona,
  arcs: ArcRow[],
  moments: MomentRecord[],
  max = 160,
): string {
  const parts: string[] = [];
  if (arcs.length > 0) {
    const a = arcs[0]!;
    parts.push(`${a.label} with ${a.other.name}`);
  }
  if (moments.length > 0) {
    parts.push(moments[0]!.headline);
  }
  if (parts.length === 0) parts.push(persona.manifest.bio);
  return truncate(parts.join(' · '), max);
}

interface RenderInput {
  canonical: string;
  arcs: ArcRow[];
  moments: MomentRecord[];
  affordances: ObservabilityAffordanceEvent[];
  schedule: ScheduleEntry[];
  simSpeed: number;
  ogDescription: string;
}

function renderCharacterHtmlBody(persona: NamedPersona, input: RenderInput): string {
  const m = persona.manifest;
  const title = `${escapeHtml(m.name)} — Tinyhouse`;
  const description = escapeHtml(input.ogDescription);
  const canonical = escapeHtml(input.canonical);
  const bodyColor = escapeHtml(m.glyph.color);
  const accentColor = escapeHtml(m.glyph.accent);
  const subtitleParts: string[] = [];
  if (m.occupation) subtitleParts.push(m.occupation);
  if (m.age !== undefined) subtitleParts.push(`age ${m.age}`);
  const subtitle = subtitleParts.length
    ? `<div class="subtitle">${escapeHtml(subtitleParts.join(' · '))}</div>`
    : '';

  const scheduleHtml = renderScheduleStrip(input.schedule);
  const arcsHtml = renderArcsRow(input.arcs);
  const momentsHtml = renderMomentsList(persona.manifest.id, input.moments, input.simSpeed);
  const affordancesHtml = renderAffordancesList(input.affordances, input.simSpeed);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <meta name="description" content="${description}" />
  <meta property="og:type" content="profile" />
  <meta property="og:title" content="${escapeHtml(m.name)} — Tinyhouse" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:site_name" content="tinyhouse" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${escapeHtml(m.name)} — Tinyhouse" />
  <meta name="twitter:description" content="${description}" />
  <link rel="canonical" href="${canonical}" />
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; padding: 0; background: #0f0d15; color: #e7e5ee; font-family: -apple-system, system-ui, Segoe UI, sans-serif; }
    main { max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; }
    a { color: #b9b0dc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    header.top { display: flex; justify-content: space-between; align-items: center; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: #8888aa; margin-bottom: 18px; }
    header.profile { display: flex; gap: 16px; align-items: center; margin: 8px 0 24px; }
    .glyph { width: 56px; height: 56px; border-radius: 50%; background: ${bodyColor}; box-shadow: 0 0 0 3px ${accentColor}; flex-shrink: 0; position: relative; }
    .glyph .star { position: absolute; top: -4px; right: -4px; color: #f5c97a; font-size: 14px; }
    .name { font-size: 24px; font-weight: 600; margin: 0; line-height: 1.2; }
    .subtitle { font-size: 12px; color: #b9b0dc; letter-spacing: 0.05em; text-transform: lowercase; margin-top: 4px; }
    .bio { font-size: 14px; line-height: 1.55; color: #d6d0e6; max-width: 560px; margin: 0 0 28px; }
    section { margin-bottom: 32px; }
    section h2 { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: #8888aa; margin: 0 0 12px; font-weight: 500; }
    .schedule { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; font-size: 10px; }
    .schedule .slot { padding: 6px 4px; border-radius: 4px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); text-align: center; }
    .schedule .slot[data-zone="home"] { background: rgba(185,176,220,0.12); border-color: rgba(185,176,220,0.25); }
    .schedule .slot[data-zone="work"] { background: rgba(140,200,150,0.12); border-color: rgba(140,200,150,0.25); }
    .schedule .slot[data-zone="cafe"] { background: rgba(245,201,122,0.14); border-color: rgba(245,201,122,0.28); }
    .schedule .slot[data-zone="park"] { background: rgba(150,210,180,0.14); border-color: rgba(150,210,180,0.28); }
    .schedule .slot .hour { color: #8888aa; font-family: ui-monospace, Menlo, monospace; }
    .schedule .slot .zone { color: #d6d0e6; text-transform: capitalize; margin-top: 2px; }
    .schedule .slot .zone.empty { color: #55556a; }
    .arcs { display: flex; flex-wrap: wrap; gap: 8px; }
    .arc-chip { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 999px; font-size: 12px; background: rgba(185,176,220,0.10); color: #d6d0e6; }
    .arc-chip[data-arc="warming"] { background: rgba(140, 200, 150, 0.14); color: #c8e8cf; }
    .arc-chip[data-arc="cooling"] { background: rgba(150, 180, 230, 0.14); color: #cddaf0; }
    .arc-chip[data-arc="estranged"] { background: rgba(220, 140, 140, 0.14); color: #f0c7c7; }
    .arc-chip[data-arc="steady"] { background: rgba(200, 200, 200, 0.10); color: #cccccc; }
    .arc-chip[data-arc="new"] { background: rgba(245, 201, 122, 0.14); color: #f0d8a8; }
    .arc-chip .glyph { width: auto; height: auto; background: none; box-shadow: none; }
    .empty { font-size: 12px; color: #55556a; padding: 12px 0; font-style: italic; }
    .moment-row { display: flex; gap: 12px; align-items: baseline; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .moment-row:last-child { border-bottom: none; }
    .moment-row .day { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #8888aa; flex-shrink: 0; min-width: 70px; }
    .moment-row .headline { font-size: 13px; line-height: 1.4; flex: 1; color: #e7e5ee; }
    .moment-row .badges { display: inline-flex; gap: 6px; align-items: center; }
    .moment-row .badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: rgba(185,176,220,0.18); color: #d6d0e6; letter-spacing: 0.04em; text-transform: uppercase; }
    .moment-row .zone { font-size: 11px; color: #8888aa; flex-shrink: 0; }
    .aff-row { display: flex; gap: 10px; align-items: baseline; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 13px; }
    .aff-row:last-child { border-bottom: none; }
    .aff-row .glyph { width: auto; height: auto; background: none; box-shadow: none; font-size: 14px; }
    .aff-row .day { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #8888aa; flex-shrink: 0; min-width: 70px; }
    .aff-row .text { flex: 1; }
    .aff-row .zone { font-size: 11px; color: #8888aa; }
    footer { margin-top: 40px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #55556a; }
  </style>
</head>
<body>
  <main>
    <header class="top">
      <span>tinyhouse · character</span>
      <a href="/">live sim →</a>
    </header>
    <header class="profile">
      <div class="glyph"><span class="star">★</span></div>
      <div>
        <h1 class="name">${escapeHtml(m.name)}</h1>
        ${subtitle}
      </div>
    </header>
    <p class="bio">${escapeHtml(m.bio)}</p>
    <section>
      <h2>Today's schedule</h2>
      ${scheduleHtml}
    </section>
    <section>
      <h2>Current arcs</h2>
      ${arcsHtml}
    </section>
    <section>
      <h2>Recent moments</h2>
      ${momentsHtml}
    </section>
    <section>
      <h2>Recent affordance uses</h2>
      ${affordancesHtml}
    </section>
    <footer>character id · ${escapeHtml(m.id)}</footer>
  </main>
</body>
</html>`;
}

function renderScheduleStrip(schedule: ScheduleEntry[]): string {
  if (schedule.length === 0) {
    return '<div class="empty">No authored schedule.</div>';
  }
  const byHour = new Map(schedule.map((e) => [e.hour, e]));
  const cells: string[] = [];
  for (let h = 0; h < 24; h++) {
    const e = byHour.get(h);
    const zone = e?.zone ?? null;
    const intent = e?.intent ?? '';
    const zoneText = zone
      ? `<div class="zone">${escapeHtml(zone)}</div>`
      : '<div class="zone empty">—</div>';
    const titleAttr = intent ? ` title="${escapeHtml(intent)}"` : '';
    cells.push(
      `<div class="slot" data-zone="${zone ? escapeHtml(zone) : ''}"${titleAttr}><div class="hour">${formatHour(h)}</div>${zoneText}</div>`,
    );
  }
  return `<div class="schedule">${cells.join('')}</div>`;
}

function renderArcsRow(arcs: ArcRow[]): string {
  if (arcs.length === 0) {
    return '<div class="empty">No tracked relationships yet.</div>';
  }
  return `<div class="arcs">${arcs
    .map(
      (a) =>
        `<span class="arc-chip" data-arc="${escapeHtml(a.label)}"><span class="glyph">${escapeHtml(ARC_GLYPHS[a.label])}</span><span>${escapeHtml(a.label)} · ${escapeHtml(a.other.name)}</span></span>`,
    )
    .join('')}</div>`;
}

function renderMomentsList(selfId: string, moments: MomentRecord[], simSpeed: number): string {
  if (moments.length === 0) {
    return '<div class="empty">No recent moments yet — check back after they bump into someone.</div>';
  }
  return moments
    .map((rec) => {
      const day = simDay(rec.simTime);
      const clock = rec.clock ?? deriveWorldClock(rec.simTime, simSpeed);
      const dayLine = `day ${day} · ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
      const isGroup = rec.variant === 'group';
      const others = rec.participants.filter((p) => p.id !== selfId);
      const otherNames = others.map((p) => escapeHtml(p.name)).join(', ');
      const groupBadge = isGroup ? `<span class="badge">group</span>` : '';
      const headline = `${escapeHtml(rec.headline)}${otherNames && isGroup ? ` <span class="zone">· with ${otherNames}</span>` : ''}`;
      const zone = rec.zone ? `<span class="zone">${escapeHtml(rec.zone)}</span>` : '';
      return `<div class="moment-row"><span class="day">${escapeHtml(dayLine)}</span><span class="headline"><a href="/moment/${escapeHtml(rec.id)}">${headline}</a> <span class="badges">${groupBadge}</span></span>${zone}</div>`;
    })
    .join('');
}

function renderAffordancesList(
  affordances: ObservabilityAffordanceEvent[],
  simSpeed: number,
): string {
  if (affordances.length === 0) {
    return '<div class="empty">No affordance uses tracked yet this session.</div>';
  }
  return affordances
    .map((a) => {
      const day = simDay(a.simTime);
      const clock = deriveWorldClock(a.simTime, simSpeed);
      const dayLine = `day ${day} · ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
      const verb = affordanceLabel(a.affordance);
      const zone = a.zone ? ` <span class="zone">· ${escapeHtml(a.zone)}</span>` : '';
      return `<div class="aff-row"><span class="glyph">${escapeHtml(affordanceGlyph(a.affordance))}</span><span class="day">${escapeHtml(dayLine)}</span><span class="text">${escapeHtml(verb)} ${escapeHtml(a.label)}${zone}</span></div>`;
    })
    .join('');
}

function notFoundPage(name: string, named: NamedPersona[]): string {
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
  <title>character not found — tinyhouse</title>
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
    <h1>character not found</h1>
    <p>No named character matched <code>${escapeHtml(name)}</code>.</p>
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

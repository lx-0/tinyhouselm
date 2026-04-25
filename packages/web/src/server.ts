import { readFile } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Delta, type Vec2, deriveWorldClock } from '@tina/shared';
import {
  type NudgeDirection,
  ParaMemory,
  RelationshipStore,
  Runtime,
  type RuntimeEvent,
  SimulationClock,
  World,
  buildStarterTown,
  createGatewaySynthesizer,
  createLlmSynthesizer,
  homeForAgent,
  loadAllPersonas,
  nearestWalkable,
  seedNamedPersonaMemories,
  seededRng,
} from '@tina/sim';
import { build as esbuild } from 'esbuild';
import { createBudget, resolveBudgetCap } from './budget.js';
import { CharacterRoutes } from './character-routes.js';
import { InterventionHandlers } from './intervention.js';
import { log } from './logger.js';
import { MomentRoutes } from './moment-routes.js';
import { MomentStore } from './moments.js';
import { ObservabilityStore } from './observability.js';
import { mergeReflectionOptions, resolveReflectionTunables } from './reflection-config.js';
import {
  type SnapshotScheduler,
  type SnapshotStatus,
  readSnapshot,
  scheduleSnapshots,
} from './snapshot-store.js';
import { buildSnapshot } from './snapshot.js';
import {
  StickyMetrics,
  buildVisitorSetCookie,
  generateVisitorId,
  parseVisitorCookie,
} from './sticky-metrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const PACKAGE_ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = resolve(PACKAGE_ROOT, 'public');

const PORT = Number(process.env.PORT ?? 5173);
const SEED = Number(process.env.SEED ?? 42);
const TICK_MS = Number(process.env.TICK_MS ?? 200);
const SIM_SPEED = Number(process.env.SIM_SPEED ?? 30);
// Starting wall-clock hour of day for the simulation (e.g. 6 = boot at 06:00).
// Defaults to 6am so demos open on morning routines rather than midnight.
const SIM_START_HOUR = Number(process.env.SIM_START_HOUR ?? 6);
// How often to emit a structured telemetry heartbeat log line (ticks).
const HEARTBEAT_LOG_TICKS = Number(process.env.HEARTBEAT_LOG_TICKS ?? 300);

// Snapshot / resume configuration (TINA-24).
const SIM_SNAPSHOT_ENABLED = (process.env.SIM_SNAPSHOT_ENABLED ?? 'true').toLowerCase() !== 'false';
const SIM_SNAPSHOT_EVERY_TICKS = Number(process.env.SIM_SNAPSHOT_EVERY_TICKS ?? 300);
const SIM_SNAPSHOT_DIR_ENV = process.env.SIM_SNAPSHOT_DIR ?? './data/snapshots';
const SIM_SNAPSHOT_DIR = isAbsolute(SIM_SNAPSHOT_DIR_ENV)
  ? SIM_SNAPSHOT_DIR_ENV
  : resolve(process.cwd(), SIM_SNAPSHOT_DIR_ENV);

// Moment / share configuration (TINA-29).
const MOMENT_STORE_ENABLED = (process.env.MOMENT_STORE_ENABLED ?? 'true').toLowerCase() !== 'false';
const MOMENT_STORE_DIR_ENV = process.env.MOMENT_STORE_DIR ?? './data/moments';
const MOMENT_STORE_DIR = isAbsolute(MOMENT_STORE_DIR_ENV)
  ? MOMENT_STORE_DIR_ENV
  : resolve(process.cwd(), MOMENT_STORE_DIR_ENV);
const MOMENT_STORE_MAX = Number(process.env.MOMENT_STORE_MAX ?? 500);
const MOMENT_PUBLIC_BASE_URL = process.env.MOMENT_PUBLIC_BASE_URL || null;

// Share-loop return-rate instrumentation (TINA-145).
const STICKY_METRICS_ENABLED =
  (process.env.STICKY_METRICS_ENABLED ?? 'true').toLowerCase() !== 'false';
const STICKY_METRICS_DIR_ENV = process.env.STICKY_METRICS_DIR ?? './data/sticky-metrics';
const STICKY_METRICS_DIR = isAbsolute(STICKY_METRICS_DIR_ENV)
  ? STICKY_METRICS_DIR_ENV
  : resolve(process.cwd(), STICKY_METRICS_DIR_ENV);

// Named-character relationship arcs (TINA-207).
const RELATIONSHIPS_ENABLED =
  (process.env.RELATIONSHIPS_ENABLED ?? 'true').toLowerCase() !== 'false';
const RELATIONSHIPS_DIR_ENV = process.env.RELATIONSHIPS_DIR ?? './data/relationships';
const RELATIONSHIPS_DIR = isAbsolute(RELATIONSHIPS_DIR_ENV)
  ? RELATIONSHIPS_DIR_ENV
  : resolve(process.cwd(), RELATIONSHIPS_DIR_ENV);
const RELATIONSHIPS_MAX = Number(process.env.RELATIONSHIPS_MAX ?? 200);

// Multi-character group co-presence moments (TINA-345).
const GROUP_MOMENTS_ENABLED =
  (process.env.GROUP_MOMENTS_ENABLED ?? 'true').toLowerCase() !== 'false';
const GROUP_MOMENTS_MIN_PARTICIPANTS = Number(process.env.GROUP_MOMENTS_MIN_PARTICIPANTS ?? 3);
const GROUP_MOMENTS_MIN_CONSECUTIVE_TICKS = Number(
  process.env.GROUP_MOMENTS_MIN_CONSECUTIVE_TICKS ?? 3,
);
const GROUP_MOMENTS_DEDUP_MAX = Number(process.env.GROUP_MOMENTS_DEDUP_MAX ?? 512);

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function timingSafeStrEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function headerFirst(h: string | string[] | undefined): string | null {
  if (!h) return null;
  return Array.isArray(h) ? (h[0] ?? null) : h;
}

function requestIp(req: IncomingMessage): string {
  const forwarded = headerFirst(req.headers['x-forwarded-for']);
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? '';
}

/**
 * Shared admin gate for non-intervention routes. Same semantics as
 * InterventionHandlers.checkAuth: token required when ADMIN_TOKEN is set,
 * otherwise localhost-only.
 */
function checkAdmin(
  req: IncomingMessage,
  token: string | null,
): { ok: true } | { ok: false; status: number; error: string } {
  if (token) {
    const provided = headerFirst(req.headers['x-admin-token']);
    if (provided && timingSafeStrEq(provided, token)) return { ok: true };
    return { ok: false, status: 401, error: 'admin token required' };
  }
  const ip = requestIp(req);
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return { ok: true };
  return { ok: false, status: 401, error: 'admin token required' };
}

async function bundleClient(entryFile: string): Promise<string> {
  const entry = resolve(__dirname, 'client', entryFile);
  const result = await esbuild({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    target: ['es2022'],
    platform: 'browser',
    write: false,
    sourcemap: 'inline',
    logLevel: 'warning',
  });
  const out = result.outputFiles[0];
  if (!out) throw new Error(`client bundle for ${entryFile} produced no output`);
  return out.text;
}

// Boot-phase timer. Logs `web.boot.step` per phase so a slow boot leaves
// breadcrumbs even when we have no external access to the running container.
// See TINA-31 for the recurring "boot got stuck somewhere — where?" question.
async function timedBootStep<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    log.info('web.boot.step', { step, ms: Math.round(performance.now() - start) });
    return result;
  } catch (err) {
    log.error('web.boot.step.error', {
      step,
      ms: Math.round(performance.now() - start),
      err,
    });
    throw err;
  }
}

async function main(): Promise<void> {
  const bootStart = performance.now();
  const budget = createBudget(resolveBudgetCap());
  log.info('web.boot.start', { port: PORT, seed: SEED, tickMs: TICK_MS, simSpeed: SIM_SPEED });

  const clientJs = await timedBootStep('bundle_client.main', () => bundleClient('main.ts'));
  const adminJs = await timedBootStep('bundle_client.admin', () => bundleClient('admin.ts'));

  const agentsDir = resolve(REPO_ROOT, 'world', 'agents');
  const namedDir = resolve(REPO_ROOT, 'packages', 'sim', 'personas', 'named');
  const { skills, named, memoryRootFor, hourScheduleFor } = await timedBootStep(
    'load_personas',
    () =>
      loadAllPersonas({
        namedManifestDir: namedDir,
        proceduralDir: agentsDir,
      }),
  );
  if (skills.length === 0) {
    throw new Error(`no personas found under ${agentsDir} (named dir: ${namedDir})`);
  }
  const seeded = await seedNamedPersonaMemories(named);
  if (seeded.length > 0) log.info('web.named.seeded', { ids: seeded });
  log.info('web.named.loaded', {
    named: named.length,
    procedural: skills.length - named.length,
  });

  const tileMap = buildStarterTown();
  const positionRng = seededRng(`positions:${SEED}`);

  const clock = new SimulationClock({
    mode: 'stepped',
    speed: SIM_SPEED,
    tickHz: 1000 / TICK_MS,
    startSimTime: SIM_START_HOUR * 3600,
  });
  const world = new World({ width: tileMap.width, height: tileMap.height, clock, tileMap });

  const runtimeAgents = skills.map((skill) => {
    const home = homeForAgent(tileMap, skill.id);
    const baseAnchor: Vec2 = home?.anchor ?? { x: 1, y: 1 };
    const candidate: Vec2 = {
      x: clamp(baseAnchor.x + Math.floor(positionRng() * 3) - 1, 0, world.width - 1),
      y: clamp(baseAnchor.y + Math.floor(positionRng() * 3) - 1, 0, world.height - 1),
    };
    const safe = nearestWalkable(tileMap, candidate, 6) ?? baseAnchor;
    return {
      skill,
      memory: new ParaMemory({
        root: memoryRootFor(skill.id),
        flushMode: 'deferred',
      }),
      initial: { position: { ...safe } },
      hourSchedule: hourScheduleFor(skill.id),
    };
  });

  // Reflection synthesizer selection, in priority order:
  //   1. LLM_GATEWAY_KEY      → OpenAI-compatible gateway (llm.yester.cloud by default)
  //   2. ANTHROPIC_API_KEY    → direct Anthropic Messages API
  //   3. neither              → deterministic fallback inside the engine
  const gatewayKey = process.env.LLM_GATEWAY_KEY?.trim();
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  let llmSynth: ReturnType<typeof createLlmSynthesizer> | undefined;
  let synthProvider: 'gateway' | 'anthropic' | 'none' = 'none';
  if (gatewayKey) {
    llmSynth = createGatewaySynthesizer({
      apiKey: gatewayKey,
      baseUrl: process.env.LLM_GATEWAY_URL || undefined,
      model: process.env.LLM_GATEWAY_MODEL || undefined,
      budget,
      log: (level, event, fields) => log[level](event, fields),
    });
    synthProvider = 'gateway';
  } else if (anthropicKey) {
    llmSynth = createLlmSynthesizer({
      apiKey: anthropicKey,
      budget,
      log: (level, event, fields) => log[level](event, fields),
      model: process.env.REFLECTION_MODEL || undefined,
    });
    synthProvider = 'anthropic';
  }
  const reflectionTunables = resolveReflectionTunables();
  const reflectionOpts = mergeReflectionOptions(
    llmSynth ? { synthesizer: llmSynth } : {},
    reflectionTunables,
  );
  log.info('web.reflection.synth', {
    provider: synthProvider,
    llm: !!llmSynth,
    budgetCapUsd: budget.state().capUsd,
    gatewayModel:
      synthProvider === 'gateway' ? process.env.LLM_GATEWAY_MODEL || 'default' : undefined,
    importanceBudget: reflectionTunables.importanceBudget,
    minFacts: reflectionTunables.minFacts,
    windowSize: reflectionTunables.windowSize,
  });

  const relationships = RELATIONSHIPS_ENABLED
    ? new RelationshipStore({
        dir: RELATIONSHIPS_DIR,
        maxPairs: RELATIONSHIPS_MAX,
        log: (level, event, fields) => log[level](event, fields),
      })
    : null;
  if (relationships) {
    await relationships.load();
    log.info('relationships.ready', {
      dir: RELATIONSHIPS_DIR,
      max: RELATIONSHIPS_MAX,
      loaded: relationships.count(),
    });
  }

  const runtime = new Runtime({
    agents: runtimeAgents,
    world,
    tickMs: TICK_MS,
    seed: SEED,
    reflections: reflectionOpts,
    relationships,
    groupMoments: GROUP_MOMENTS_ENABLED
      ? {
          minParticipants: GROUP_MOMENTS_MIN_PARTICIPANTS,
          minConsecutiveTicks: GROUP_MOMENTS_MIN_CONSECUTIVE_TICKS,
          maxDedupEntries: GROUP_MOMENTS_DEDUP_MAX,
        }
      : false,
  });
  log.info('group_moments.ready', {
    enabled: GROUP_MOMENTS_ENABLED,
    minParticipants: GROUP_MOMENTS_MIN_PARTICIPANTS,
    minConsecutiveTicks: GROUP_MOMENTS_MIN_CONSECUTIVE_TICKS,
    maxDedupEntries: GROUP_MOMENTS_DEDUP_MAX,
  });

  log.info('web.personas.loaded', { count: skills.length });

  // Snapshot restore — before first tick, before SSE subscribers.
  if (SIM_SNAPSHOT_ENABLED) {
    const restored = await timedBootStep('read_snapshot', () =>
      readSnapshot(SIM_SNAPSHOT_DIR, (level, event, fields) => log[level](event, fields)),
    );
    if (restored) {
      try {
        runtime.restoreStateSnapshot(restored);
        log.info('sim.snapshot.restore', {
          dir: SIM_SNAPSHOT_DIR,
          tickIndex: restored.tickIndex,
          simTime: restored.clock.simTime,
          savedAt: restored.savedAt,
          ageMs: Date.now() - Date.parse(restored.savedAt),
          objects: restored.world.objects.length,
          agents: restored.agents.length,
        });
      } catch (err) {
        log.error('sim.snapshot.restore.error', {
          dir: SIM_SNAPSHOT_DIR,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      log.info('sim.snapshot.cold_start', { dir: SIM_SNAPSHOT_DIR });
    }
  }

  const snapshotScheduler: SnapshotScheduler | null = SIM_SNAPSHOT_ENABLED
    ? scheduleSnapshots({
        dir: SIM_SNAPSHOT_DIR,
        runtime,
        everyTicks: SIM_SNAPSHOT_EVERY_TICKS,
        log: (level, event, fields) => log[level](event, fields),
      })
    : null;

  let ready = false;
  const clients = new Set<ServerResponse>();
  const encoder = (msg: unknown) => `data: ${JSON.stringify(msg)}\n\n`;
  function broadcast(payload: unknown): void {
    const line = encoder(payload);
    for (const res of clients) res.write(line);
  }

  const observability = new ObservabilityStore();
  const nameById = new Map<string, string>();
  for (const skill of skills) nameById.set(skill.id, skill.displayName);
  const displayName = (id: string) => nameById.get(id) ?? id;

  // Per-agent visual + display metadata so captured moments can render
  // standalone without any live runtime state (TINA-29).
  const agentMeta = new Map<string, { name: string; named: boolean; color: string | null }>();
  for (const skill of skills) {
    const meta = skill.metadata;
    const named = meta.named === 'true';
    agentMeta.set(skill.id, {
      name: skill.displayName,
      named,
      color: named ? (meta.glyph_color ?? null) : null,
    });
  }
  const participantSnap = (id: string) => {
    const m = agentMeta.get(id);
    return {
      id,
      name: m?.name ?? id,
      named: m?.named ?? false,
      color: m?.color ?? null,
    };
  };

  // Resolve the zone a conversation took place in by looking at where the
  // participants currently stand. Uses the first participant's zone that
  // resolves to a non-null value — participants that close due to drift will
  // often return `null` on the first one, so we try each before giving up.
  const zoneForParticipants = (ids: string[]): string | null => {
    for (const id of ids) {
      const agent = world.listAgents().find((a) => a.def.id === id);
      if (agent?.state.zone) return agent.state.zone;
    }
    return null;
  };

  const moments = MOMENT_STORE_ENABLED
    ? new MomentStore({
        dir: MOMENT_STORE_DIR,
        maxMoments: MOMENT_STORE_MAX,
        log: (level, event, fields) => log[level](event, fields),
      })
    : null;
  if (moments) {
    await moments.load();
    log.info('moments.ready', {
      dir: MOMENT_STORE_DIR,
      max: MOMENT_STORE_MAX,
      loaded: moments.count(),
      publicBaseUrl: MOMENT_PUBLIC_BASE_URL,
    });
  }

  const stickyMetrics = STICKY_METRICS_ENABLED
    ? new StickyMetrics({
        dir: STICKY_METRICS_DIR,
        log: (level, event, fields) => log[level](event, fields),
      })
    : null;
  if (stickyMetrics) {
    await stickyMetrics.load();
    log.info('sticky.ready', {
      dir: STICKY_METRICS_DIR,
      days: stickyMetrics.dayCount(),
      visitors: stickyMetrics.visitorCount(),
    });
  }

  /**
   * Read the `tvid` cookie and stamp a new one if absent. Returns the
   * visitor id the counter-bump path should key on. Tiny surface by design:
   * the only side-effect on the response is a single `Set-Cookie` header,
   * which is safe to emit before `writeHead`.
   */
  const resolveVisitor = (req: IncomingMessage, res: ServerResponse): string => {
    const existing = parseVisitorCookie(req.headers.cookie);
    if (existing) return existing;
    const id = generateVisitorId();
    res.setHeader('set-cookie', buildVisitorSetCookie(id));
    return id;
  };

  // Per-session nudge tracker (TINA-275). Populated when a queued viewer
  // nudge is consumed by a close; read at `/moment/:id` render time to
  // surface the "viewer-nudged" pill. Bounded by MAX — oldest entries evict
  // on insert so we can't leak under sustained traffic. Not persisted:
  // restart clears the pills, which is fine since moment records are
  // short-retention already.
  const NUDGED_SESSIONS_MAX = 512;
  const nudgedSessions = new Map<string, NudgeDirection>();
  const rememberNudgedSession = (sessionId: string, direction: NudgeDirection): void => {
    if (nudgedSessions.size >= NUDGED_SESSIONS_MAX) {
      const oldest = nudgedSessions.keys().next();
      if (!oldest.done) nudgedSessions.delete(oldest.value);
    }
    nudgedSessions.set(sessionId, direction);
  };
  const isSessionNudged = (sessionId: string): NudgeDirection | null =>
    nudgedSessions.get(sessionId) ?? null;

  runtime.setOnEvent((event: RuntimeEvent) => {
    switch (event.kind) {
      case 'plan_committed': {
        observability.recordPlanEvent({
          kind: 'plan_committed',
          id: event.agentId,
          name: displayName(event.agentId),
          simTime: event.simTime,
          detail: event.summary,
        });
        broadcast({
          kind: 'plan_committed',
          id: event.agentId,
          day: event.day,
          summary: event.summary,
          simTime: event.simTime,
        });
        return;
      }
      case 'plan_replan': {
        observability.recordPlanEvent({
          kind: 'plan_replan',
          id: event.agentId,
          name: displayName(event.agentId),
          simTime: event.simTime,
          detail: `${event.reason}: ${event.detail}`,
        });
        broadcast({
          kind: 'plan_replan',
          id: event.agentId,
          reason: event.reason,
          detail: event.detail,
          simTime: event.simTime,
        });
        return;
      }
      case 'plan_resume': {
        observability.recordPlanEvent({
          kind: 'plan_resume',
          id: event.agentId,
          name: displayName(event.agentId),
          simTime: event.simTime,
          detail: event.reason,
        });
        broadcast({
          kind: 'plan_resume',
          id: event.agentId,
          reason: event.reason,
          simTime: event.simTime,
        });
        return;
      }
      case 'reflection_written': {
        observability.recordReflection({
          id: event.agentId,
          name: displayName(event.agentId),
          reflectionId: event.reflectionId,
          summary: event.summary,
          sourceCount: event.sourceCount,
          trigger: event.trigger,
          simTime: event.simTime,
        });
        broadcast({
          kind: 'reflection',
          id: event.agentId,
          reflectionId: event.reflectionId,
          summary: event.summary,
          sourceCount: event.sourceCount,
          trigger: event.trigger,
          simTime: event.simTime,
        });
        // Stitch the reflection into the most recent moment whose
        // participants include this agent — gives the /moment/:id page the
        // "what they took away" line the spec asks for.
        moments?.attachReflection({
          reflectionId: event.reflectionId,
          agentId: event.agentId,
          summary: event.summary,
          sourceCount: event.sourceCount,
          trigger: event.trigger,
          simTime: event.simTime,
        });
        return;
      }
      case 'relationship_nudge_applied': {
        rememberNudgedSession(event.sessionId, event.direction);
        stickyMetrics?.recordNudge();
        log.info('admin.nudge.applied', {
          sessionId: event.sessionId,
          a: event.a,
          b: event.b,
          direction: event.direction,
        });
        return;
      }
      case 'object_used': {
        // TINA-416: a named character reached a typed affordance object.
        // Bump the daily counter; the runtime already broadcasts a Delta on
        // the world emit channel for /admin and /index live displays, so
        // we only need to record + log here. Also push into the per-agent
        // observability ring (TINA-482) so /character/:name can render the
        // last N uses without a fresh disk read.
        stickyMetrics?.recordAffordanceUse();
        observability.recordAffordanceEvent({
          agentId: event.agentId,
          agentName: event.agentName,
          objectId: event.objectId,
          label: event.label,
          affordance: event.affordance,
          zone: event.zone,
          simTime: event.simTime,
        });
        log.info('sim.object_used', {
          agentId: event.agentId,
          objectId: event.objectId,
          affordance: event.affordance,
          zone: event.zone,
        });
        return;
      }
      case 'group_moment': {
        // TINA-345: mint a group-variant moment record + bump the sticky-metrics
        // counter. The runtime already pushes a Delta through the world emit,
        // so the SSE stream carries it to /admin without a second broadcast.
        if (moments && event.participants.length >= 2) {
          moments.captureGroup(
            {
              sessionId: event.sessionId,
              simTime: event.simTime,
              participants: event.participants.map(participantSnap),
              zone: event.zone,
            },
            deriveWorldClock(event.simTime, clock.speed),
          );
        }
        stickyMetrics?.recordGroupMoment();
        log.info('sim.group_moment', {
          sessionId: event.sessionId,
          zone: event.zone,
          participants: event.participants,
        });
        return;
      }
      case 'conversation_close': {
        const participants = [...event.participants];
        const transcript = event.transcript.map((t) => ({ ...t }));
        const openedAt = event.transcript[0]?.at ?? event.simTime;
        observability.recordConversation({
          sessionId: event.sessionId,
          participants,
          participantNames: participants.map((id) => displayName(id)),
          transcript,
          openedAt,
          closedAt: event.simTime,
          reason: event.reason,
        });
        // Skip solo "conversations" — every session we capture needs at
        // least two participants for the headline to read right.
        if (moments && participants.length >= 2) {
          const zone = zoneForParticipants(participants);
          moments.captureClose(
            {
              sessionId: event.sessionId,
              simTime: event.simTime,
              openedAt,
              transcript,
              participants: participants.map(participantSnap),
              zone,
              closeReason: event.reason,
            },
            deriveWorldClock(event.simTime, clock.speed),
          );
        }
        return;
      }
    }
  });

  const indexHtml = await readFile(resolve(PUBLIC_DIR, 'index.html'), 'utf8');
  const adminHtml = await readFile(resolve(PUBLIC_DIR, 'admin.html'), 'utf8');

  const adminToken = process.env.ADMIN_TOKEN || null;

  const interventionHandlers = new InterventionHandlers({
    runtime,
    broadcast: (d) => broadcast(d),
    onAdmit: (kind) => {
      budget.record(0, `admin:intervention:${kind}`);
      log.info('admin.intervention', { kind });
    },
    adminToken,
  });

  const snapshotStatus = (): SnapshotStatus | null =>
    snapshotScheduler ? snapshotScheduler.status() : null;

  const momentRoutes = moments
    ? new MomentRoutes({
        store: moments,
        publicBaseUrl: MOMENT_PUBLIC_BASE_URL,
        checkAdmin: (req) => checkAdmin(req, adminToken),
        relationships,
        isSessionNudged,
        onShare: () => {
          budget.record(0, 'admin:moment:share');
          log.info('admin.moment.share', {});
          stickyMetrics?.recordShare();
        },
      })
    : null;

  // Per-character public profile pages (TINA-482). Only wired when the moment
  // store is enabled — without recent moments the page is mostly empty.
  const characterRoutes = moments
    ? new CharacterRoutes({
        named,
        moments,
        relationships,
        observability,
        simSpeed: clock.speed,
        publicBaseUrl: MOMENT_PUBLIC_BASE_URL,
      })
    : null;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url || !req.method) {
      res.writeHead(400);
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      if (stickyMetrics) {
        const visitorId = resolveVisitor(req, res);
        stickyMetrics.recordRootVisit(visitorId);
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(indexHtml);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/client.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(clientJs);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/admin') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(adminHtml);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/admin.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(adminJs);
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/admin/intervention/')) {
      const handled = await interventionHandlers.tryHandle(req, res, url.pathname);
      if (handled) return;
    }
    if (momentRoutes) {
      if (req.method === 'GET' && url.pathname.startsWith('/moment/')) {
        const id = url.pathname.slice('/moment/'.length);
        if (stickyMetrics) {
          const visitorId = resolveVisitor(req, res);
          stickyMetrics.recordMomentVisit(visitorId);
        }
        momentRoutes.handleMomentPage(res, id, url.pathname);
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/moments/')) {
        const id = url.pathname.slice('/api/moments/'.length);
        momentRoutes.handleMomentJson(res, id);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/moment/share') {
        await momentRoutes.handleShare(req, res);
        return;
      }
    }
    if (characterRoutes && req.method === 'GET' && url.pathname.startsWith('/character/')) {
      const rawName = url.pathname.slice('/character/'.length);
      // Stamp the visitor cookie up-front so dedup works on first hit.
      // Counter bump is conditional on a successful 200 — we don't want to
      // count rate-limited or 404 hits toward the per-name dedup set.
      const visitorId = stickyMetrics ? resolveVisitor(req, res) : null;
      const outcome = characterRoutes.handleCharacterPage(req, res, rawName, url.pathname);
      if (outcome.status === 200 && outcome.personaId && stickyMetrics && visitorId) {
        stickyMetrics.recordCharacterProfileView(outcome.personaId, visitorId);
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/bootstrap') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          snapshot: buildSnapshot(world, runtime),
          snapshotStatus: snapshotStatus(),
          ...observability.bootstrap(),
        }),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/snapshot/status') {
      const auth = checkAdmin(req, adminToken);
      if (!auth.ok) {
        res.writeHead(auth.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: auth.error }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: snapshotStatus() }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/relationships') {
      if (!relationships) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'relationships disabled' }));
        return;
      }
      const namedList = [...agentMeta.entries()]
        .filter(([, m]) => m.named)
        .map(([id, m]) => ({ id, name: m.name, color: m.color }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const pairs = relationships.list().map((p) => ({
        a: p.a,
        b: p.b,
        affinity: Math.round(p.affinity * 1000) / 1000,
        arcLabel: p.arcLabel,
        sharedConversationCount: p.sharedConversationCount,
        lastInteractionSim: p.lastInteractionSim,
        windowConversationCount: p.windowConversationCount,
        windowStartDay: p.windowStartDay,
      }));
      const nudges = relationships.listNudges().map((n) => ({
        a: n.a,
        b: n.b,
        direction: n.direction,
        queuedAtSim: n.queuedAtSim,
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, named: namedList, pairs, nudges }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/sticky-metrics') {
      const auth = checkAdmin(req, adminToken);
      if (!auth.ok) {
        res.writeHead(auth.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: auth.error }));
        return;
      }
      const rollup = stickyMetrics ? stickyMetrics.rollup(7) : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          enabled: stickyMetrics !== null,
          rollup,
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/snapshot/save') {
      const auth = checkAdmin(req, adminToken);
      if (!auth.ok) {
        res.writeHead(auth.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: auth.error }));
        return;
      }
      if (!snapshotScheduler) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'snapshots disabled' }));
        return;
      }
      try {
        await snapshotScheduler.forceSave();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: snapshotScheduler.status() }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(encoder(buildSnapshot(world, runtime)));
      clients.add(res);
      const heartbeat = setInterval(() => res.write(': hb\n\n'), 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      const t = runtime.telemetrySnapshot();
      const mem = process.memoryUsage();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          ready,
          version: process.env.RAILWAY_GIT_COMMIT_SHA ?? 'dev',
          simTime: world.simTime,
          agents: world.listAgents().length,
          ticks: t.ticks,
          tickDurationMs: t.tickDuration,
          activeConversations: t.activeConversations,
          conversationsOpened: t.conversationsOpened,
          conversationsClosed: t.conversationsClosed,
          conversationsPerMinute: Math.round(t.conversationsPerMinute),
          actionsPerMinute: Math.round(t.actionsPerMinute),
          actions: t.actions,
          wallMs: Math.round(t.wallMs),
          memoryMb: {
            rss: Math.round(mem.rss / 1024 / 1024),
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
            external: Math.round(mem.external / 1024 / 1024),
          },
          llmBudget: budget.state(),
        }),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/ready') {
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.on('error', (err) => log.error('web.server.error', { err }));

  server.listen(PORT, () => {
    ready = true;
    log.info('web.listen', {
      url: `http://localhost:${PORT}`,
      bootMs: Math.round(performance.now() - bootStart),
      personas: skills.length,
      llmBudgetUsd: budget.state().capUsd,
    });
  });

  let ticking = false;
  const tickTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void (async () => {
      try {
        const startDeltas = await runtime.tickOnce();
        const endDeltas: Delta[] = world.drainDeltas();
        const all: Delta[] = [...startDeltas, ...endDeltas];
        for (const d of all) broadcast(d);
        snapshotScheduler?.notifyTick();
        const t = runtime.telemetrySnapshot();
        if (HEARTBEAT_LOG_TICKS > 0 && t.ticks % HEARTBEAT_LOG_TICKS === 0) {
          log.info('sim.heartbeat', {
            ticks: t.ticks,
            simTime: world.simTime,
            agents: world.listAgents().length,
            activeConversations: t.activeConversations,
            conversationsPerMinute: Math.round(t.conversationsPerMinute),
            actionsPerMinute: Math.round(t.actionsPerMinute),
            tickMsP95: Math.round(t.tickDuration.p95 * 100) / 100,
            sseClients: clients.size,
            llm: budget.state(),
          });
        }
      } catch (err) {
        log.error('sim.tick.error', { err });
      } finally {
        ticking = false;
      }
    })();
  }, TICK_MS);

  const shutdown = (signal: string) => {
    log.info('web.shutdown', { signal });
    ready = false;
    clearInterval(tickTimer);
    for (const res of clients) res.end();
    void (async () => {
      try {
        await runtime.flushConversations();
      } catch (err) {
        log.error('web.shutdown.flush.error', { err });
      }
      if (snapshotScheduler) {
        try {
          await snapshotScheduler.forceSave();
          log.info('sim.snapshot.shutdown_save', { status: snapshotScheduler.status() });
        } catch (err) {
          log.error('sim.snapshot.shutdown_save.error', { err });
        }
        snapshotScheduler.dispose();
      }
      if (moments) {
        try {
          await moments.flush();
          log.info('moments.shutdown_flush', { count: moments.count() });
        } catch (err) {
          log.error('moments.shutdown_flush.error', { err });
        }
      }
      if (stickyMetrics) {
        try {
          await stickyMetrics.flush();
          log.info('sticky.shutdown_flush', {
            days: stickyMetrics.dayCount(),
            visitors: stickyMetrics.visitorCount(),
          });
        } catch (err) {
          log.error('sticky.shutdown_flush.error', { err });
        }
      }
      if (relationships) {
        try {
          await relationships.flush();
          log.info('relationships.shutdown_flush', { count: relationships.count() });
        } catch (err) {
          log.error('relationships.shutdown_flush.error', { err });
        }
      }
    })();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => log.error('process.uncaught', { err }));
  process.on('unhandledRejection', (err) => log.error('process.unhandled_rejection', { err }));
}

main().catch((err) => {
  log.error('web.boot.fatal', { err });
  process.exit(1);
});

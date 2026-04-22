import { readFile } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Delta, Vec2 } from '@tina/shared';
import {
  ParaMemory,
  Runtime,
  SimulationClock,
  World,
  buildStarterTown,
  homeForAgent,
  loadAllSkills,
  nearestWalkable,
  seededRng,
  skillDirectory,
} from '@tina/sim';
import { build as esbuild } from 'esbuild';
import { createBudget, resolveBudgetCap } from './budget.js';
import { log } from './logger.js';
import { buildSnapshot } from './snapshot.js';

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

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

async function bundleClient(): Promise<string> {
  const entry = resolve(__dirname, 'client', 'main.ts');
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
  if (!out) throw new Error('client bundle produced no output');
  return out.text;
}

async function main(): Promise<void> {
  const bootStart = performance.now();
  const budget = createBudget(resolveBudgetCap());
  log.info('web.boot.start', { port: PORT, seed: SEED, tickMs: TICK_MS, simSpeed: SIM_SPEED });

  const clientJs = await bundleClient();

  const agentsDir = resolve(REPO_ROOT, 'world', 'agents');
  const skills = await loadAllSkills(agentsDir);
  if (skills.length === 0) {
    throw new Error(`no personas found under ${agentsDir}`);
  }

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
        root: `${skillDirectory(skill)}/memory`,
        flushMode: 'deferred',
      }),
      initial: { position: { ...safe } },
    };
  });

  const runtime = new Runtime({
    agents: runtimeAgents,
    world,
    tickMs: TICK_MS,
    seed: SEED,
  });

  log.info('web.personas.loaded', { count: skills.length });

  let ready = false;
  const clients = new Set<ServerResponse>();
  const encoder = (msg: unknown) => `data: ${JSON.stringify(msg)}\n\n`;
  function broadcast(payload: unknown): void {
    const line = encoder(payload);
    for (const res of clients) res.write(line);
  }

  const indexHtml = await readFile(resolve(PUBLIC_DIR, 'index.html'), 'utf8');

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url || !req.method) {
      res.writeHead(400);
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(indexHtml);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/client.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(clientJs);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(encoder(buildSnapshot(world)));
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
    void runtime.flushConversations();
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

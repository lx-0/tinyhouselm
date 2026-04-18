import { readFile } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Delta, Zone } from '@tina/shared';
import {
  ParaMemory,
  Runtime,
  SimulationClock,
  World,
  loadAllSkills,
  seededRng,
  skillDirectory,
} from '@tina/sim';
import { build as esbuild } from 'esbuild';
import { buildSnapshot } from './snapshot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const PACKAGE_ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = resolve(PACKAGE_ROOT, 'public');

const PORT = Number(process.env.PORT ?? 5173);
const WORLD_W = Number(process.env.WORLD_W ?? 24);
const WORLD_H = Number(process.env.WORLD_H ?? 24);
const SEED = Number(process.env.SEED ?? 42);
const TICK_MS = Number(process.env.TICK_MS ?? 200);
const SIM_SPEED = Number(process.env.SIM_SPEED ?? 30);

function defaultZones(width: number, height: number): Zone[] {
  const zw = Math.max(4, Math.floor(width / 4));
  const zh = Math.max(4, Math.floor(height / 4));
  return [
    { name: 'cafe', x: 1, y: 1, width: zw, height: zh },
    { name: 'park', x: width - zw - 1, y: 1, width: zw, height: zh },
    { name: 'home', x: Math.floor(width / 2 - zw / 2), y: height - zh - 1, width: zw, height: zh },
  ];
}

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
  const clientJs = await bundleClient();

  const agentsDir = resolve(REPO_ROOT, 'world', 'agents');
  const skills = await loadAllSkills(agentsDir);
  if (skills.length === 0) {
    throw new Error(`no personas found under ${agentsDir}`);
  }

  const zones = defaultZones(WORLD_W, WORLD_H);
  const anchors = zones.map((z) => ({
    x: Math.floor(z.x + z.width / 2),
    y: Math.floor(z.y + z.height / 2),
  }));
  const positionRng = seededRng(`positions:${SEED}`);

  const clock = new SimulationClock({
    mode: 'stepped',
    speed: SIM_SPEED,
    tickHz: 1000 / TICK_MS,
  });
  const world = new World({ width: WORLD_W, height: WORLD_H, clock, zones });

  const runtimeAgents = skills.map((skill, i) => {
    const anchor = anchors[i % anchors.length]!;
    return {
      skill,
      memory: new ParaMemory({ root: `${skillDirectory(skill)}/memory` }),
      initial: {
        position: {
          x: clamp(anchor.x + Math.floor(positionRng() * 5) - 2, 0, WORLD_W - 1),
          y: clamp(anchor.y + Math.floor(positionRng() * 5) - 2, 0, WORLD_H - 1),
        },
      },
    };
  });

  const runtime = new Runtime({
    agents: runtimeAgents,
    world,
    tickMs: TICK_MS,
    seed: SEED,
  });

  console.log(`[web] loaded ${skills.length} personas: ${skills.map((s) => s.id).join(', ')}`);

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
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ ok: true, simTime: world.simTime, agents: world.listAgents().length }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.listen(PORT, () => {
    console.log(`[web] serving http://localhost:${PORT}`);
    console.log(`[web] ticking every ${TICK_MS}ms at ${SIM_SPEED}× sim speed`);
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
      } catch (err) {
        console.error('[web] tick error', err);
      } finally {
        ticking = false;
      }
    })();
  }, TICK_MS);

  const shutdown = () => {
    clearInterval(tickTimer);
    for (const res of clients) res.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

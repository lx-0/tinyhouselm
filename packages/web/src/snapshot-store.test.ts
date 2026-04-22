import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ParaMemory,
  Runtime,
  SimulationClock,
  WORLD_STATE_SNAPSHOT_VERSION,
  World,
  type WorldStateSnapshot,
  parseSkillSource,
} from '@tina/sim';
import type { HeartbeatPolicy } from '@tina/sim';
import { describe, expect, it } from 'vitest';
import { SNAPSHOT_FILE, readSnapshot, scheduleSnapshots, writeSnapshot } from './snapshot-store.js';

const silentPolicy: HeartbeatPolicy = {
  async decide() {
    return [];
  },
};

async function makeRuntime(opts: {
  personas: Array<{ id: string; position: { x: number; y: number } }>;
  seed?: number;
}): Promise<Runtime> {
  const world = new World({
    width: 16,
    height: 16,
    clock: new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 }),
  });
  const agents = await Promise.all(
    opts.personas.map(async (p) => ({
      skill: parseSkillSource(
        `---\nname: ${p.id}\ndescription: steady quiet\n---\n\n# ${p.id}\n`,
        `/virtual/${p.id}/SKILL.md`,
      ),
      memory: new ParaMemory({
        root: await mkdtemp(join(tmpdir(), `tina-snap-${p.id}-`)),
        now: () => new Date('2026-04-22T00:00:00Z'),
      }),
      initial: { position: { ...p.position } },
    })),
  );
  return new Runtime({
    agents,
    world,
    policy: silentPolicy,
    seed: opts.seed ?? 42,
    tickMs: 100,
    reflections: false,
    memoryFlushEveryTicks: 0,
  });
}

describe('snapshot-store round-trip', () => {
  it('restores tickIndex, simTime, agent positions, and dropped objects byte-identical', async () => {
    const personas = [
      { id: 'alpha', position: { x: 2, y: 2 } },
      { id: 'bravo', position: { x: 10, y: 10 } },
    ];

    const source = await makeRuntime({ personas });
    await source.runTicks(3);
    source.dropObject({ id: 'obj-1', label: 'letter', pos: { x: 5, y: 5 } });
    source.dropObject({ id: 'obj-2', label: 'rock', pos: { x: 6, y: 7 } });
    await source.runTicks(2);

    const dir = await mkdtemp(join(tmpdir(), 'tina-snap-dir-'));
    const snap = source.toStateSnapshot();
    await writeSnapshot(dir, snap);

    const onDisk = await readSnapshot(dir);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.version).toBe(WORLD_STATE_SNAPSHOT_VERSION);

    const revived = await makeRuntime({ personas });
    revived.restoreStateSnapshot(onDisk!);

    expect(revived.tickIndex).toBe(source.tickIndex);
    expect(revived.clock.simTime).toBe(source.clock.simTime);
    expect(revived.clock.ticks).toBe(source.clock.ticks);
    expect(
      revived.world
        .listObjects()
        .map((o) => o.id)
        .sort(),
    ).toEqual(['obj-1', 'obj-2']);

    const byIdSource = new Map(source.listAgents().map((a) => [a.def.id, a.state.position]));
    for (const a of revived.listAgents()) {
      const srcPos = byIdSource.get(a.def.id);
      expect(srcPos).toBeDefined();
      expect(a.state.position).toEqual(srcPos);
    }

    // One more tick must not crash — replan picks up from the restored pos.
    await revived.runTicks(1);
    expect(revived.tickIndex).toBe(source.tickIndex + 1);
  });

  it('readSnapshot returns null on version mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tina-snap-ver-'));
    const path = join(dir, SNAPSHOT_FILE);
    await writeFile(path, JSON.stringify({ version: 999, garbage: true }), 'utf8');
    const got = await readSnapshot(dir);
    expect(got).toBeNull();
  });

  it('readSnapshot returns null on malformed JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tina-snap-bad-'));
    const path = join(dir, SNAPSHOT_FILE);
    await writeFile(path, 'not json {{', 'utf8');
    const got = await readSnapshot(dir);
    expect(got).toBeNull();
  });

  it('readSnapshot returns null when file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tina-snap-none-'));
    const got = await readSnapshot(dir);
    expect(got).toBeNull();
  });

  it('restoreStateSnapshot refuses a mismatched world size', async () => {
    const runtime = await makeRuntime({ personas: [{ id: 'a', position: { x: 1, y: 1 } }] });
    const good = runtime.toStateSnapshot();
    const bad: WorldStateSnapshot = { ...good, world: { ...good.world, width: 99 } };
    expect(() => runtime.restoreStateSnapshot(bad)).toThrow(/dims/);
  });

  it('restoreStateSnapshot refuses a mismatched version', async () => {
    const runtime = await makeRuntime({ personas: [{ id: 'a', position: { x: 1, y: 1 } }] });
    const good = runtime.toStateSnapshot();
    const bad: WorldStateSnapshot = { ...good, version: 999 };
    expect(() => runtime.restoreStateSnapshot(bad)).toThrow(/version/);
  });

  it('writeSnapshot is atomic — no leftover .tmp file on success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tina-snap-atomic-'));
    const runtime = await makeRuntime({ personas: [{ id: 'a', position: { x: 1, y: 1 } }] });
    await writeSnapshot(dir, runtime.toStateSnapshot());
    const body = await readFile(join(dir, SNAPSHOT_FILE), 'utf8');
    expect(body.endsWith('\n')).toBe(true);
    // No dangling .tmp — rename should have cleaned it up.
    await expect(readFile(join(dir, `${SNAPSHOT_FILE}.tmp`), 'utf8')).rejects.toThrow();
  });
});

describe('snapshot-store scheduler', () => {
  it('writes every N ticks via notifyTick and never awaits inside the caller', async () => {
    const runtime = await makeRuntime({ personas: [{ id: 'a', position: { x: 1, y: 1 } }] });
    const saves: Array<{ tickIndex: number; at: number }> = [];
    let writerStart = 0;
    const scheduler = scheduleSnapshots({
      dir: '/unused',
      runtime,
      everyTicks: 10,
      writer: async (_dir, snap) => {
        const at = performance.now() - writerStart;
        saves.push({ tickIndex: snap.tickIndex, at });
      },
    });
    writerStart = performance.now();
    const loopStart = performance.now();
    for (let i = 0; i < 35; i++) {
      await runtime.runTicks(1);
      scheduler.notifyTick();
    }
    // Drain any in-flight save before asserting counts.
    await scheduler.forceSave();
    const loopElapsed = performance.now() - loopStart;

    // Three periodic writes at ticks 10/20/30 + one forceSave at the end.
    const tickIndexes = saves.map((s) => s.tickIndex).sort((a, b) => a - b);
    expect(tickIndexes).toEqual([10, 20, 30, 35]);
    // The tick loop itself should not block on writer work.
    expect(loopElapsed).toBeLessThan(250);
    const status = scheduler.status();
    expect(status.saves).toBe(4);
    expect(status.failures).toBe(0);
    scheduler.dispose();
  });

  it('does not block the tick loop when writes take a long time (fire-and-forget)', async () => {
    const runtime = await makeRuntime({ personas: [{ id: 'a', position: { x: 1, y: 1 } }] });
    const scheduler = scheduleSnapshots({
      dir: '/unused',
      runtime,
      everyTicks: 1,
      writer: () => new Promise((r) => setTimeout(r, 200)),
    });
    const start = performance.now();
    for (let i = 0; i < 5; i++) {
      await runtime.runTicks(1);
      scheduler.notifyTick();
    }
    const elapsed = performance.now() - start;
    // The tick loop must complete without waiting for the 200ms writes.
    expect(elapsed).toBeLessThan(150);
    scheduler.dispose();
  });

  it('records failures without crashing the scheduler', async () => {
    const runtime = await makeRuntime({ personas: [{ id: 'a', position: { x: 1, y: 1 } }] });
    const scheduler = scheduleSnapshots({
      dir: '/unused',
      runtime,
      everyTicks: 1,
      writer: async () => {
        throw new Error('disk full');
      },
    });
    await runtime.runTicks(1);
    scheduler.notifyTick();
    // Allow the fire-and-forget save to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const status = scheduler.status();
    expect(status.failures).toBeGreaterThanOrEqual(1);
    expect(status.lastError).toContain('disk full');
    scheduler.dispose();
  });

  it('everyTicks=0 disables periodic saves but forceSave still works', async () => {
    const runtime = await makeRuntime({ personas: [{ id: 'a', position: { x: 1, y: 1 } }] });
    const saves: number[] = [];
    const scheduler = scheduleSnapshots({
      dir: '/unused',
      runtime,
      everyTicks: 0,
      writer: async (_dir, snap) => {
        saves.push(snap.tickIndex);
      },
    });
    for (let i = 0; i < 30; i++) {
      await runtime.runTicks(1);
      scheduler.notifyTick();
    }
    expect(saves.length).toBe(0);
    await scheduler.forceSave();
    expect(saves.length).toBe(1);
    scheduler.dispose();
  });
});

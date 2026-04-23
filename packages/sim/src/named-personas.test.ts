import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { SimulationClock } from './clock.js';
import type { HeartbeatPolicy } from './heartbeat.js';
import { ParaMemory } from './memory.js';
import {
  type NamedPersonaManifest,
  loadAllPersonas,
  loadNamedPersonas,
  manifestToSkill,
  seedNamedPersonaMemories,
} from './named-personas.js';
import { Runtime } from './runtime.js';
import { World } from './world.js';

interface Workspace {
  root: string;
  manifestDir: string;
  proceduralDir: string;
}

const cleanup: Workspace[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const w = cleanup.pop()!;
    await rm(w.root, { recursive: true, force: true });
  }
});

async function makeWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'tina-named-'));
  const manifestDir = join(root, 'named');
  const proceduralDir = join(root, 'agents');
  await mkdir(manifestDir, { recursive: true });
  await mkdir(proceduralDir, { recursive: true });
  const ws = { root, manifestDir, proceduralDir };
  cleanup.push(ws);
  return ws;
}

function manifestYaml(partial: Partial<NamedPersonaManifest>): string {
  const full: NamedPersonaManifest = {
    id: 'mei-tanaka',
    name: 'Mei Tanaka',
    bio: 'librarian',
    archetype: 'librarian',
    glyph: { color: '#d8a0cc', accent: '#6b3b5a' },
    traits: ['quiet', 'warm'],
    routines: ['library 09:00–19:00'],
    voice: 'measured',
    seedMemories: [{ fact: 'coffee before work', category: 'preference', importance: 5 }],
    ...partial,
  };
  const lines: string[] = [];
  lines.push(`id: ${full.id}`);
  lines.push(`name: ${JSON.stringify(full.name)}`);
  lines.push(`archetype: ${JSON.stringify(full.archetype)}`);
  lines.push(`bio: ${JSON.stringify(full.bio)}`);
  if (full.age !== undefined) lines.push(`age: ${full.age}`);
  if (full.occupation) lines.push(`occupation: ${JSON.stringify(full.occupation)}`);
  lines.push('glyph:');
  lines.push(`  color: ${JSON.stringify(full.glyph.color)}`);
  lines.push(`  accent: ${JSON.stringify(full.glyph.accent)}`);
  lines.push('traits:');
  for (const t of full.traits) lines.push(`  - ${JSON.stringify(t)}`);
  lines.push('routines:');
  for (const r of full.routines) lines.push(`  - ${JSON.stringify(r)}`);
  lines.push(`voice: ${JSON.stringify(full.voice)}`);
  lines.push('seedMemories:');
  for (const s of full.seedMemories) {
    lines.push(`  - fact: ${JSON.stringify(s.fact)}`);
    if (s.category) lines.push(`    category: ${s.category}`);
    if (s.importance !== undefined) lines.push(`    importance: ${s.importance}`);
    if (s.related_entities && s.related_entities.length > 0) {
      lines.push(
        `    related_entities: [${s.related_entities.map((x) => JSON.stringify(x)).join(', ')}]`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function writeProcedural(proceduralDir: string, id: string, body = ''): Promise<void> {
  const dir = join(proceduralDir, id);
  await mkdir(dir, { recursive: true });
  const src = [
    '---',
    `name: ${id}`,
    'description: procedural filler',
    'metadata:',
    '  persona_version: "1"',
    '---',
    '',
    `# ${id}`,
    '',
    body,
    '',
  ].join('\n');
  await writeFile(join(dir, 'SKILL.md'), src, 'utf8');
}

describe('manifestToSkill', () => {
  it('synthesizes a SkillDocument with named metadata and traits/routines body', () => {
    const manifest: NamedPersonaManifest = {
      id: 'mei-tanaka',
      name: 'Mei Tanaka',
      archetype: 'librarian',
      bio: '42yo branch librarian',
      glyph: { color: '#d8a0cc', accent: '#6b3b5a' },
      traits: ['quiet', 'warm'],
      routines: ['library 09–19'],
      voice: 'measured',
      seedMemories: [],
    };
    const doc = manifestToSkill(manifest, '/tmp/x.yaml');
    expect(doc.id).toBe('mei-tanaka');
    expect(doc.displayName).toBe('Mei Tanaka');
    expect(doc.metadata.named).toBe('true');
    expect(doc.metadata.glyph_color).toBe('#d8a0cc');
    expect(doc.metadata.glyph_accent).toBe('#6b3b5a');
    expect(doc.metadata.bio).toBe('42yo branch librarian');
    expect(doc.body).toContain('- quiet');
    expect(doc.body).toContain('- library 09–19');
    expect(doc.body).toContain('measured');
  });
});

describe('loadNamedPersonas', () => {
  it('returns [] when the manifest directory does not exist', async () => {
    const missing = join(tmpdir(), 'tina-no-such-dir-please');
    const out = await loadNamedPersonas({ manifestDir: missing, memoryRootDir: missing });
    expect(out).toEqual([]);
  });

  it('loads and sorts manifests by id', async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws.manifestDir, 'zeta.yaml'), manifestYaml({ id: 'zeta-z', name: 'Z' }));
    await writeFile(join(ws.manifestDir, 'alpha.yaml'), manifestYaml({ id: 'alpha-a', name: 'A' }));
    const loaded = await loadNamedPersonas({
      manifestDir: ws.manifestDir,
      memoryRootDir: ws.proceduralDir,
    });
    expect(loaded.map((p) => p.manifest.id)).toEqual(['alpha-a', 'zeta-z']);
    expect(loaded[0]!.memoryRoot).toBe(join(ws.proceduralDir, 'alpha-a', 'memory'));
  });

  it('rejects invalid hex colors', async () => {
    const ws = await makeWorkspace();
    await writeFile(
      join(ws.manifestDir, 'bad.yaml'),
      manifestYaml({ glyph: { color: 'blue', accent: '#fff' } }),
    );
    await expect(
      loadNamedPersonas({ manifestDir: ws.manifestDir, memoryRootDir: ws.proceduralDir }),
    ).rejects.toThrow(/hex/);
  });

  it('rejects invalid ids', async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws.manifestDir, 'bad.yaml'), manifestYaml({ id: 'Bad ID' }));
    await expect(
      loadNamedPersonas({ manifestDir: ws.manifestDir, memoryRootDir: ws.proceduralDir }),
    ).rejects.toThrow(/invalid id/);
  });

  it('rejects duplicate ids across manifests', async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws.manifestDir, 'a.yaml'), manifestYaml({ id: 'dup-id' }));
    await writeFile(join(ws.manifestDir, 'b.yaml'), manifestYaml({ id: 'dup-id' }));
    await expect(
      loadNamedPersonas({ manifestDir: ws.manifestDir, memoryRootDir: ws.proceduralDir }),
    ).rejects.toThrow(/duplicate/);
  });
});

describe('seedNamedPersonaMemories', () => {
  it('writes items.yaml only on first boot', async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws.manifestDir, 'mei.yaml'), manifestYaml({}));
    const loaded = await loadNamedPersonas({
      manifestDir: ws.manifestDir,
      memoryRootDir: ws.proceduralDir,
    });

    const now = () => new Date('2026-04-23T12:00:00Z');
    const first = await seedNamedPersonaMemories(loaded, now);
    expect(first).toEqual(['mei-tanaka']);

    const itemsPath = join(
      ws.proceduralDir,
      'mei-tanaka',
      'memory',
      'life',
      'areas',
      'self',
      'items.yaml',
    );
    const yaml = await readFile(itemsPath, 'utf8');
    const facts = parseYaml(yaml) as Array<{ fact: string; category: string; importance: number }>;
    expect(facts).toHaveLength(1);
    expect(facts[0]!.fact).toBe('coffee before work');
    expect(facts[0]!.category).toBe('preference');
    expect(facts[0]!.importance).toBe(5);

    // Second call is a no-op — seedMemories never overwrite existing state.
    const second = await seedNamedPersonaMemories(loaded, now);
    expect(second).toEqual([]);
  });

  it('does not overwrite when items.yaml already has unrelated facts', async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws.manifestDir, 'mei.yaml'), manifestYaml({}));
    const loaded = await loadNamedPersonas({
      manifestDir: ws.manifestDir,
      memoryRootDir: ws.proceduralDir,
    });
    const memRoot = loaded[0]!.memoryRoot;
    // Precondition: a prior session already wrote a memory.
    const priorMem = new ParaMemory({ root: memRoot, flushMode: 'eager' });
    await priorMem.addFact({ fact: 'random prior fact', category: 'observation' });

    const seeded = await seedNamedPersonaMemories(loaded);
    expect(seeded).toEqual([]);

    const facts = await new ParaMemory({ root: memRoot, flushMode: 'eager' }).readFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]!.fact).toBe('random prior fact');
  });
});

describe('loadAllPersonas', () => {
  it('merges named first, deduplicates by id, caps fills from the tail', async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws.manifestDir, 'mei.yaml'), manifestYaml({ id: 'mei-tanaka' }));
    await writeFile(
      join(ws.manifestDir, 'hiro.yaml'),
      manifestYaml({ id: 'hiro-abe', name: 'Hiro Abe' }),
    );

    // Procedurals: one collides with named (should be dropped), others fill.
    await writeProcedural(ws.proceduralDir, 'mei-tanaka');
    await writeProcedural(ws.proceduralDir, 'p-001-wren');
    await writeProcedural(ws.proceduralDir, 'p-002-zane');
    await writeProcedural(ws.proceduralDir, 'p-003-omar');

    const loaded = await loadAllPersonas({
      namedManifestDir: ws.manifestDir,
      proceduralDir: ws.proceduralDir,
      cap: 4,
    });
    expect(loaded.skills.map((s) => s.id)).toEqual([
      'hiro-abe',
      'mei-tanaka',
      'p-001-wren',
      'p-002-zane',
    ]);
    expect(loaded.dropped.map((s) => s.id)).toEqual(['p-003-omar']);
    expect(loaded.named.map((p) => p.manifest.id).sort()).toEqual(['hiro-abe', 'mei-tanaka']);
  });

  it('named memory roots land under the memory root dir, procedural alongside their SKILL.md', async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws.manifestDir, 'mei.yaml'), manifestYaml({ id: 'mei-tanaka' }));
    await writeProcedural(ws.proceduralDir, 'p-000-wren');

    const loaded = await loadAllPersonas({
      namedManifestDir: ws.manifestDir,
      proceduralDir: ws.proceduralDir,
    });
    expect(loaded.memoryRootFor('mei-tanaka')).toBe(join(ws.proceduralDir, 'mei-tanaka', 'memory'));
    expect(loaded.memoryRootFor('p-000-wren')).toBe(join(ws.proceduralDir, 'p-000-wren', 'memory'));
  });

  it('runtime snapshots propagate named/color/accent/bio for named personas only', async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws.manifestDir, 'mei.yaml'), manifestYaml({ id: 'mei-tanaka' }));
    await writeProcedural(ws.proceduralDir, 'p-001-wren');

    const loaded = await loadAllPersonas({
      namedManifestDir: ws.manifestDir,
      proceduralDir: ws.proceduralDir,
    });
    const memDir = await mkdtemp(join(tmpdir(), 'tina-named-rt-'));
    cleanup.push({ root: memDir, manifestDir: memDir, proceduralDir: memDir });
    const silent: HeartbeatPolicy = {
      async decide() {
        return [];
      },
    };
    const clock = new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 });
    const world = new World({ width: 8, height: 8, clock });
    const runtime = new Runtime({
      agents: loaded.skills.map((skill, i) => ({
        skill,
        memory: new ParaMemory({ root: join(memDir, skill.id) }),
        initial: { position: { x: 1 + i, y: 1 } },
      })),
      world,
      policy: silent,
      tickMs: 100,
    });
    await runtime.tickOnce();
    const snaps = world.listAgents().map((a) => a.snapshot());
    const mei = snaps.find((s) => s.id === 'mei-tanaka')!;
    const proc = snaps.find((s) => s.id === 'p-001-wren')!;
    expect(mei.named).toBe(true);
    expect(mei.color).toBe('#d8a0cc');
    expect(mei.accent).toBe('#6b3b5a');
    expect(mei.bio).toBe('librarian');
    expect(proc.named).toBeUndefined();
    expect(proc.color).toBeUndefined();
  });

  it('named personas are never dropped when cap is smaller than named.length', async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws.manifestDir, 'mei.yaml'), manifestYaml({ id: 'mei-tanaka' }));
    await writeFile(join(ws.manifestDir, 'hiro.yaml'), manifestYaml({ id: 'hiro-abe' }));
    await writeProcedural(ws.proceduralDir, 'p-001');

    const loaded = await loadAllPersonas({
      namedManifestDir: ws.manifestDir,
      proceduralDir: ws.proceduralDir,
      cap: 1,
    });
    // cap=1 < named.length=2, but both named survive; the procedural fill is
    // what gets trimmed. "Named personas always present" is the contract.
    expect(loaded.skills.map((s) => s.id).sort()).toEqual(['hiro-abe', 'mei-tanaka']);
    expect(loaded.dropped.map((s) => s.id)).toEqual(['p-001']);
  });
});

import {
  type AgentSnap,
  type DayPhase,
  type Delta,
  type Snapshot,
  type StreamMessage,
  type Vec2,
  type WorldClock,
  type Zone,
  deriveWorldClock,
} from '@tina/shared';

const TILE = 24;

interface AgentView {
  id: string;
  name: string;
  zone: string | null;
  from: Vec2;
  to: Vec2;
  moveStart: number;
  moveDurMs: number;
  facing: 'N' | 'S' | 'E' | 'W';
  action: string;
  color: { body: string; head: string };
  speech: { text: string; until: number } | null;
}

interface ViewState {
  width: number;
  height: number;
  zones: Zone[];
  agents: Map<string, AgentView>;
  conversations: Map<string, { participants: string[] }>;
  simTime: number;
  speed: number;
  clock: WorldClock;
  connected: boolean;
  lastMessageAt: number;
}

const state: ViewState = {
  width: 0,
  height: 0,
  zones: [],
  agents: new Map(),
  conversations: new Map(),
  simTime: 0,
  speed: 1,
  clock: deriveWorldClock(0, 1),
  connected: false,
  lastMessageAt: 0,
};

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('canvas 2d context unavailable');
const statsEl = document.getElementById('stats') as HTMLElement;
const logEl = document.getElementById('log') as HTMLElement;

function hashHue(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 360;
}

function agentColor(id: string): { body: string; head: string } {
  const h = hashHue(id);
  return {
    body: `hsl(${h} 65% 52%)`,
    head: `hsl(${(h + 22) % 360} 70% 78%)`,
  };
}

function appendLog(line: string): void {
  const row = document.createElement('div');
  row.textContent = line;
  logEl.appendChild(row);
  while (logEl.children.length > 60) logEl.removeChild(logEl.firstChild!);
  logEl.scrollTop = logEl.scrollHeight;
}

function upsertAgent(snap: AgentSnap): void {
  const now = performance.now();
  const existing = state.agents.get(snap.id);
  if (!existing) {
    state.agents.set(snap.id, {
      id: snap.id,
      name: snap.name,
      zone: snap.zone ?? null,
      from: { ...snap.position },
      to: { ...snap.position },
      moveStart: now,
      moveDurMs: 0,
      facing: snap.facing,
      action: snap.currentAction,
      color: agentColor(snap.id),
      speech: null,
    });
    return;
  }
  existing.from = { ...snap.position };
  existing.to = { ...snap.position };
  existing.moveStart = now;
  existing.moveDurMs = 0;
  existing.zone = snap.zone ?? null;
  existing.facing = snap.facing;
  existing.action = snap.currentAction;
}

function applySnapshot(snapshot: Snapshot): void {
  state.width = snapshot.map.width;
  state.height = snapshot.map.height;
  state.zones = snapshot.map.zones;
  state.speed = snapshot.speed;
  state.simTime = snapshot.simTime;
  state.clock = snapshot.clock ?? deriveWorldClock(snapshot.simTime, snapshot.speed);
  state.agents.clear();
  state.conversations.clear();
  for (const a of snapshot.agents) upsertAgent(a);
  canvas.width = state.width * TILE;
  canvas.height = state.height * TILE;
}

function applyDelta(d: Delta): void {
  const now = performance.now();
  switch (d.kind) {
    case 'tick':
      state.simTime = d.simTime;
      if (d.clock) state.clock = d.clock;
      return;
    case 'agent_spawn':
      upsertAgent(d.agent);
      appendLog(`→ ${d.agent.name} enters`);
      return;
    case 'agent_despawn':
      state.agents.delete(d.id);
      return;
    case 'agent_move': {
      const a = state.agents.get(d.id);
      if (!a) return;
      a.from = { ...d.from };
      a.to = { ...d.to };
      a.moveStart = now;
      a.moveDurMs = d.durationMs;
      if (d.to.x > d.from.x) a.facing = 'E';
      else if (d.to.x < d.from.x) a.facing = 'W';
      else if (d.to.y > d.from.y) a.facing = 'S';
      else if (d.to.y < d.from.y) a.facing = 'N';
      return;
    }
    case 'agent_action': {
      const a = state.agents.get(d.id);
      if (a) a.action = d.action;
      return;
    }
    case 'speech': {
      const a = state.agents.get(d.id);
      if (!a) return;
      a.speech = { text: d.text, until: now + d.ttlMs };
      appendLog(`💬 ${a.name}: ${d.text}`);
      return;
    }
    case 'conversation_open':
      state.conversations.set(d.sessionId, { participants: [...d.participants] });
      appendLog(`• conversation opened: ${d.participants.join(', ')}`);
      return;
    case 'conversation_close':
      state.conversations.delete(d.sessionId);
      appendLog(
        `◦ conversation closed (${d.transcript.length} turns): ${d.participants.join(', ')}`,
      );
      return;
  }
}

function interpPos(a: AgentView): Vec2 {
  if (a.moveDurMs <= 0) return a.to;
  const t = Math.min(1, (performance.now() - a.moveStart) / a.moveDurMs);
  return {
    x: a.from.x + (a.to.x - a.from.x) * t,
    y: a.from.y + (a.to.y - a.from.y) * t,
  };
}

function zoneColor(name: string): string {
  if (name === 'cafe') return 'rgba(220, 170, 100, 0.22)';
  if (name === 'park') return 'rgba(96, 200, 128, 0.22)';
  if (name === 'home') return 'rgba(220, 120, 170, 0.22)';
  return 'rgba(180, 180, 220, 0.2)';
}

function zoneStroke(name: string): string {
  if (name === 'cafe') return 'rgba(220, 170, 100, 0.6)';
  if (name === 'park') return 'rgba(96, 200, 128, 0.6)';
  if (name === 'home') return 'rgba(220, 120, 170, 0.6)';
  return 'rgba(180, 180, 220, 0.5)';
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function phasePalette(phase: DayPhase): { base: string; tint: string; tintAlpha: number } {
  switch (phase) {
    case 'dawn':
      return { base: '#2c2442', tint: 'rgba(255, 180, 130, 0.15)', tintAlpha: 0.15 };
    case 'day':
      return { base: '#2c3559', tint: 'rgba(255, 255, 210, 0.0)', tintAlpha: 0 };
    case 'dusk':
      return { base: '#2a1f3c', tint: 'rgba(255, 120, 90, 0.22)', tintAlpha: 0.22 };
    default:
      return { base: '#0e0b24', tint: 'rgba(10, 15, 50, 0.45)', tintAlpha: 0.45 };
  }
}

function hourFraction(clock: WorldClock): number {
  return clock.hour + clock.minute / 60;
}

/** Interpolate a phase tint from the current fractional hour so transitions are smooth. */
function currentPhaseTint(clock: WorldClock): { base: string; tint: string; tintAlpha: number } {
  const h = hourFraction(clock);
  const phases: Array<{ start: number; palette: ReturnType<typeof phasePalette> }> = [
    { start: 0, palette: phasePalette('night') },
    { start: 5, palette: phasePalette('dawn') },
    { start: 7, palette: phasePalette('day') },
    { start: 19, palette: phasePalette('dusk') },
    { start: 21, palette: phasePalette('night') },
  ];
  let lo = phases[phases.length - 1]!;
  let hi = phases[0]!;
  for (let i = 0; i < phases.length - 1; i++) {
    if (h >= phases[i]!.start && h < phases[i + 1]!.start) {
      lo = phases[i]!;
      hi = phases[i + 1]!;
      break;
    }
  }
  const span = (hi.start - lo.start + 24) % 24 || 24;
  const t = Math.min(1, Math.max(0, ((h - lo.start + 24) % 24) / span));
  const alpha = lo.palette.tintAlpha + (hi.palette.tintAlpha - lo.palette.tintAlpha) * t;
  return { base: lo.palette.base, tint: lo.palette.tint, tintAlpha: alpha };
}

function draw(): void {
  if (!ctx || state.width === 0) {
    requestAnimationFrame(draw);
    return;
  }

  const palette = currentPhaseTint(state.clock);
  ctx.fillStyle = palette.base;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= state.width; x++) {
    ctx.beginPath();
    ctx.moveTo(x * TILE + 0.5, 0);
    ctx.lineTo(x * TILE + 0.5, state.height * TILE);
    ctx.stroke();
  }
  for (let y = 0; y <= state.height; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * TILE + 0.5);
    ctx.lineTo(state.width * TILE, y * TILE + 0.5);
    ctx.stroke();
  }

  for (const z of state.zones) {
    ctx.fillStyle = zoneColor(z.name);
    ctx.fillRect(z.x * TILE, z.y * TILE, z.width * TILE, z.height * TILE);
    ctx.strokeStyle = zoneStroke(z.name);
    ctx.strokeRect(z.x * TILE + 0.5, z.y * TILE + 0.5, z.width * TILE - 1, z.height * TILE - 1);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillText(z.name, z.x * TILE + 6, z.y * TILE + 14);
  }

  // conversation links
  ctx.strokeStyle = 'rgba(255, 240, 170, 0.4)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  for (const conv of state.conversations.values()) {
    const pts = conv.participants
      .map((id) => state.agents.get(id))
      .filter((a): a is AgentView => !!a)
      .map((a) => interpPos(a));
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        ctx.beginPath();
        ctx.moveTo(pts[i]!.x * TILE + TILE / 2, pts[i]!.y * TILE + TILE / 2);
        ctx.lineTo(pts[j]!.x * TILE + TILE / 2, pts[j]!.y * TILE + TILE / 2);
        ctx.stroke();
      }
    }
  }
  ctx.setLineDash([]);

  const now = performance.now();
  const sorted = [...state.agents.values()].sort((a, b) => interpPos(a).y - interpPos(b).y);
  for (const a of sorted) {
    const p = interpPos(a);
    const px = p.x * TILE;
    const py = p.y * TILE;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.beginPath();
    ctx.ellipse(px + TILE / 2, py + TILE - 3, 7, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = a.color.body;
    ctx.fillRect(px + TILE / 2 - 4, py + 10, 8, 10);
    ctx.fillStyle = a.color.head;
    ctx.fillRect(px + TILE / 2 - 3, py + 4, 6, 6);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    const eyeY = py + 6;
    if (a.facing === 'E') {
      ctx.fillRect(px + TILE / 2 + 1, eyeY, 1, 1);
    } else if (a.facing === 'W') {
      ctx.fillRect(px + TILE / 2 - 2, eyeY, 1, 1);
    } else if (a.facing === 'N') {
      ctx.fillRect(px + TILE / 2 - 2, eyeY - 1, 1, 1);
      ctx.fillRect(px + TILE / 2 + 1, eyeY - 1, 1, 1);
    } else {
      ctx.fillRect(px + TILE / 2 - 2, eyeY + 1, 1, 1);
      ctx.fillRect(px + TILE / 2 + 1, eyeY + 1, 1, 1);
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.font = '9px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(a.name.split(' ')[0] ?? a.id, px + TILE / 2, py - 2);
    ctx.textAlign = 'left';

    if (a.speech && a.speech.until > now) {
      const text = a.speech.text.length > 36 ? `${a.speech.text.slice(0, 35)}…` : a.speech.text;
      ctx.font = '10px ui-monospace, Menlo, monospace';
      const pad = 5;
      const w = ctx.measureText(text).width + pad * 2;
      const h = 16;
      const bx = Math.max(2, Math.min(canvas.width - w - 2, px + TILE / 2 - w / 2));
      const by = py - 22;
      ctx.fillStyle = 'rgba(245, 245, 255, 0.95)';
      roundRect(ctx, bx, by, w, h, 4);
      ctx.fill();
      ctx.fillStyle = 'rgba(245, 245, 255, 0.95)';
      ctx.beginPath();
      ctx.moveTo(px + TILE / 2 - 3, by + h);
      ctx.lineTo(px + TILE / 2, by + h + 3);
      ctx.lineTo(px + TILE / 2 + 3, by + h);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.textAlign = 'center';
      ctx.fillText(text, bx + w / 2, by + 11);
      ctx.textAlign = 'left';
    } else if (a.speech && a.speech.until <= now) {
      a.speech = null;
    }
  }

  // Day/night tint overlay on top of the world
  if (palette.tintAlpha > 0) {
    ctx.fillStyle = palette.tint;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const convCount = state.conversations.size;
  const clockStr = formatClock(state.clock);
  statsEl.textContent = `${state.connected ? 'live' : 'offline'}  ·  ${clockStr}  ·  ${state.agents.size} agents  ·  ${convCount} conversation${convCount === 1 ? '' : 's'}  ·  ${state.speed}× speed`;

  requestAnimationFrame(draw);
}

const WEEKDAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function formatClock(clock: WorldClock): string {
  const hh = String(clock.hour).padStart(2, '0');
  const mm = String(clock.minute).padStart(2, '0');
  const weekday = WEEKDAY_NAMES[clock.dayOfWeek] ?? '';
  return `day ${clock.day} · ${weekday} ${hh}:${mm} · ${clock.phase}`;
}

function connect(): void {
  const es = new EventSource('/stream');
  es.onopen = () => {
    state.connected = true;
    state.lastMessageAt = performance.now();
  };
  es.onerror = () => {
    state.connected = false;
    statsEl.textContent = 'disconnected — retrying…';
  };
  es.onmessage = (ev) => {
    state.lastMessageAt = performance.now();
    let msg: StreamMessage;
    try {
      msg = JSON.parse(ev.data) as StreamMessage;
    } catch {
      return;
    }
    if (msg.kind === 'snapshot') applySnapshot(msg);
    else applyDelta(msg);
  };
}

connect();
requestAnimationFrame(draw);

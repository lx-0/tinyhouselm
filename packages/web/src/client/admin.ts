import type {
  AgentMood,
  AgentSnap,
  ConversationTurn,
  Delta,
  PlanContext,
  SimTime,
  Snapshot,
  StreamMessage,
  WorldClock,
} from '@tina/shared';
import { deriveWorldClock } from '@tina/shared';

interface BootstrapPayload {
  snapshot: Snapshot;
  conversations: Array<{
    sessionId: string;
    participants: string[];
    participantNames: string[];
    transcript: ConversationTurn[];
    openedAt: SimTime;
    closedAt: SimTime;
    reason: string;
  }>;
  planEvents: Array<{
    kind: 'plan_committed' | 'plan_replan' | 'plan_resume';
    id: string;
    name: string;
    simTime: SimTime;
    detail: string;
  }>;
  reflections: Array<{
    id: string;
    name: string;
    reflectionId: string;
    summary: string;
    sourceCount: number;
    trigger: string;
    simTime: SimTime;
  }>;
  relations: Array<{
    a: string;
    b: string;
    conversations: number;
    turns: number;
    lastAt: SimTime;
  }>;
}

interface ConversationRow {
  sessionId: string;
  participants: string[];
  transcript: ConversationTurn[];
  openedAt: SimTime;
  closedAt: SimTime | null;
  live: boolean;
  reason: string | null;
}

interface AgentView {
  id: string;
  name: string;
  zone: string | null;
  action: string;
  mood: AgentMood;
  plan: PlanContext | null;
  recent: string[];
}

interface RelationEdge {
  a: string;
  b: string;
  conversations: number;
  turns: number;
  lastAt: SimTime;
}

const MAX_CONV_ROWS = 60;
const MAX_RECENT_PER_AGENT = 5;
const MAX_TRANSCRIPT_LINES = 20;

const state = {
  agents: new Map<string, AgentView>(),
  conversations: new Map<string, ConversationRow>(),
  relations: new Map<string, RelationEdge>(),
  clock: deriveWorldClock(0, 1),
  connected: false,
  agentFilter: '',
  convFilter: '',
};

const clockEl = document.getElementById('clock') as HTMLElement;
const convListEl = document.getElementById('conv-list') as HTMLElement;
const agentListEl = document.getElementById('agent-list') as HTMLElement;
const graphEl = document.getElementById('graph') as unknown as SVGSVGElement;
const graphEmptyEl = document.getElementById('graph-empty') as HTMLElement;
const agentFilterEl = document.getElementById('agent-filter') as HTMLInputElement;
const convFilterEl = document.getElementById('conv-filter') as HTMLInputElement;

agentFilterEl.addEventListener('input', () => {
  state.agentFilter = agentFilterEl.value.trim().toLowerCase();
  renderAgents();
});
convFilterEl.addEventListener('input', () => {
  state.convFilter = convFilterEl.value.trim().toLowerCase();
  renderConversations();
});

function hashHue(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 360;
}

function agentColor(id: string): string {
  return `hsl(${hashHue(id)} 65% 58%)`;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function displayName(id: string): string {
  return state.agents.get(id)?.name ?? id;
}

function mergeAgent(snap: AgentSnap): void {
  const existing = state.agents.get(snap.id);
  const recent = existing?.recent ?? [];
  state.agents.set(snap.id, {
    id: snap.id,
    name: snap.name,
    zone: snap.zone ?? null,
    action: snap.currentAction,
    mood: snap.mood ?? 'idle',
    plan: snap.plan ?? existing?.plan ?? null,
    recent,
  });
}

function pushAgentEvent(id: string, text: string): void {
  const a = state.agents.get(id);
  if (!a) return;
  a.recent.unshift(text);
  if (a.recent.length > MAX_RECENT_PER_AGENT) a.recent.length = MAX_RECENT_PER_AGENT;
}

function applyBootstrap(b: BootstrapPayload): void {
  state.clock = b.snapshot.clock;
  state.agents.clear();
  for (const snap of b.snapshot.agents) mergeAgent(snap);
  state.conversations.clear();
  for (const c of b.conversations) {
    state.conversations.set(c.sessionId, {
      sessionId: c.sessionId,
      participants: c.participants,
      transcript: c.transcript,
      openedAt: c.openedAt,
      closedAt: c.closedAt,
      live: false,
      reason: c.reason,
    });
  }
  state.relations.clear();
  for (const r of b.relations) {
    state.relations.set(pairKey(r.a, r.b), { ...r });
  }
  for (const p of b.planEvents) {
    pushAgentEvent(p.id, `${p.kind.replace('plan_', '')}: ${shortText(p.detail, 60)}`);
  }
  for (const r of b.reflections) {
    pushAgentEvent(r.id, `reflect: ${shortText(r.summary, 60)}`);
  }
  renderAll();
}

function applyDelta(d: Delta): void {
  switch (d.kind) {
    case 'tick':
      state.clock = d.clock;
      renderClock();
      return;
    case 'agent_spawn':
      mergeAgent(d.agent);
      renderAgents();
      return;
    case 'agent_action': {
      const a = state.agents.get(d.id);
      if (a) a.action = d.action;
      renderAgents();
      return;
    }
    case 'speech': {
      const a = state.agents.get(d.id);
      if (!a) return;
      const row = findOrOpenLiveConv(d.id);
      row.transcript.push({ speakerId: d.id, text: d.text, at: state.clock.simTime });
      row.closedAt = state.clock.simTime;
      renderConversations();
      return;
    }
    case 'conversation_open': {
      state.conversations.set(d.sessionId, {
        sessionId: d.sessionId,
        participants: [...d.participants],
        transcript: [],
        openedAt: d.simTime,
        closedAt: null,
        live: true,
        reason: null,
      });
      renderConversations();
      return;
    }
    case 'conversation_close': {
      const row = state.conversations.get(d.sessionId);
      if (row) {
        row.transcript = d.transcript;
        row.closedAt = d.simTime;
        row.live = false;
        row.reason = d.reason;
      } else {
        state.conversations.set(d.sessionId, {
          sessionId: d.sessionId,
          participants: [...d.participants],
          transcript: d.transcript,
          openedAt: d.transcript[0]?.at ?? d.simTime,
          closedAt: d.simTime,
          live: false,
          reason: d.reason,
        });
      }
      updateRelationsFromClose(d.participants, d.transcript, d.simTime);
      trimConversations();
      renderConversations();
      renderGraph();
      return;
    }
    case 'plan_committed': {
      pushAgentEvent(d.id, `committed: ${shortText(d.summary, 60)}`);
      refreshAgentPlan(d.id);
      renderAgents();
      return;
    }
    case 'plan_replan': {
      pushAgentEvent(d.id, `replan (${d.reason}): ${shortText(d.detail, 60)}`);
      renderAgents();
      return;
    }
    case 'plan_resume': {
      pushAgentEvent(d.id, `resume: ${d.reason}`);
      renderAgents();
      return;
    }
    case 'reflection': {
      pushAgentEvent(d.id, `reflect: ${shortText(d.summary, 60)}`);
      renderAgents();
      return;
    }
    case 'agent_context': {
      const a = state.agents.get(d.id);
      if (!a) return;
      a.mood = d.mood;
      a.plan = d.plan;
      renderAgents();
      return;
    }
  }
}

function findOrOpenLiveConv(speakerId: string): ConversationRow {
  for (const row of state.conversations.values()) {
    if (row.live && row.participants.includes(speakerId)) return row;
  }
  // Create an implicit row for loner speech so the feed still shows it.
  const id = `solo:${speakerId}:${state.clock.simTime}`;
  const row: ConversationRow = {
    sessionId: id,
    participants: [speakerId],
    transcript: [],
    openedAt: state.clock.simTime,
    closedAt: null,
    live: true,
    reason: null,
  };
  state.conversations.set(id, row);
  return row;
}

function updateRelationsFromClose(
  participants: string[],
  transcript: ConversationTurn[],
  closedAt: SimTime,
): void {
  const turnsBySpeaker = new Map<string, number>();
  for (const t of transcript) {
    turnsBySpeaker.set(t.speakerId, (turnsBySpeaker.get(t.speakerId) ?? 0) + 1);
  }
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      const a = participants[i]!;
      const b = participants[j]!;
      const key = pairKey(a, b);
      const existing = state.relations.get(key);
      const turns = (turnsBySpeaker.get(a) ?? 0) + (turnsBySpeaker.get(b) ?? 0);
      if (existing) {
        existing.conversations += 1;
        existing.turns += turns;
        existing.lastAt = Math.max(existing.lastAt, closedAt);
      } else {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        state.relations.set(key, { a: lo, b: hi, conversations: 1, turns, lastAt: closedAt });
      }
    }
  }
}

function trimConversations(): void {
  if (state.conversations.size <= MAX_CONV_ROWS) return;
  const sorted = [...state.conversations.values()].sort(
    (x, y) => (y.closedAt ?? y.openedAt) - (x.closedAt ?? x.openedAt),
  );
  state.conversations.clear();
  for (const row of sorted.slice(0, MAX_CONV_ROWS)) {
    state.conversations.set(row.sessionId, row);
  }
}

function refreshAgentPlan(_id: string): void {
  // Plan summary arrives via next tick's snapshot or agent_context event.
  // No-op here beyond leaving the hook for future enrichments.
}

function shortText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

const WEEKDAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
function formatClock(clock: WorldClock): string {
  const hh = String(clock.hour).padStart(2, '0');
  const mm = String(clock.minute).padStart(2, '0');
  const weekday = WEEKDAY_NAMES[clock.dayOfWeek] ?? '';
  return `day ${clock.day} · ${weekday} ${hh}:${mm} · ${clock.phase}`;
}

function renderAll(): void {
  renderClock();
  renderConversations();
  renderAgents();
  renderGraph();
}

function renderClock(): void {
  const conn = state.connected ? 'live' : 'offline';
  const status = state.connected ? '' : '<span class="disconnected"> — reconnecting…</span>';
  clockEl.innerHTML = `${conn} · ${formatClock(state.clock)} · ${state.agents.size} agents · ${state.conversations.size} conversations${status}`;
}

function renderConversations(): void {
  const rows = [...state.conversations.values()].sort((x, y) => {
    if (x.live !== y.live) return x.live ? -1 : 1;
    return (y.closedAt ?? y.openedAt) - (x.closedAt ?? x.openedAt);
  });
  const filter = state.convFilter;
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const names = row.participants.map(displayName);
    if (filter && !names.some((n) => n.toLowerCase().includes(filter))) continue;
    const el = document.createElement('div');
    el.className = `conv${row.live ? ' live' : ''}`;
    const header = document.createElement('header');
    const parts = document.createElement('span');
    parts.className = 'participants';
    parts.textContent = names.join(' · ');
    const meta = document.createElement('span');
    meta.className = 'meta';
    const simTime = row.closedAt ?? row.openedAt;
    meta.textContent = row.live
      ? `live · ${row.transcript.length}t`
      : `${row.transcript.length}t · ${row.reason ?? 'closed'}`;
    header.appendChild(parts);
    header.appendChild(meta);
    el.appendChild(header);
    const shown = row.transcript.slice(-MAX_TRANSCRIPT_LINES);
    for (const t of shown) {
      const line = document.createElement('div');
      line.className = 'turn';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = displayName(t.speakerId);
      line.appendChild(name);
      line.appendChild(document.createTextNode(`: ${t.text}`));
      el.appendChild(line);
    }
    if (row.transcript.length > MAX_TRANSCRIPT_LINES) {
      const hint = document.createElement('div');
      hint.className = 'turn';
      hint.style.opacity = '0.5';
      hint.textContent = `(${row.transcript.length - MAX_TRANSCRIPT_LINES} earlier turns hidden)`;
      el.appendChild(hint);
    }
    // Keep var from complaint; simTime currently unused in markup.
    void simTime;
    frag.appendChild(el);
  }
  convListEl.replaceChildren(frag);
}

function renderAgents(): void {
  const agents = [...state.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  const filter = state.agentFilter;
  const frag = document.createDocumentFragment();
  for (const a of agents) {
    if (filter && !a.name.toLowerCase().includes(filter)) continue;
    const el = document.createElement('div');
    el.className = 'agent-card';

    const row1 = document.createElement('div');
    row1.className = 'row1';
    const name = document.createElement('span');
    name.className = 'name';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = agentColor(a.id);
    name.appendChild(sw);
    name.appendChild(document.createTextNode(a.name));
    const mood = document.createElement('span');
    mood.className = 'mood';
    mood.textContent = a.mood;
    row1.appendChild(name);
    row1.appendChild(mood);
    el.appendChild(row1);

    const intent = document.createElement('div');
    intent.className = 'intent';
    intent.textContent = a.plan?.blockIntent ?? '(no plan yet)';
    el.appendChild(intent);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const zone = a.zone ?? '—';
    const block = a.plan ? `${a.plan.blockId}/${a.plan.blockActivity}` : '—';
    meta.textContent = `${zone} · ${block} · ${shortText(a.action, 40)}`;
    el.appendChild(meta);

    if (a.plan?.suspendedReason) {
      const s = document.createElement('div');
      s.className = 'suspend';
      s.textContent = `paused: ${a.plan.suspendedReason}`;
      el.appendChild(s);
    }

    if (a.recent.length > 0) {
      const rec = document.createElement('div');
      rec.className = 'recent';
      rec.innerHTML = a.recent.map((r) => escapeHtml(r)).join('<br>');
      el.appendChild(rec);
    }

    frag.appendChild(el);
  }
  agentListEl.replaceChildren(frag);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderGraph(): void {
  const edges = [...state.relations.values()].filter(
    (e) => state.agents.has(e.a) && state.agents.has(e.b),
  );
  const nodeIds = new Set<string>();
  for (const e of edges) {
    nodeIds.add(e.a);
    nodeIds.add(e.b);
  }
  const nodes = [...nodeIds].sort();
  graphEmptyEl.style.display = edges.length === 0 ? 'flex' : 'none';
  if (nodes.length === 0) {
    graphEl.innerHTML = '';
    return;
  }
  const w = 800;
  const h = 600;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.4;
  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((id, i) => {
    const a = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
    positions.set(id, { x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
  });
  const maxTurns = edges.reduce((m, e) => Math.max(m, e.turns), 1);

  graphEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const parts: string[] = [];
  for (const e of edges) {
    const p1 = positions.get(e.a)!;
    const p2 = positions.get(e.b)!;
    const strength = Math.max(0.25, Math.min(1, e.turns / maxTurns));
    const stroke = `rgba(185, 176, 220, ${0.25 + strength * 0.55})`;
    const strokeWidth = 1 + strength * 3;
    parts.push(
      `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="${stroke}" stroke-width="${strokeWidth.toFixed(2)}" />`,
    );
  }
  for (const id of nodes) {
    const p = positions.get(id)!;
    const color = agentColor(id);
    const name = displayName(id);
    parts.push(
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="10" fill="${color}" stroke="rgba(0,0,0,0.5)" stroke-width="1" />`,
    );
    const labelY = p.y + (p.y < cy ? -16 : 22);
    parts.push(
      `<text x="${p.x.toFixed(1)}" y="${labelY.toFixed(1)}" fill="rgba(231,229,238,0.85)" font-family="ui-monospace, Menlo, monospace" font-size="11" text-anchor="middle">${escapeHtml(name)}</text>`,
    );
  }
  graphEl.innerHTML = parts.join('');
}

async function bootstrap(): Promise<void> {
  try {
    const res = await fetch('/api/admin/bootstrap');
    if (!res.ok) throw new Error(`bootstrap http ${res.status}`);
    const data = (await res.json()) as BootstrapPayload;
    applyBootstrap(data);
  } catch (err) {
    console.warn('[admin] bootstrap failed', err);
  }
}

function connect(): void {
  const es = new EventSource('/stream');
  es.onopen = () => {
    state.connected = true;
    renderClock();
  };
  es.onerror = () => {
    state.connected = false;
    renderClock();
  };
  es.onmessage = (ev) => {
    let msg: StreamMessage;
    try {
      msg = JSON.parse(ev.data) as StreamMessage;
    } catch {
      return;
    }
    if ((msg as Snapshot).kind === 'snapshot') {
      const snap = msg as Snapshot;
      state.clock = snap.clock;
      for (const a of snap.agents) mergeAgent(a);
      renderAll();
    } else {
      applyDelta(msg as Delta);
    }
  };
}

void bootstrap().then(() => connect());

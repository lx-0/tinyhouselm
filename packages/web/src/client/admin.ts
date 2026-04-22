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
  WorldObject,
  Zone,
} from '@tina/shared';
import { deriveWorldClock } from '@tina/shared';

interface SnapshotStatusPayload {
  enabled: boolean;
  everyTicks: number;
  dir: string;
  lastSavedAt: string | null;
  lastTickIndex: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  inFlight: boolean;
  saves: number;
  failures: number;
}

interface BootstrapPayload {
  snapshot: Snapshot;
  snapshotStatus: SnapshotStatusPayload | null;
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
  reflections: ReflectionView[];
}

interface ReflectionView {
  id: string;
  summary: string;
  trigger: string;
  sourceCount: number;
  simTime: SimTime;
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
const MAX_REFLECTIONS_PER_AGENT = 3;

const state = {
  agents: new Map<string, AgentView>(),
  conversations: new Map<string, ConversationRow>(),
  relations: new Map<string, RelationEdge>(),
  objects: new Map<string, WorldObject>(),
  zones: [] as Zone[],
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
  const reflections = existing?.reflections ?? [];
  state.agents.set(snap.id, {
    id: snap.id,
    name: snap.name,
    zone: snap.zone ?? null,
    action: snap.currentAction,
    mood: snap.mood ?? 'idle',
    plan: snap.plan ?? existing?.plan ?? null,
    recent,
    reflections,
  });
}

function pushAgentEvent(id: string, text: string): void {
  const a = state.agents.get(id);
  if (!a) return;
  a.recent.unshift(text);
  if (a.recent.length > MAX_RECENT_PER_AGENT) a.recent.length = MAX_RECENT_PER_AGENT;
}

function pushAgentReflection(id: string, r: ReflectionView): void {
  const a = state.agents.get(id);
  if (!a) return;
  if (a.reflections.some((x) => x.id === r.id)) return;
  a.reflections.unshift(r);
  if (a.reflections.length > MAX_REFLECTIONS_PER_AGENT) {
    a.reflections.length = MAX_REFLECTIONS_PER_AGENT;
  }
}

function applyBootstrap(b: BootstrapPayload): void {
  state.clock = b.snapshot.clock;
  state.agents.clear();
  for (const snap of b.snapshot.agents) mergeAgent(snap);
  state.zones = [...b.snapshot.map.zones];
  state.objects.clear();
  for (const o of b.snapshot.map.objects ?? []) state.objects.set(o.id, o);
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
  // Bootstrap delivers newest-first already; iterate in reverse so the
  // per-agent `reflections` list ends up newest-first after unshift.
  for (let i = b.reflections.length - 1; i >= 0; i--) {
    const r = b.reflections[i]!;
    pushAgentEvent(r.id, `reflect: ${shortText(r.summary, 60)}`);
    pushAgentReflection(r.id, {
      id: r.reflectionId,
      summary: r.summary,
      trigger: r.trigger,
      sourceCount: r.sourceCount,
      simTime: r.simTime,
    });
  }
  refreshInterventionControls();
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
      refreshInterventionControls();
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
      pushAgentReflection(d.id, {
        id: d.reflectionId,
        summary: d.summary,
        trigger: d.trigger,
        sourceCount: d.sourceCount,
        simTime: d.simTime,
      });
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
    case 'object_add': {
      state.objects.set(d.object.id, d.object);
      renderObjectList();
      return;
    }
    case 'object_remove': {
      state.objects.delete(d.id);
      renderObjectList();
      return;
    }
    case 'intervention': {
      if (d.target) {
        pushAgentEvent(d.target, `${d.type}: ${shortText(d.summary, 60)}`);
      }
      for (const id of d.affected) {
        if (id === d.target) continue;
        pushAgentEvent(id, `${d.type}: ${shortText(d.summary, 60)}`);
      }
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

    if (a.reflections.length > 0) {
      const ref = document.createElement('div');
      ref.className = 'reflections';
      const header = document.createElement('div');
      header.className = 'reflections-header';
      header.textContent = `reflections (${a.reflections.length})`;
      ref.appendChild(header);
      for (const r of a.reflections) {
        const bullet = document.createElement('div');
        bullet.className = 'reflect-bullet';
        const label = document.createElement('span');
        label.className = 'reflect-tag';
        label.textContent = `${r.trigger.replace('_', '·')} · ${r.sourceCount} facts`;
        bullet.appendChild(label);
        bullet.appendChild(document.createTextNode(` ${r.summary}`));
        ref.appendChild(bullet);
      }
      el.appendChild(ref);
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

const whisperAgentSel = document.getElementById('whisper-agent') as HTMLSelectElement;
const whisperTextEl = document.getElementById('whisper-text') as HTMLInputElement;
const whisperSendBtn = document.getElementById('whisper-send') as HTMLButtonElement;
const whisperStatusEl = document.getElementById('whisper-status') as HTMLElement;
const eventTextEl = document.getElementById('event-text') as HTMLInputElement;
const eventZoneSel = document.getElementById('event-zone') as HTMLSelectElement;
const eventSendBtn = document.getElementById('event-send') as HTMLButtonElement;
const eventStatusEl = document.getElementById('event-status') as HTMLElement;
const objectLabelEl = document.getElementById('object-label') as HTMLInputElement;
const objectZoneSel = document.getElementById('object-zone') as HTMLSelectElement;
const objectDropBtn = document.getElementById('object-drop') as HTMLButtonElement;
const objectStatusEl = document.getElementById('object-status') as HTMLElement;
const objectListEl = document.getElementById('object-list') as HTMLElement;
const adminTokenEl = document.getElementById('admin-token') as HTMLInputElement;

adminTokenEl.value = sessionStorage.getItem('adminToken') ?? '';
adminTokenEl.addEventListener('input', () => {
  sessionStorage.setItem('adminToken', adminTokenEl.value);
});

function refreshInterventionControls(): void {
  const sortedAgents = [...state.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  const prior = whisperAgentSel.value;
  whisperAgentSel.replaceChildren();
  for (const a of sortedAgents) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name;
    whisperAgentSel.appendChild(opt);
  }
  if (prior && sortedAgents.some((a) => a.id === prior)) whisperAgentSel.value = prior;
  for (const sel of [eventZoneSel, objectZoneSel]) {
    const priorZone = sel.value;
    const head = sel.firstElementChild as HTMLOptionElement | null;
    sel.replaceChildren();
    if (head) sel.appendChild(head);
    for (const z of state.zones) {
      const opt = document.createElement('option');
      opt.value = z.name;
      opt.textContent = z.name;
      sel.appendChild(opt);
    }
    if (priorZone) sel.value = priorZone;
  }
  renderObjectList();
}

function renderObjectList(): void {
  const objs = [...state.objects.values()].sort((a, b) => b.droppedAtSim - a.droppedAtSim);
  const frag = document.createDocumentFragment();
  if (objs.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = '(no active objects)';
    empty.style.opacity = '0.5';
    frag.appendChild(empty);
  }
  for (const o of objs) {
    const row = document.createElement('div');
    row.className = 'obj';
    const label = document.createElement('span');
    const zone = o.zone ? ` · ${o.zone}` : '';
    label.textContent = `${o.label}${zone}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'remove';
    btn.addEventListener('click', () => {
      void submitIntervention('object', { op: 'remove', id: o.id }, objectStatusEl, objectDropBtn);
    });
    row.appendChild(label);
    row.appendChild(btn);
    frag.appendChild(row);
  }
  objectListEl.replaceChildren(frag);
}

async function submitIntervention(
  kind: 'whisper' | 'event' | 'object',
  body: unknown,
  statusEl: HTMLElement,
  button: HTMLButtonElement,
): Promise<boolean> {
  statusEl.textContent = '…';
  statusEl.className = 'status';
  button.disabled = true;
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const token = adminTokenEl.value.trim();
    if (token) headers['x-admin-token'] = token;
    const res = await fetch(`/api/admin/intervention/${kind}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let parsed: { error?: string; affected?: string[] } = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok) {
      statusEl.textContent = `✗ ${res.status} ${parsed.error ?? raw.slice(0, 80)}`;
      statusEl.className = 'status err';
      return false;
    }
    const aff = parsed.affected ?? [];
    statusEl.textContent = `✓ sent · ${aff.length} agent${aff.length === 1 ? '' : 's'} affected`;
    statusEl.className = 'status ok';
    return true;
  } catch (err) {
    statusEl.textContent = `✗ ${(err as Error).message}`;
    statusEl.className = 'status err';
    return false;
  } finally {
    button.disabled = false;
  }
}

whisperSendBtn.addEventListener('click', () => {
  const agentId = whisperAgentSel.value;
  const text = whisperTextEl.value.trim();
  if (!agentId || !text) {
    whisperStatusEl.textContent = '✗ pick agent + text';
    whisperStatusEl.className = 'status err';
    return;
  }
  void submitIntervention('whisper', { agentId, text }, whisperStatusEl, whisperSendBtn).then(
    (ok) => {
      if (ok) whisperTextEl.value = '';
    },
  );
});

eventSendBtn.addEventListener('click', () => {
  const text = eventTextEl.value.trim();
  if (!text) {
    eventStatusEl.textContent = '✗ text required';
    eventStatusEl.className = 'status err';
    return;
  }
  const zone = eventZoneSel.value || undefined;
  void submitIntervention('event', { text, zone }, eventStatusEl, eventSendBtn).then((ok) => {
    if (ok) eventTextEl.value = '';
  });
});

objectDropBtn.addEventListener('click', () => {
  const label = objectLabelEl.value.trim();
  if (!label) {
    objectStatusEl.textContent = '✗ label required';
    objectStatusEl.className = 'status err';
    return;
  }
  const zone = objectZoneSel.value || undefined;
  void submitIntervention(
    'object',
    { op: 'drop', label, zone },
    objectStatusEl,
    objectDropBtn,
  ).then((ok) => {
    if (ok) objectLabelEl.value = '';
  });
});

const snapshotStatusEl = document.getElementById('snapshot-status') as HTMLElement;
const snapshotSaveBtn = document.getElementById('snapshot-save') as HTMLButtonElement;
const snapshotActionStatusEl = document.getElementById('snapshot-action-status') as HTMLElement;

function fmtRelative(iso: string): string {
  const age = Date.now() - Date.parse(iso);
  if (!Number.isFinite(age) || age < 0) return iso;
  const s = Math.round(age / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function renderSnapshotStatus(s: SnapshotStatusPayload | null): void {
  if (!s) {
    snapshotStatusEl.textContent = 'snapshots disabled';
    snapshotStatusEl.className = 'status';
    snapshotSaveBtn.disabled = true;
    return;
  }
  snapshotSaveBtn.disabled = false;
  if (s.lastError) {
    snapshotStatusEl.textContent = `last save failed: ${s.lastError}`;
    snapshotStatusEl.className = 'status err';
    return;
  }
  if (!s.lastSavedAt) {
    snapshotStatusEl.textContent = `no snapshot yet · cadence ${s.everyTicks} ticks`;
    snapshotStatusEl.className = 'status';
    return;
  }
  const tick = s.lastTickIndex ?? 0;
  const dur = s.lastDurationMs ?? 0;
  const suffix = s.inFlight ? ' · writing…' : '';
  snapshotStatusEl.textContent = `last snapshot: ${fmtRelative(s.lastSavedAt)} · ticks=${tick} · ${dur}ms${suffix}`;
  snapshotStatusEl.className = 'status ok';
}

async function fetchSnapshotStatus(): Promise<void> {
  try {
    const headers: Record<string, string> = {};
    const token = adminTokenEl.value.trim();
    if (token) headers['x-admin-token'] = token;
    const res = await fetch('/api/admin/snapshot/status', { headers });
    if (!res.ok) return;
    const data = (await res.json()) as { status: SnapshotStatusPayload | null };
    renderSnapshotStatus(data.status);
  } catch {
    // non-fatal; the periodic tick will retry
  }
}

snapshotSaveBtn.addEventListener('click', () => {
  void (async () => {
    snapshotActionStatusEl.textContent = 'saving…';
    snapshotActionStatusEl.className = 'status';
    snapshotSaveBtn.disabled = true;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const token = adminTokenEl.value.trim();
      if (token) headers['x-admin-token'] = token;
      const res = await fetch('/api/admin/snapshot/save', { method: 'POST', headers });
      const raw = await res.text();
      let parsed: { error?: string; status?: SnapshotStatusPayload } = {};
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        /* ignore */
      }
      if (!res.ok) {
        snapshotActionStatusEl.textContent = `✗ ${res.status} ${parsed.error ?? raw.slice(0, 80)}`;
        snapshotActionStatusEl.className = 'status err';
        return;
      }
      snapshotActionStatusEl.textContent = '✓ saved';
      snapshotActionStatusEl.className = 'status ok';
      if (parsed.status) renderSnapshotStatus(parsed.status);
    } catch (err) {
      snapshotActionStatusEl.textContent = `✗ ${(err as Error).message}`;
      snapshotActionStatusEl.className = 'status err';
    } finally {
      snapshotSaveBtn.disabled = false;
    }
  })();
});

// Poll periodically so the status line stays fresh even when nothing else updates.
setInterval(() => void fetchSnapshotStatus(), 15_000);

async function bootstrap(): Promise<void> {
  try {
    const res = await fetch('/api/admin/bootstrap');
    if (!res.ok) throw new Error(`bootstrap http ${res.status}`);
    const data = (await res.json()) as BootstrapPayload;
    applyBootstrap(data);
    renderSnapshotStatus(data.snapshotStatus);
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
      state.zones = [...snap.map.zones];
      state.objects.clear();
      for (const o of snap.map.objects ?? []) state.objects.set(o.id, o);
      refreshInterventionControls();
      renderAll();
    } else {
      applyDelta(msg as Delta);
    }
  };
}

void bootstrap().then(() => connect());

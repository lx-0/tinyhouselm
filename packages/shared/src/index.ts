export type Vec2 = { x: number; y: number };

export type SimTime = number;

export type DayPhase = 'night' | 'dawn' | 'day' | 'dusk';

export type WorldClock = {
  simTime: SimTime;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
  phase: DayPhase;
  speed: number;
};

const SECONDS_PER_DAY = 86400;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

export function deriveWorldClock(simTime: SimTime, speed: number): WorldClock {
  const wrapped = ((simTime % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const day = Math.floor(simTime / SECONDS_PER_DAY);
  const hour = Math.floor(wrapped / SECONDS_PER_HOUR);
  const minute = Math.floor((wrapped - hour * SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const dayOfWeek = ((day % 7) + 7) % 7;
  return { simTime, day, hour, minute, dayOfWeek, phase: dayPhaseForHour(hour), speed };
}

export function dayPhaseForHour(hour: number): DayPhase {
  if (hour >= 5 && hour < 7) return 'dawn';
  if (hour >= 7 && hour < 19) return 'day';
  if (hour >= 19 && hour < 21) return 'dusk';
  return 'night';
}

export type AgentAction =
  | { kind: 'move_to'; to: Vec2 }
  | { kind: 'goto'; target: Vec2; label?: string; affordance?: Affordance }
  | { kind: 'speak'; to: string | null; text: string }
  | { kind: 'wait'; seconds: number }
  | { kind: 'remember'; fact: string }
  | { kind: 'set_goal'; goal: string };

export type AgentMood =
  | 'focused'
  | 'chatty'
  | 'relaxed'
  | 'restless'
  | 'drowsy'
  | 'engaged'
  | 'idle';

export type PlanContext = {
  day: number;
  summary: string;
  blockId: string;
  blockIntent: string;
  blockActivity: string;
  preferredZone: string | null;
  suspendedReason: string | null;
};

export type AgentSnap = {
  id: string;
  name: string;
  position: Vec2;
  facing: 'N' | 'S' | 'E' | 'W';
  currentAction: string;
  zone?: string | null;
  gotoTarget?: Vec2 | null;
  mood?: AgentMood;
  plan?: PlanContext | null;
};

export type Zone = { name: string; x: number; y: number; width: number; height: number };

export type TileKind = 'grass' | 'path' | 'floor' | 'wall' | 'water' | 'door';

export type Tile = { kind: TileKind; walkable: boolean };

export type Affordance = 'sleep' | 'food' | 'coffee' | 'work' | 'leisure' | 'social';

export type Location = {
  id: string;
  name: string;
  area: string;
  affordances: Affordance[];
  anchor: Vec2;
  footprint?: { x: number; y: number; width: number; height: number };
};

export type TileMap = {
  width: number;
  height: number;
  tiles: Tile[];
  locations: Location[];
  areas: Zone[];
};

export type WorldObject = {
  id: string;
  label: string;
  pos: Vec2;
  zone: string | null;
  droppedAtSim: SimTime;
};

export type InterventionKind = 'whisper' | 'world_event' | 'object_drop' | 'object_remove';

export type ConversationTurn = {
  speakerId: string;
  text: string;
  at: SimTime;
};

export type Snapshot = {
  kind: 'snapshot';
  simTime: SimTime;
  speed: number;
  clock: WorldClock;
  map: {
    width: number;
    height: number;
    tiles: Tile[];
    zones: Zone[];
    locations: Location[];
    objects: WorldObject[];
  };
  agents: AgentSnap[];
};

export type Delta =
  | { kind: 'tick'; simTime: SimTime; clock: WorldClock }
  | { kind: 'agent_move'; id: string; from: Vec2; to: Vec2; durationMs: number }
  | { kind: 'agent_action'; id: string; action: string }
  | { kind: 'speech'; id: string; text: string; heardBy: string[]; ttlMs: number }
  | { kind: 'agent_spawn'; agent: AgentSnap }
  | { kind: 'agent_despawn'; id: string }
  | {
      kind: 'conversation_open';
      sessionId: string;
      participants: string[];
      simTime: SimTime;
    }
  | {
      kind: 'conversation_close';
      sessionId: string;
      participants: string[];
      transcript: ConversationTurn[];
      simTime: SimTime;
      reason: 'drifted' | 'idle' | 'aged';
    }
  | {
      kind: 'plan_committed';
      id: string;
      day: number;
      summary: string;
      simTime: SimTime;
    }
  | {
      kind: 'plan_replan';
      id: string;
      reason: string;
      detail: string;
      simTime: SimTime;
    }
  | {
      kind: 'plan_resume';
      id: string;
      reason: string;
      simTime: SimTime;
    }
  | {
      kind: 'reflection';
      id: string;
      reflectionId: string;
      summary: string;
      sourceCount: number;
      trigger: 'day_rollover' | 'importance_budget' | 'manual';
      simTime: SimTime;
    }
  | {
      kind: 'agent_context';
      id: string;
      mood: AgentMood;
      plan: PlanContext | null;
      simTime: SimTime;
    }
  | { kind: 'object_add'; object: WorldObject; simTime: SimTime }
  | { kind: 'object_remove'; id: string; label: string; simTime: SimTime }
  | {
      kind: 'intervention';
      type: InterventionKind;
      summary: string;
      target: string | null;
      zone: string | null;
      affected: string[];
      simTime: SimTime;
    };

export type StreamMessage = Snapshot | Delta;

/** Current save file schema version. Bump on any incompatible field change. */
export const WORLD_STATE_SNAPSHOT_VERSION = 1;

export type WorldStateAgentSnapshot = {
  id: string;
  position: Vec2;
  facing: 'N' | 'S' | 'E' | 'W';
  currentAction: string;
  zone: string | null;
};

export type WorldStateSnapshot = {
  version: number;
  savedAt: string;
  seed: number;
  tickIndex: number;
  interventionSeq: number;
  clock: {
    simTime: SimTime;
    ticks: number;
    speed: number;
  };
  world: {
    width: number;
    height: number;
    objects: WorldObject[];
  };
  agents: WorldStateAgentSnapshot[];
};

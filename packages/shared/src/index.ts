export type Vec2 = { x: number; y: number };

export type SimTime = number;

export type AgentAction =
  | { kind: 'move_to'; to: Vec2 }
  | { kind: 'goto'; target: Vec2; label?: string }
  | { kind: 'speak'; to: string | null; text: string }
  | { kind: 'wait'; seconds: number }
  | { kind: 'remember'; fact: string }
  | { kind: 'set_goal'; goal: string };

export type AgentSnap = {
  id: string;
  name: string;
  position: Vec2;
  facing: 'N' | 'S' | 'E' | 'W';
  currentAction: string;
  zone?: string | null;
  gotoTarget?: Vec2 | null;
};

export type Zone = { name: string; x: number; y: number; width: number; height: number };

export type ConversationTurn = {
  speakerId: string;
  text: string;
  at: SimTime;
};

export type Snapshot = {
  kind: 'snapshot';
  simTime: SimTime;
  speed: number;
  map: { width: number; height: number; tiles: number[]; zones: Zone[] };
  agents: AgentSnap[];
};

export type Delta =
  | { kind: 'tick'; simTime: SimTime }
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
      reason: 'drifted' | 'idle';
    };

export type StreamMessage = Snapshot | Delta;

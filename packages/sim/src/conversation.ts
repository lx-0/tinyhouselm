import type { ConversationTurn, SimTime, Vec2 } from '@tina/shared';
import { chebyshevDistance } from './perception.js';

export interface ConversationSession {
  id: string;
  participants: Set<string>;
  transcript: ConversationTurn[];
  openedAt: SimTime;
  lastActivityAt: SimTime;
}

export type CloseReason = 'drifted' | 'idle' | 'aged';

export interface ConversationObserver {
  onOpen?(session: ConversationSession): void;
  onClose?(session: ConversationSession, reason: CloseReason): void;
}

export interface ConversationOptions {
  speechRadius: number;
  idleTtlSim: number;
  /**
   * Hard cap on a single session's retained transcript. When a session
   * exceeds this on recordSpeech, the oldest turns are dropped. Prevents
   * unbounded memory growth in dense-chatter scenarios (many agents clumped
   * in one zone, all speaking every tick). Default: 50.
   */
  maxTranscriptTurns?: number;
  /**
   * Force-close a session that has been open longer than this (sim seconds),
   * even if participants are still nearby and actively speaking. Ensures
   * `persistConversation` eventually runs, which in turn feeds the
   * reflection engine's importance budget. Default: 1800 (30 sim-minutes).
   */
  maxAgeSim?: number;
}

type PairKey = string;

function pairKey(a: string, b: string): PairKey {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

const DEFAULT_MAX_TRANSCRIPT_TURNS = 50;
const DEFAULT_MAX_AGE_SIM = 1800;

export class ConversationRegistry {
  private sessions = new Map<PairKey, ConversationSession>();
  private nextId = 1;
  private readonly maxTranscriptTurns: number;
  private readonly maxAgeSim: number;

  constructor(private opts: ConversationOptions) {
    this.maxTranscriptTurns = opts.maxTranscriptTurns ?? DEFAULT_MAX_TRANSCRIPT_TURNS;
    this.maxAgeSim = opts.maxAgeSim ?? DEFAULT_MAX_AGE_SIM;
  }

  /**
   * Record a speech event. Any nearby listener + speaker pair with an
   * already-open session appends to the transcript. Otherwise, a new
   * session opens for each nearby listener.
   */
  recordSpeech(
    speakerId: string,
    text: string,
    at: SimTime,
    listeners: string[],
    observer: ConversationObserver,
  ): void {
    for (const listenerId of listeners) {
      const key = pairKey(speakerId, listenerId);
      let session = this.sessions.get(key);
      if (!session) {
        session = {
          id: `conv-${this.nextId++}`,
          participants: new Set([speakerId, listenerId]),
          transcript: [],
          openedAt: at,
          lastActivityAt: at,
        };
        this.sessions.set(key, session);
        observer.onOpen?.(session);
      }
      session.transcript.push({ speakerId, text, at });
      if (session.transcript.length > this.maxTranscriptTurns) {
        // Drop oldest turns to keep per-session memory bounded.
        session.transcript.splice(0, session.transcript.length - this.maxTranscriptTurns);
      }
      session.lastActivityAt = at;
    }
  }

  /**
   * Sweep sessions whose participants have drifted apart, gone idle, or
   * exceeded the max session age.
   */
  sweep(positions: Map<string, Vec2>, now: SimTime, observer: ConversationObserver): void {
    for (const [key, session] of [...this.sessions]) {
      const ids = [...session.participants];
      const a = ids[0] ? positions.get(ids[0]) : undefined;
      const b = ids[1] ? positions.get(ids[1]) : undefined;
      if (!a || !b) {
        this.sessions.delete(key);
        observer.onClose?.(session, 'drifted');
        continue;
      }
      const close: CloseReason | null =
        chebyshevDistance(a, b) > this.opts.speechRadius
          ? 'drifted'
          : now - session.lastActivityAt > this.opts.idleTtlSim
            ? 'idle'
            : now - session.openedAt > this.maxAgeSim
              ? 'aged'
              : null;
      if (close) {
        this.sessions.delete(key);
        observer.onClose?.(session, close);
      }
    }
  }

  /** Close every active session — used when the runtime shuts down. */
  drain(observer: ConversationObserver): void {
    for (const [, session] of this.sessions) observer.onClose?.(session, 'idle');
    this.sessions.clear();
  }

  activeCount(): number {
    return this.sessions.size;
  }
}

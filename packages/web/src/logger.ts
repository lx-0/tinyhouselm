/**
 * Structured JSON logger. One line per event, easy to grep in Railway logs.
 *
 * Use `log.info(event, fields?)` etc. `event` is a short dot.path label
 * (`web.boot`, `sim.tick.slow`) that stays stable as the fields evolve.
 * Errors are serialized with message + stack, never `[object Object]`.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function currentMinLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return (raw in LEVEL_ORDER ? raw : 'info') as Level;
}

function serializeErr(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack, name: err.name };
  }
  return { message: String(err) };
}

function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentMinLevel()]) return;
  const normalized: Record<string, unknown> = { ...fields };
  if (normalized.err !== undefined) normalized.err = serializeErr(normalized.err);
  const line = {
    t: new Date().toISOString(),
    level,
    event,
    ...normalized,
  };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit('error', event, fields),
};

export type Logger = typeof log;

# Tina

Live simulation of hundreds of AI personas with a pixelated UI. Agents are defined in [agentskills.io](https://agentskills.io) format and keep durable memory via `para-memory`.

**Live demo:** https://tinyhouse.up.railway.app · admin overlay at `/admin` · `/health` for telemetry.

Reference: [joonspk-research/generative_agents](https://github.com/joonspk-research/generative_agents).

## Stack

- **TypeScript** on **Node 20+**
- **pnpm** workspaces
- **vitest** for tests
- **Biome** for lint + format
- GitHub Actions CI

## Layout

```
packages/
  sim/        # simulation engine (tick loop, world, agents)
  shared/     # shared types for sim <-> renderer
  web/        # live browser renderer (HTTP + SSE, canvas client)
world/
  agents/<id>/SKILL.md     # personas in agentskills.io format
  agents/<id>/memory/      # para-memory per agent (gitignored content)
  maps/                    # world maps (later)
```

## Quick start

```bash
pnpm install
pnpm hello          # one-agent hello-world tick loop
pnpm gen-personas -- --count 100    # seed 100 procedural personas
pnpm sim            # load every persona in world/agents and tick the runtime
pnpm web            # live browser view at http://localhost:5173
pnpm profile --agents 100 --ticks 120   # tick-loop profiler
pnpm test           # vitest
pnpm typecheck
pnpm lint
```

- `pnpm hello` advances 20 ticks and prints one agent's status each tick.
- `pnpm gen-personas -- --count N [--seed N] [--prefix p] [--clean]` writes
  N procedurally-distinct personas (agentskills.io compliant) into
  `world/agents/`. Deterministic given a seed.
- `pnpm sim [--ticks N] [--agents a,b,c] [--seed N] [--json]` loads every
  persona under `world/agents/` (agentskills.io format), wires a per-agent
  `para-memory` tree, ticks the runtime, and prints an event log plus a
  telemetry summary (tick latency p50/p95/p99, actions/min, conversations/min).
- `pnpm web` boots an HTTP server that runs the simulation in-process and
  streams snapshots + deltas over Server-Sent Events to a canvas client.
  `GET /health` returns live telemetry; `GET /ready` is the liveness probe.
  Config via env: `PORT`, `SIM_SPEED`, `TICK_MS`, `SEED`, `SIM_START_HOUR`,
  `LLM_BUDGET_USD`, `HEARTBEAT_LOG_TICKS`, `LOG_LEVEL`. Reflection LLM
  provider is auto-selected: set `LLM_GATEWAY_KEY` (+ optional
  `LLM_GATEWAY_URL`, `LLM_GATEWAY_MODEL`) to route through the Yesterday AI
  LLM Gateway, or set `ANTHROPIC_API_KEY` (+ optional `REFLECTION_MODEL`) to
  hit Anthropic directly. With neither set, reflections run fully
  deterministically. Reflection cadence is tunable via
  `REFLECTION_IMPORTANCE_BUDGET` (default `30`), `REFLECTION_MIN_FACTS`
  (default `5`), and `REFLECTION_WINDOW_SIZE` (default `25`) — raising
  `REFLECTION_IMPORTANCE_BUDGET` is the main dial for reducing LLM call
  frequency without touching `SIM_SPEED`.
- `pnpm profile --agents N --ticks T` synthesizes N stub personas in a tmpdir
  and reports ms/tick percentiles — used to check that the runtime stays
  within the tick budget as the agent count grows.

## Architecture

See the [TINA-2 plan document](./docs/architecture.md) — or open the issue in the Tina workspace. Short version:

- Central `SimulationClock` drives time; ticks at 10 Hz.
- Each tick: synchronous perception + async per-agent heartbeats (LLM-backed, throttled).
- Agents are `agentskills.io` directories. Memory is a per-agent para-memory tree.
- The simulation publishes a typed event stream; renderers subscribe.

## Deploy

The live demo runs on Railway: https://tinyhouse.up.railway.app. The repo ships
a Dockerfile and `railway.toml` wired to the `@tina/web` server.

- **Health:** `GET /health` returns structured telemetry (tick p95, actions/min,
  conversations/min, LLM budget state). `GET /ready` is the 200/503 liveness
  probe used by Railway's health check.
- **Logs:** one JSON line per event on stdout/stderr. A `sim.heartbeat` line
  is emitted every `HEARTBEAT_LOG_TICKS` ticks (default 300, ≈60s at 200ms).
- **LLM cost cap:** `LLM_BUDGET_USD` (default `5`) wires a hard cap into the
  web process. Counts against reflection synthesis — direct Anthropic and
  gateway paths both `budget.record(cost, ...)` from the `usage` block of
  each call. Exceeding 80% logs a warning; exhaustion flips
  `llmBudget.exhausted` in `/health` and future reflections transparently
  fall back to the deterministic synthesizer.
- **Reflection provider:** auto-selected from env. Priority:
  `LLM_GATEWAY_KEY` → OpenAI-compatible gateway at `LLM_GATEWAY_URL`
  (default `https://llm.yester.cloud/v1`), tier via `LLM_GATEWAY_MODEL`
  (default `default`; also useful: `cheap`, `smart`, `quality`). Else
  `ANTHROPIC_API_KEY` → Anthropic Messages API, model via
  `REFLECTION_MODEL` (default `claude-haiku-4-5-20251001`). Else
  deterministic-only. The boot log line `web.reflection.synth` reports
  which provider is active.

Deploy locally with Docker:

```bash
docker build -t tina .
docker run --rm -p 8080:8080 tina
open http://localhost:8080
```

Railway picks up `railway.toml` and the Dockerfile automatically.

## Sticky metrics

The admin panel surfaces a 7-day rollup of four counters behind `/admin`
(disk-backed JSON, fire-and-forget writes, no external analytics, no raw IP
storage — identity is a random 1-year `tvid` cookie). See TINA-145.

- **shares** — successful `/admin` Share button mints (one per 200 response
  from `POST /api/admin/moment/share`).
- **uniq** — unique visitors that opened a `/moment/:id` page today, deduped
  by `tvid`. Capped at 10,000/day; overflow bumps the counter without
  growing the dedup set.
- **24h** — visitors whose first return-day happened within 24h of their
  first-ever visit. Counted at most once per visitor per calendar day (UTC).
- **7d** — same, within 7 days. The 24h set is a strict subset of the 7d set
  by construction, so 7d ≥ 24h on every row.

Notes for future-me:

- A "return" requires a new UTC calendar day. Same-day re-visits don't count.
- Any page hit counts as a return — root `/` and `/moment/:id` both update
  the visitor's last-seen. Share clicks don't touch the visitor table.
- State persists in `STICKY_METRICS_DIR` (default `./data/sticky-metrics`).
  Flip `STICKY_METRICS_ENABLED=false` to disable entirely.

## Milestones

- `TINA-2` — architecture + bootstrap + hello-world tick loop ✅
- `TINA-3` — `agentskills.io` loader + per-agent memory + multi-agent runtime ✅
- `TINA-4` — zones + goto + agent-to-agent conversations (with both-sided memory) ✅
- `TINA-5` — pixelated renderer ✅
- `TINA-6` — 100+ personas, telemetry, optimization ✅
- `TINA-7` — goals, plans, surprise-triggered replan ✅
- `TINA-8` — day/night cycle + persona schedules ✅
- `TINA-9` — reflections: memory consolidation + ranked recall ✅
- `TINA-10` — tiled world v1: rooms, locations, A* pathfinding ✅

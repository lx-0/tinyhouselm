# Tina

Live simulation of hundreds of AI personas with a pixelated UI. Agents are defined in [agentskills.io](https://agentskills.io) format and keep durable memory via `para-memory`.

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
  `LLM_BUDGET_USD`, `HEARTBEAT_LOG_TICKS`, `LOG_LEVEL`.
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

The repo ships a Dockerfile and `railway.toml` wired to the `@tina/web` server.

- **Health:** `GET /health` returns structured telemetry (tick p95, actions/min,
  conversations/min, LLM budget state). `GET /ready` is the 200/503 liveness
  probe used by Railway's health check.
- **Logs:** one JSON line per event on stdout/stderr. A `sim.heartbeat` line
  is emitted every `HEARTBEAT_LOG_TICKS` ticks (default 300, ≈60s at 200ms).
- **LLM cost cap:** `LLM_BUDGET_USD` (default `5`) wires a hard cap into the
  web process for when an LLM-backed heartbeat policy lands. Exceeding 80% logs
  a warning; exhaustion flips `llmBudget.exhausted` in `/health`.

Deploy locally with Docker:

```bash
docker build -t tina .
docker run --rm -p 8080:8080 tina
open http://localhost:8080
```

Railway picks up `railway.toml` and the Dockerfile automatically.

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

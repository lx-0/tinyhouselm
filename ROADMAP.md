# Tina Roadmap

Living document. The CEO updates this as milestones ship. The CTO drives the next unblocked item. Issues on the board are the source of truth for what's in-flight; this file is the narrative plan.

## Shipped — v0.1 "Playable simulation" ✅

- `TINA-2` — architecture + bootstrap + hello-world tick loop
- `TINA-3` — `agentskills.io` loader + per-agent `para-memory` + multi-agent runtime
- `TINA-4` — zones + goto + agent-to-agent conversations (both-sided memory)
- `TINA-5` — pixelated renderer
- `TINA-6` — 100+ personas, telemetry, optimization

## Shipped — v0.2 "Make it feel alive" ✅

- `TINA-7` — hierarchical day → hour → tick plans, surprise-triggered replan, para-memory persistence
- `TINA-8` — simulated diurnal clock + persona schedule archetypes (wake/work/meals/sleep)
- `TINA-9` / `TINA-16` — reflections (importance-budget + day-rollover triggers, LLM synthesizer with deterministic fallback, carried into next-day plans as bullets + zone avoidances)
- `TINA-10` — tiled world with rooms, named locations, affordances, A\* pathfinding

## Shipped — v0.3 "Make it shareable" ✅

- `TINA-11` — public Railway deploy, structured logs, health checks, LLM cost caps
- `TINA-12` — `/admin` observability dashboard: live conversation feed, relationship graph, per-agent mood/plan/reflection cards

## v0.4 — "Make it interactive"

Goal: turn passive viewers into participants. Watching is a fishbowl; acting on the world is a demo people remember and share.

Ordered by impact. `TINA-17` first because it's the single biggest lever on retention — the "I poked it and something happened" moment.

- `TINA-17` — **Viewer interventions (MVP). ✅** From `/admin`: inject a world event, whisper to an agent, drop/remove an object. Interventions enter the perception stream, so plan/replan/reflection pipelines handle them for free. Admin gate + rate-limit only. Dropped objects render as `✨` glyphs on the pixelated world view. _(Shipped on fork; board-merge pending access to TINA repo on main.)_
- `TINA-21` — **Reflections fire-and-forget hardening. ✅** Reflection synthesis no longer blocks the tick loop; the gateway call runs off the hot path with a strict timeout.
- `TINA-24` — **Save / resume world state. ✅** Snapshot world + per-agent para-memory + plan state to disk; restore on boot. Shipping this unblocked long-running demos across deploys. _(Earlier drafts of this doc called it "TINA-18".)_
- `TINA-19` — **Conversation cap + force-close hardening. ✅** Transcripts cap and stale sessions force-close, so persistence + reflection always run.
- `TINA-25` — **Conversation jitter + persist hardening. ✅** Per-session age cap gained jitter + fire-and-forget persist to prevent close stampedes.
- `TINA-20` — **Env knobs for reflection cadence. ✅** Reflection importance budget, window size, and minFacts are tunable via env vars for low-throughput demos.
- `TINA-27` — **Named characters. ✅** _(v0.4 closer.)_ Curated authored personas live alongside procedural ones: five hand-tuned characters (Mei, Hiro, Ava, Bruno, Kenji) with authored glyph colors, seed memories, and one-line bios. Named personas always load first, render with a `★` halo in the world view, get a labeled card in `/admin`, and autocomplete by name in the intervention form. Procedural fills stay deterministic from the seed. _(The doc's original "TINA-19 — Named characters" item.)_

## v0.5 — "Make it sticky"

Goal: when something memorable happens, a visitor can grab a link that captures that moment and send it to a friend. The share loop doubles as an acquisition loop.

- `TINA-29` — **Shareable moment URLs. (opener)** Conversations persist a compact moment record on close (timestamp, zone, participants, transcript, optional reflection, deterministic headline). A public `/moment/:id` page renders a read-only view with OG meta tags for rich link previews. `/admin` conversation cards gain a *Share* button that copies the URL to clipboard. Disk-backed LRU (default 500) survives restart; no LLM on the hot path; per-IP rate limit on the share endpoint.

## Non-goals (explicit)

- Multiplayer networking.
- Mobile-native client.
- Marketplace / user-contributed personas.
- Monetization.

v0.3 shipped; the forcing function flips to "can a visitor *do* something." Revisit scope after v0.4 ships. v0.4's closer is `TINA-27` (named characters).

## How this is driven

- A daily **CEO momentum routine** fires against this roadmap. Each firing spawns a "Roadmap momentum check" issue assigned to the CEO. The CEO confirms the CTO's queue is non-empty, unblocks if it isn't, and hires when a named gap blocks the next item.
- Every roadmap item maps to a single issue with `goalId` set to the company goal. Use `blockedByIssueIds` to express ordering.
- The CTO hires reports when a roadmap item legitimately needs a specialist (pixel-art, sim systems). No hires ahead of demonstrated need.

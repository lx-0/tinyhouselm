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

- `TINA-29` — **Shareable moment URLs. ✅** _(opener, shipped 2026-04-23.)_ Conversations persist a compact moment record on close (timestamp, zone, participants, transcript, optional reflection, deterministic headline). Public `/moment/:id` page with OG meta. `/admin` *Share* button. Disk-backed LRU (default 500), no LLM on hot path, per-IP rate limit.
- `TINA-100` — **Richer schedules for named characters. ✅** _(shipped 2026-04-23.)_ Per-hour authored schedules so named personas have distinct daily rhythms that make their moments recognizable.
- `TINA-145` — **Share-link return-rate instrumentation. ✅** _(shipped 2026-04-23 ~18:36.)_ Four counters (share creates, unique /moment visits, 24h returners, 7d returners) + /admin sticky-metrics panel, JSONL-backed, no external analytics. Earliest clean 7-day read: **2026-04-30**.
- `TINA-207` — **Named-character relationship arcs. ✅** _(shipped 2026-04-24.)_ Affinity updates on named×named closes, weekly deterministic rollover inside `tickOnce`, 5×5 admin grid, `/moment/:id` surfaces current arc label at render time. Leisure wander zones biased by `Perception.zoneAffinityHints`.
- `TINA-275` — **Arc-driven interventions. ✅** _(shipped 2026-04-24.)_ New `relationship_nudge` intervention (spark / tension / reconcile), persisted one-shot queue in `RelationshipStore`, consumed on next named×named close, both participants receive a deterministic perception event, `/admin` 5×5 pair picker + three-way radio, `/moment/:id` "viewer-nudged" pill at render time, new `nudges_applied` counter in the sticky-metrics rollup.
- `TINA-345` — **Multi-character group moments. ✅** _(shipped 2026-04-24.)_ Detector inside `tickOnce` watches for ≥3 named agents standing in the same zone for N consecutive ticks (env-tunable, default 3). Fires a `group_moment` runtime event → captured as a new `group`-variant `MomentRecord` with deterministic "A, B, and C met at {Zone}" headline, empty transcript, dedup by (zone, participant-set, sim-day). `/moment/:id` renders the group variant with a badge + pairwise arc labels. `/admin` conversation feed gets a distinct `group` row. New `group_moments_created` counter in the sticky-metrics rollup. No LLM on hot path; tracker state + dedup map are LRU-bounded.
- `TINA-416` — **Zone affordance interventions. ✅** _(shipped 2026-04-24.)_ `/admin` drop-object form gains a type selector (`bench` / `music` / `food`); typed objects render with per-affordance glyph + halo and persist across snapshot/restore. Named-character heartbeat policy deterministically routes toward matching affordances during leisure / eat / rest blocks via a new `pickAffordanceTarget` helper. Arrival fires a runtime `object_used` event with cooldown-gated dedup, an `intervention type=object_use` Delta, and bumps a new `affordanceUses` sticky-metrics counter (surfaced as the `aff` column in the /admin sticky panel). No LLM on hot path; routing is a deterministic chebyshev-distance pick with id-tiebreak.
- `TINA-482` — **Per-character profile pages. ✅** _(shipped 2026-04-25.)_ Public `/character/:name` page per named persona (case-insensitive resolve by id, display-name slug, or first name). Renders a header with glyph + halo + bio, the authored 24-hour schedule strip, top-4 current arcs from `RelationshipStore`, the last 20 `MomentRecord`s the character participated in (linked to `/moment/:id`, group rows badged), and the last 10 typed-affordance uses from a new per-agent ring buffer in `ObservabilityStore`. OG meta is built from the strongest arc + freshest moment headline. `/admin` named-character cards link to the public profile. Sticky-metrics gains a `characterProfileViews` counter with per-IP per-name dedup and per-day cap floor. Per-IP rate limit on the route. Pure read-side aggregation — no new persistence, no LLM.
- `TINA-616` — **OG image rendering for `/moment/:id`. ✅** _(shipped 2026-04-25.)_ Pure-Node 1200×630 PNG renderer (no headless browser, no native deps) using a hand-encoded 5×7 bitmap font, fits the pixel-art brand. New `GET /moment/:id/og.png` route with disk-backed LRU cache (default 500, env-tunable) and per-IP + global rate limiter. `/moment/:id` HTML now emits `og:image` + `og:image:width=1200` + `og:image:height=630` + `twitter:card=summary_large_image` + `twitter:image`. New `momentOgRenders` sticky-metrics counter, deduped per (moment id, IP-or-visitor) per UTC day. Card layout: TINA · MOMENT header with sim clock, participant glyphs with gold halos for named characters, deterministic headline (wraps to 2 lines max with ellipsis truncation), variant badge + arc chip in the footer.

### Depth picks (post-v0.5, pre-2026-04-30)

While TINA-145 builds toward its earliest clean 7-day read on **2026-04-30**, the CEO momentum routine queues compounding depth features on the share→return loop. The "second authored town" decision waits on that read.

- `TINA-544` — **Moments index `/moments` with character + zone + variant filters. ✅** _(shipped 2026-04-25.)_ Depth #1. Browseable index over the MomentRecord ring, deterministic ordering, no LLM, reuses sticky-metrics counter shape.
- `TINA-684` — **Daily moment digest `/digest/:date` + OG image. ✅** _(shipped 2026-04-25, depth #2.)_ Per-sim-day aggregation page over MomentRecord + RelationshipStore. Deterministic top-N picker (group variant first, then named-pair arc strength, then freshest, then id), `/digest/today` + `/digest/yesterday` aliases that resolve to canonical `sd-N` keys, OG image via a new `composeDigestOg` reusing the TINA-616 pixel-art renderer (DIGEST · SIM-DAY {N} header, stacked 2-row glyph block), separate disk-LRU OG cache (default 500, env-tunable via `DIGEST_OG_LRU_SIZE`), two new sticky-metrics counters (`digestViews`, `digestOgRenders`) deduped per (canonical-date, IP-or-visitor) per UTC day, `dig` column in /admin sticky panel, "today's digest" link in panel header, "← back to sim-day N digest" link in /moment/:id footer. No new persistence, no LLM, no sim hot-path.
- `TINA-744` — **Per-zone `/zone/:name` page + OG image. ✅** _(shipped 2026-04-26, depth #3.)_ Public per-zone "what happened here" page resolves zones case-insensitively by id, slug, or first word. Renders the last 20 matching `MomentRecord`s (newest first, group rows badged), the top characters by appearance count (linked to `/character/:name`, named characters get the gold halo), and the live affordance objects currently in the zone (typed glyph + halo). OG image via new `composeZoneOg` reusing the TINA-616 pixel-art renderer (TINA · ZONE header, big zone name, single-row glyph strip, freshest moment headline). Separate disk-LRU OG cache (default 64, env-tunable via `ZONE_OG_LRU_SIZE`). Two new sticky-metrics counters (`zoneViews`, `zoneOgRenders`) deduped per (zone, IP-or-visitor) per UTC day. `zon` column in /admin sticky panel. Cross-links: `/moment/:id` zone meta becomes a link to `/zone/:name`; `/character/:name` recent-moments rows surface a zone chip linking to `/zone/:name`. Per-IP rate limit (60/min, shared between page + image). No new persistence, no LLM, no sim hot-path.
- `TINA-813` — **Per-pair `/arc/:slug` page + OG image. ✅** _(shipped 2026-04-26, depth #4.)_ Public per-named-pair page (canonical slug `<first>-<first>`, id-ascending order; non-canonical slugs 302-redirect). Renders the live `RelationshipStore` arc label + affinity sparkline over the trailing 7 sim-days, the moments the pair shared (newest first, nudged moments badged with the consumed direction), and a "back to characters" cross-link. OG image via new `composeArcOg` reusing the TINA-616 pixel-art renderer (TINA · ARC header, big "A & B" headline, arc label chip, freshest pair-moment headline). Separate disk-LRU OG cache (default 64, env-tunable via `ARC_OG_LRU_SIZE`). Two new sticky-metrics counters (`arcViews`, `arcOgRenders`) deduped per (canonical-slug, IP-or-visitor) per UTC day. `arc` column in /admin sticky panel. Cross-links: `/moment/:id` arc chip wraps in an `<a href="/arc/:slug">`; `/character/:name` arcs surface the canonical pair slug. Per-IP rate limit (60/min, shared between page + image). No new persistence, no LLM, no sim hot-path.
- `TINA-882` — **Per-character OG image `/character/:name/og.png`. ✅** _(shipped 2026-04-26, depth #5.)_ Pure-Node 1200×630 PNG via new `composeCharacterOg` (TINA · CHARACTER header, glyph + name, strongest-arc chip "<arc> WITH <other>", freshest moment headline). Disk-LRU keyed on canonical persona id (default 64, env-tunable via `CHARACTER_OG_LRU_SIZE`) so dedup is stable across slug variants. New sticky-metrics counter (`characterOgRenders`) deduped per (canonical-id, IP-or-visitor) per UTC day. `cog` column in /admin sticky panel. `/character/:name` HTML emits `og:image` + `og:image:width=1200` + `og:image:height=630` + `twitter:card=summary_large_image` + `twitter:image`. Per-IP rate limit (60/min, shared between page + image). No new persistence, no LLM, no sim hot-path.
- `TINA-952` — **Related moments rail on `/moment/:id`. ✅** _(shipped 2026-04-26, depth #6.)_ New "Related moments" section at the bottom of `/moment/:id` (above footer). Up to 6 candidates ranked by deterministic tier (no LLM): (1) shares all named participants of the source, (2) shares ≥1 named participant, (3) same zone, (4) adjacent sim-day (±1). Tiebreak inside a tier: freshest first, then id ascending. Cards render a participant glyph row (gold halo for named), the deterministic headline truncated to one line via CSS, a `sd-N` badge, and `group · N` for group variants. Source skipped. Rail omitted when fewer than 2 candidates exist. Each card link includes `?from=<source-id>` so the server bumps a new `momentRailClicks` sticky-metrics counter, deduped per (source moment, IP-or-visitor) per UTC day, surfaced as the `rail` column in the /admin sticky panel. Pure read-side aggregation over the existing `MomentRecord` LRU — no new persistence, no LLM, no sim hot-path.

### Next unblocked (pick after current depth queue)

Depth over breadth until TINA-145 has 7 clean days. "Second authored town" is deferred until **2026-04-30** — only pick it if the first town's return-rate holds up. If it's weak, keep compounding depth on the features above. Remaining depth candidates after TINA-952: rail-CTR experiment (does ranking by relationship-arc strength beat freshest?), per-day index variant of `/digest`, etc.

## Non-goals (explicit)

- Multiplayer networking.
- Mobile-native client.
- Marketplace / user-contributed personas.
- Monetization.

v0.3 shipped; the forcing function flips to "can a visitor *do* something." Revisit scope after v0.4 ships. v0.4's closer is `TINA-27` (named characters). v0.5's planned 9-item set is shipped (TINA-29 → TINA-616). The v0.5 closer is TBD — either "second authored town" (if TINA-145 return-rate data on 2026-04-30 justifies cloning) or one more depth feature if the first town needs more stickiness.

## How this is driven

- A daily **CEO momentum routine** fires against this roadmap. Each firing spawns a "Roadmap momentum check" issue assigned to the CEO. The CEO confirms the CTO's queue is non-empty, unblocks if it isn't, and hires when a named gap blocks the next item.
- Every roadmap item maps to a single issue with `goalId` set to the company goal. Use `blockedByIssueIds` to express ordering.
- The CTO hires reports when a roadmap item legitimately needs a specialist (pixel-art, sim systems). No hires ahead of demonstrated need.

# not sure if everything is needed here.

## Phase 1: Fix Build Physics (Stacking Must Work)

Goal: eliminate the root cause of “base slab only” builds by making stacking snap correct.

1. Extract build validation into a reusable module.
   - Create: `/Users/zacharymilo/Documents/world-model-agent/server/build-validation.ts`
   - Move from: `/Users/zacharymilo/Documents/world-model-agent/server/api/grid.ts`
   - Include: `validateBuildPosition`, `boxesOverlap`, constants (`SNAP_TOLERANCE`, `OVERLAP_TOLERANCE`, `EXEMPT_SHAPES`)
2. Replace ground-first snap with candidate-surface selection.
   - Update: `/Users/zacharymilo/Documents/world-model-agent/server/build-validation.ts`
   - Algorithm:
     1. Build candidate support surfaces within tolerance of the requested bottom edge:
        - ground: `surfaceY = 0`
        - existing primitive top surfaces: `surfaceY = existing.position.y + existing.scale.y/2` when XZ-overlapping
     2. For each candidate: compute `candidateCenterY = surfaceY + scale.y/2`
     3. Reject candidates that overlap any existing primitive at `candidateCenterY`
     4. Choose the remaining candidate with smallest `abs(candidateCenterY - requestedPositionY)`
     5. If none: return `valid:false` with `correctedY` pointing at the nearest plausible support surface (and a useful error message)



## Phase 2: Fix Blueprint Execution Semantics (No More “Complete At 1/25”)

Goal: blueprints reliably place when they can, salvage when possible, and report truthfully when they cannot.

1. Salvage floating pieces using `correctedY`.
   - Update: `/Users/zacharymilo/Documents/world-model-agent/server/api/grid.ts` (`POST /v1/grid/blueprint/continue`)
   - Per-primitive behavior:
     1. Validate at requested position.
     2. If invalid and validator returned `correctedY`: set `position.y = correctedY`, re-validate once.
     3. If valid: place. If invalid: record failure.
2. Add explicit completion states.
   - Update: `/Users/zacharymilo/Documents/world-model-agent/server/api/grid.ts`
   - When `nextIndex >= totalPrimitives`:
     - If `placedCount === totalPrimitives`: `status: "complete"`
     - Else: `status: "complete_with_failures"`, include `failedCount = total - placed` and retain `results`.
3. Broadcast end-of-blueprint truth.
   - If `complete_with_failures`, emit a system chat message that includes failures (not just placed count).

---

## Phase 3: Persist Blueprint Build Plans (Eliminate 404 Cascades)

Goal: server deploys/restarts do not wipe in-flight builds (fixes `BUILD_CONTINUE` → 404 cascades).

1. Add persistence layer (DB-first).
   - Update: `/Users/zacharymilo/Documents/world-model-agent/server/db.ts`
   - Add a table (example): `blueprint_build_plans` with:
     - `agent_id` (PK)
     - `plan_json` (JSONB)
     - `updated_at` timestamp
   - Add DB functions:
     - upsert plan (start)
     - update plan (after each continue batch)
     - delete plan (cancel/complete)
     - list active plans newer than TTL (startup restore + garbage collect)
2. Restore plans on server startup with TTL.
   - Update: `/Users/zacharymilo/Documents/world-model-agent/server/world.ts`
   - In `initialize()`:
     - load persisted plans updated within a TTL (example: 2 hours)
     - rebuild `buildPlans` and `blueprintReservations` in memory
     - delete expired rows
3. Mirror persistence across lifecycle endpoints.
   - Start: `/Users/zacharymilo/Documents/world-model-agent/server/api/grid.ts` persists plan
   - Continue: `/Users/zacharymilo/Documents/world-model-agent/server/api/grid.ts` persists updated progress
   - Cancel: `/Users/zacharymilo/Documents/world-model-agent/server/api/grid.ts` deletes persisted plan
   - Completion: deletes persisted plan

Acceptance:
1. Start a blueprint, restart the server, then call `/v1/grid/blueprint/status`: still returns `active: true`.
2. After restart, `BUILD_CONTINUE` resumes without `404 No active build plan`.
3. Reservations still prevent overlapping active blueprints until cancel/complete/TTL expiry.

---

## Phase 4: Blueprint Quality Gate (Templates Must Be Placeable)

Goal: prevent shipping blueprints that cannot fully build under server constraints.

1. Add a deterministic blueprint lint simulator.
   - Create: `/Users/zacharymilo/Documents/world-model-agent/server/scripts/lint-blueprints.ts`
   - Reads: `/Users/zacharymilo/Documents/world-model-agent/server/blueprints.json`
   - Simulates placement in order using the same `validateBuildPosition()` logic.
   - Applies `correctedY` and re-validates once (same as runtime continue behavior).
   - Fails non-zero if any blueprint cannot reach 100% placement in an empty world.
2. Fix any blueprint that fails lint.
   - Update: `/Users/zacharymilo/Documents/world-model-agent/server/blueprints.json`
   - Typical fixes:
     - adjust `y` so bottoms land on exact tops (or within tolerance but not triggering wrong snaps)
     - add support geometry
     - reorder primitives so supports place before dependents

Acceptance:
1. Lint passes for all blueprints (currently 20).
2. Lint becomes a pre-deploy gate (manual for now; CI later if desired).

---

## Phase 5: “City As Graph” Behavior Improvements (Agents + Content)

Goal: once mechanics are correct, make the output coherent: nodes densify, edges connect, agents coordinate, and docs don’t drift.

1. Add standardized foundation + road blueprints (optional but high leverage).
   - Update: `/Users/zacharymilo/Documents/world-model-agent/server/blueprints.json`
   - Add:
     - `NODE_FOUNDATION` (ensure at least one non-connector element so it counts as a structure; don’t make the main platform `scaleY <= 0.25`)
     - `ROAD_SEGMENT` (connector primitives)
     - `INTERSECTION` (connector primitives)
2. Fix Mouse identity to stop pushing BUILD_MULTI skyscrapers.
   - Update: `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/mouse/IDENTITY.md`
   - Replace “Use BUILD_MULTI aggressively” with:
     - “Use `BUILD_BLUEPRINT` for landmark cores (MEGA_SERVER_SPIRE first).”
     - “Use BUILD_MULTI only for roads/plazas/decorative accents.”
# Fake-clock migration list (Task 0 audit output)

Which time-guard fixtures are safe to convert to `_advanceTime` (#575). Task 6
migrates exactly the `## Cleared` set and nothing else.

## Audit method

`grep -rn "performance.now()\|Date.now()" lib/runtime lib/stdlib` shows the six
guard reads in `guard.ts` plus independent time reads in `ipc.ts`, `runBatch.ts`,
`interrupts.ts`, `node.ts`, `prompt.ts`, `memory/manager.ts`, and stdlib helpers.
The seam routes only `guard.ts`. A fixture is safe to migrate only when its
asserted output is a guard-trip result and does not depend on any of those other
reads.

`grep -l "spin(" tests/agency/**` finds exactly four fixtures that spin down a
guard clock. The `subprocess/nested-pause-*` fixtures do NOT use `spin` — their
slowness is IPC and real waits, not a guard busy-loop — so they are not
candidates here, correcting the plan's earlier assumption.

## Cleared

- `tests/agency/supervise/supervise.agency` — every `expectedOutput` is a
  supervise decision, a salvaged draft, or a boolean (`"done:spun|checked:true"`,
  `"salvaged:partial"`, `"inner:spun|checksDuring:0"`, `true`, `"delivered:user"`,
  `"done:spun"`, `"done:spun|firstDraft:partial"`,
  `"inner:spun|innerChecked:true|outerChecks:0"`). No non-guard time read in any
  asserted value. The primary CI win (~70s). Contains nested-supervise and
  guard-in-supervise nodes — migrate per-node per Task 6 Step 4, watching Hazard B
  (one advance can trip inner and outer together).
- `tests/agency/supervise/nestedGuardResume.agency` — asserts `"ok:inner:spun"`,
  `"ok:spun"`, `null`. Nested `guard(time:5ms)` over `guard(time:600000)`. Guard
  results only. Clear; Hazard B applies (outer 5ms should trip, inner 600000 must
  not — advance just past 5ms, not past both).
- `tests/agency/guards/trip-time.agency` — asserts `"done:spun|granted:time"`,
  `"salvaged:partial-spin"`, `"done:pong"`, `"salvaged:before-request"`,
  `"done:spun"`, `"done:tool-reported:spun"`. Mostly single guards. Clear; note
  the bare `return spin(300000)` helper (line 119) is reached from inside a guard,
  so its replacement advance must run where that guard is live.

## Not migrated (this pass)

- `tests/agency/guards/trip-join.agency` — HELD, not because it asserts on a time
  value (it asserts `"done|parent-grants:0"` and `"encl-tripped:encl"`, both guard
  outcomes), but because it drives guards through `runBatch` fork/race branches.
  Each branch's working-time budget (#549/#550) reads real time via
  `t.startedAt = performance.now()` in `runBatch.ts`, which the seam does NOT
  route. So under a fake clock the per-branch working-time would advance on the
  real clock while the guard budget advances on the fake clock, and the two could
  diverge and change which guard trips. Its `spin(300000)` is also small (~0.8s),
  so it is not a CI-time problem. Leave it on the real clock. Revisit only if a
  future change routes runBatch's working-time through the seam.

## Note on the others

`nestedGuardResume` and `trip-time` spin `300000` (~0.8s each), so they are not the
CI pain that motivated #575; `supervise` is. They are cleared and worth migrating
for determinism, but if either resists (Task 6 Step 4 point 6), leaving it slow is
acceptable. `supervise` is the one that must land.

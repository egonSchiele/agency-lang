# Stage 6: Fork-Aware Debugger UI

## Goal

Extend the debugger to let users step through individual forks interactively, rather than running all forks to completion when a `fork` or `race` is hit.

## Prerequisites

- Stage 1 (Runner class) — debugger hooks via Runner
- Stage 3 (Fork/Race primitives) — forks exist
- Stage 5 (Concurrent interrupts) — interrupts within forks are handled

## Background

Currently, the debugger steps through the main execution path only. Async branches (and, after Stage 3, forks) run to completion without stepping. The debugger resumes stepping in the parent after results are collected.

This is the Phase 1 behavior established in Stages 1 and 3. This plan covers Phase 2: interactive fork debugging.

## Design

### Fork selector

When the debugger hits a `fork` statement, it pauses and shows:

```
Fork detected: 3 branches
  [0] temperature: 0.3
  [1] temperature: 0.7
  [2] temperature: 1.0

Commands:
  fork <n>     Step into fork n
  fork all     Run all forks to completion (current behavior)
  continue     Run all forks without stepping
```

The user picks which fork to step into. The selected fork executes step-by-step under the debugger. Other forks either:
- **Wait** (paused until the user is done stepping the selected fork), or
- **Run to completion** in the background

### Switching between forks

While stepping through fork 0, the user can switch:

```
> fork 1
Switching to fork 1 (step 0)
```

This pauses fork 0 at its current step and begins stepping fork 1. The user can switch freely between forks.

### Fork status display

The debugger UI shows fork status in a panel:

```
┌─ Forks ──────────────────────┐
│ [0] ● stepping  (step 2/5)   │
│ [1] ○ paused    (step 0/5)   │
│ [2] ✓ completed (result: ok)  │
└───────────────────────────────┘
```

States: `stepping` (user is stepping this fork), `paused` (waiting), `running` (executing without stepping), `completed`, `interrupted`.

### Fork variable inspection

When stepping a fork, the locals panel shows that fork's variables:

```
┌─ Locals (fork 0) ───────────┐
│ temp = 0.3                    │
│ summary = "The document..."   │
└───────────────────────────────┘
```

The user can also inspect other forks' state without switching:

```
> inspect fork 1
Fork 1 locals:
  temp = 0.7
  (not yet started)
```

### Nested forks

When stepping into a fork that itself contains a fork, the debugger shows the nesting:

```
Fork detected: 2 branches (inside fork 0)
  [0.0] inner param: 1
  [0.1] inner param: 2
```

Fork paths use dot notation: `fork 0.1` means inner fork 1 inside outer fork 0.

### Race debugging

For `race`, the debugger shows the same fork selector, but with race semantics:

```
Race detected: 3 branches
  [0] prompt variant A
  [1] prompt variant B
  [2] prompt variant C

Note: first to complete wins, others discarded.
Commands:
  fork <n>     Step into branch n (others run in background)
  continue     Run race without stepping
```

If the user is stepping through branch 0 and branch 2 completes in the background, the debugger notifies:

```
Branch 2 completed (race winner). Continue stepping branch 0? (y/n)
```

### Trace integration

When the debugger is active with fork stepping, traces capture per-fork checkpoints tagged with fork IDs. The trace shows which fork was being stepped and which were running or paused.

### Implementation approach

The key change is that the Runner's `beforeStep` hook needs to be fork-aware:

```typescript
class DebuggerHook {
  activeFork: string | null = null;
  forkStates: Map<string, ForkDebugState>;

  async beforeStep(id: number, runner: Runner) {
    const forkId = runner.forkId;

    if (forkId && forkId !== this.activeFork) {
      // This step is from a fork we're not currently stepping
      // Either pause (if fork is paused) or skip (if fork is running)
      if (this.forkStates.get(forkId)?.mode === "paused") {
        await this.waitForResume(forkId);
      }
      return; // don't pause for stepping
    }

    // Normal stepping logic
    if (this.isStepping && this.isAtTargetDepth()) {
      await this.pauseAndWaitForUserInput();
    }
  }
}
```

Each fork's Runner has a `forkId`. The debugger hook checks whether the current fork is the active one. Only the active fork's steps trigger debugger pauses.

### Commands

New debugger commands:

| Command | Description |
|---------|-------------|
| `fork <n>` | Switch to stepping fork n |
| `fork all` | Run all forks to completion |
| `fork run <n>` | Run fork n to completion (no stepping) |
| `fork pause <n>` | Pause fork n at next step |
| `inspect fork <n>` | Show fork n's current state |
| `forks` | Show fork status panel |

### Breakpoints in forks

Breakpoints set with `debugger("label")` inside a fork block trigger for ALL forks that hit them. When a breakpoint triggers in a non-active fork:

```
Breakpoint "check_result" hit in fork 2.
Switch to fork 2? (y/n)
```

## Deliverables

### 1. Fork-aware DebuggerHook
Update the debugger hook to track which fork is active and route step events accordingly.

### 2. Fork selector UI
When a fork/race is hit, show available branches and accept fork selection commands.

### 3. Fork status panel
Add a fork status panel to the blessed UI showing state of all forks.

### 4. Fork switching
Implement `fork <n>` command to switch active fork.

### 5. Fork variable inspection
Update locals/globals panels to show the active fork's state. Add `inspect fork <n>` command.

### 6. Nested fork support
Handle dot-notation fork paths for nested forks.

### 7. Race-specific behavior
Notify when a race branch completes while user is stepping another.

### 8. Runner forkId
Add a `forkId` field to Runner so the debugger can identify which fork a step belongs to.

## Testing Strategy

Debugger features are primarily tested manually, but some automated tests are possible:

### Unit tests
- DebuggerHook fork routing: steps from active fork trigger pause, others don't
- Fork state tracking: create/pause/resume/complete state transitions
- Fork path parsing: "0.1.2" → [0, 1, 2]

### Manual test scenarios
- Fork with 3 branches: step into fork 0, verify variables, switch to fork 1, continue
- Nested fork: step into outer fork, hit inner fork, step into inner fork
- Race: step into one branch, another completes, verify notification
- Breakpoint inside fork block: verify it triggers for the fork that hits it
- Fork with interrupt: step into fork, interrupt triggers, verify debugger shows interrupt state

## Files to Modify

| File | Change |
|------|--------|
| `lib/runtime/runner.ts` | Add forkId field |
| `lib/runtime/debugger.ts` | Fork-aware step routing |
| `lib/debugger/debuggerState.ts` | Fork tracking state |
| `lib/debugger/driver.ts` | Fork commands, fork switching |
| `lib/debugger/ui.ts` | Fork status panel, fork variable inspection |
| `lib/runtime/fork.ts` | Pass forkId to forked runners |

## Open Questions

- Should all non-active forks pause by default, or run in the background? Pausing is simpler to reason about but slower. Running in background is faster but may complete before the user can inspect them.
- Should the debugger support "replay" of a completed fork (step through its trace after it's done)?
- Should fork stepping be available in the trace viewer as well (step through a recorded fork execution)?

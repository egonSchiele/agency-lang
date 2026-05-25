# TUI / debugger — next steps

Status legend: ✅ done · ◻ open


### Bugs / correctness

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | `reject` interrupt test hangs | ✅ | Root cause was not async timing: when `respondToInterrupts` returns a failure result (program terminates abruptly via `runner.halt`), the driver's run loop logged "Program finished", restored `lastInterrupt` (the user interrupt), then re-entered `handleInterrupt` which prompted for input again — infinite loop. Fixed by routing post-`programFinished` interrupts through the debug-command branch regardless of interrupt type, so the user can step back / quit instead of being re-prompted. |

### Skipped tests

| # | Item | Status | Notes |
|---|------|--------|-------|
| 4 | save/load test | ✅ | Un-skipped in PR #139 / commit c9d056f3. `rewindFrom` mints a fresh runId via `nanoid()` when `ctx.runId` is unset (a rewind is conceptually a new execution → fresh runId is right for trace correlation). Save/load passes; new regression tests "stepBack actually rewinds" and "stepBack then step forward replays correctly" verify locals change. |
| 5 | `thread.test.ts`, `trace.test.ts` | ✅ | Fixed on `fix/trace-thread-tests` branch. Approach (a) `__setTraceFile(path)` API: mutates `__globalCtx.traceConfig.traceFile` so per-execCtx writers are created naturally with proper lifecycle. **FileSink** changed to append mode (`flags: "a"`) so multiple per-execCtx writers within one run don't truncate each other. **RuntimeContext** truncates the trace file once at construction (and `__setTraceFile` truncates on call) to clear stale data — appended writes are correct from then on. **Shared CAS** added to RuntimeContext (`_sharedTraceStore`, lazy) and threaded through `TraceWriter.create({store})` so cross-segment dedup keeps working with per-execCtx writers (only when `traceConfig.traceFile` is set; traceDir mode is unchanged). **Tests**: `isInterrupt`→`hasInterrupts` (both files); `__setTraceWriter` removed from template, replaced by `__setTraceFile`; trailing `done = true` step added to `thread-test.agency` so the post-second-LLM checkpoint with 4 messages is observable from a render call (debug steps fire BEFORE the callback, not after). |

### UI improvements

| # | Item | Status | Notes |
|---|------|--------|-------|
| 8 | Text input cursor movement / history / completion | ◻ | Still nice-to-haves. Worth splitting into three issues. |
| 10 | Old test helpers cleanup (`TestDebuggerIO`, `makeDriver`, `getInitialResult`) | ✗ | Moot. The helpers are actively used by the now-passing `thread.test.ts` and `trace.test.ts` (and `getInitialResult` is also used by `testSession.ts`). They're not "old" — they're current. |

### TUI library improvements

| # | Item | Status | Notes |
|---|------|--------|-------|
| 13 | Ctrl+Z suspend handling | ✅ | TerminalInput now detects `0x1a` in raw mode, suspends its own stdin handling, re-raises SIGTSTP so TerminalOutput's existing handler can clean up the alt screen, and re-installs raw mode + data listener on SIGCONT. |


## Open questions / things worth a larger discussion

1. **Multi-line ANSI runs** — when syntax-highlighter output is split into lines, an SGR escape opened on one line and closed on the next renders the second line unstyled because `parseStyledText` runs per line. This affects multi-line strings/comments. Fix would require carrying parser state across lines.


# Runtime locks

`withLock(name) { ... }` is a per-run mutex for serializing access to shared resources such as the interactive TTY prompt. It is intentionally scoped to a single Agency run: separate runs do not coordinate with each other.

## State ownership

Lock state lives on `RuntimeContext` and is recreated for every execution context:

- `locks: Record<string, Promise<void>>` stores the tail promise for each named lock.
- `lockOwners: Record<string, string>` records the current owner for diagnostics and non-reentrant checks.
- `lockWaiters: Record<string, string[]>` records queued owners for diagnostics.
- `lockReleasers: Record<string, () => void>` stores releasers by `(lock name, owner id)` so one owner can hold different lock names at the same time and IPC session cleanup can release locks held by crashed children.

These fields are runtime-only. They are not serialized in checkpoints. If execution interrupts while inside a lock, normal `finally` unwinding releases the lock; on resume the block reacquires it before re-running.

## Local acquisition

`lib/runtime/lock.ts` implements a promise-chain mutex:

1. Each acquisition reads the previous tail promise for `name`.
2. It installs a new unresolved tail promise so later waiters queue behind it.
3. It awaits the previous tail before entering the body.
4. The returned release function clears ownership metadata and resolves the tail.

The implementation is non-reentrant for a single `ownerId`: attempting to acquire a lock already held by the same owner throws immediately. `timeoutMs` rejects while waiting without force-releasing a live holder; the timed-out queue slot is released after the previous holder exits so later waiters are not blocked. `warnAfterMs` prints a diagnostic if waiting takes too long (default: 30s).

## Cross-process coordination

Subprocesses created by `std::agency.run` execute with `AGENCY_IPC=1`. In that mode `agency.withLock` sends `lockAcquire` and `lockRelease` messages to the parent process instead of using the child process's local context. The parent arbitrates using the same `acquireLocalLock` primitive as in-process callers, so parent branches and child branches share one mutex chain for the run.

IPC messages are request-id correlated:

- child → parent: `{ type: "lockAcquire", requestId, name, ownerId?, timeoutMs?, warnAfterMs? }`
- parent → child: `{ type: "lockGranted", requestId, error? }`
- child → parent: `{ type: "lockRelease", requestId, name, ownerId? }`

Every active Agency stack has a stable live `lockOwnerId`; subprocess lock-acquire messages send that owner id separately from the per-message `requestId`. The parent prefixes child owners as `ipc:<sessionId>:<ownerId>` for non-reentrant checks while still using `requestId` only to correlate grant/release messages. Each session records the `(lock name, owner id)` releaser keys it acquired. When the child exits, crashes, hits a resource limit, or otherwise settles, `cleanupSessionLocks` releases all locks still held by that session. Cleanup never force-unlocks a holder from another live execution path.

## Public surfaces

- TypeScript: `agency.withLock(name, fn, opts?)` from `agency-lang/runtime`.
- Agency stdlib: `withLock(name, timeoutMs?, warnAfterMs?) as { ... }` from `std::agency`.

Use stable, namespaced lock names for shared resources (`"std::tty"`, `"mytool::cache"`). The standard CLI policy handler wraps its prompt in `withLock("std::tty")` so parallel branches do not render overlapping prompts.

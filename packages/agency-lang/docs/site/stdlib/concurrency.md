---
name: "concurrency"
---

# concurrency

Concurrency primitives for coordinating work inside one Agency run.

## Functions

### withLock

```ts
withLock(name: string, timeoutMs: number | null, warnAfterMs: number | null, block: () => any): any
```

Run a block while holding a named per-run mutex. Concurrent branches
  of the same run that use the same lock name execute this block one
  at a time; branches using different names can continue concurrently.

  Locks are released automatically when the block returns, throws, or
  unwinds for an interrupt. In subprocesses launched with std::agency.run(),
  the lock is coordinated by the parent process so parent and child code
  share the same mutex.

  Same-owner reentrancy on the same lock throws immediately. Multi-lock
  deadlock cycles are not detected automatically; use timeoutMs when a
  bounded wait is required.

  Fork branches can run inside a lock as long as they do not reacquire the
  same lock. Reacquiring the same lock from a fork spawned inside the lock
  can deadlock because the outer scope waits for the fork to finish while
  the branch waits for the outer lock to release.

  @param name - Lock name. Use stable names like "std::tty" for shared resources.
  @param timeoutMs - Optional maximum time to wait before failing without acquiring the lock.
  @param warnAfterMs - Optional wait time before printing a diagnostic warning. Defaults to 30s.
  @param block - The work to run while holding the lock.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| timeoutMs | `number \| null` | null |
| warnAfterMs | `number \| null` | null |
| block | `() => any` | null |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/concurrency.agency#L7))

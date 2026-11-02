---
name: "concurrency"
description: "Coordinate concurrent work with locks and worker pools."
---

# concurrency

Concurrency primitives for coordinating work inside one Agency run. Use
  `withLock` to guard a shared resource so branches take turns instead of
  clobbering each other.

  ```ts
  import { withLock } from "std::concurrency"

  let counter = 0

  node main() {
    fork(range(5), shared: true) as _ {
      withLock("counter") as {
        counter = counter + 1
      }
    }
    print(counter)
  }
  ```

## Functions

### withLock

```ts
withLock(
  name: string,
  timeoutMs: number | null = null,
  warnAfterMs: number | null = null,
  block: () -> any = null,
): any
```

Run a block while holding a named lock shared by branches of one run.

Use a stable, namespaced name such as "std::tty" for a shared resource.
Parent and child code launched with `std::agency.run()` share the lock.
The lock releases when the block returns, throws, or unwinds for an interrupt.

Reacquiring a held lock from the same owner throws. A fork inside a locked
block can deadlock if it tries to acquire that lock: the outer block waits
for the fork while holding the lock. Use `timeoutMs` to bound waits when
several locks could form a cycle.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| name | `string` |  |  |
| timeoutMs | `number \| null` | null | Maximum wait to acquire the lock, or null to wait indefinitely. |
| warnAfterMs | `number \| null` | null | Wait before a diagnostic warning, or null for the 30-second default. |
| block | `() => any` | null |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/concurrency.agency#L35))

### concurrencyPool

```ts
concurrencyPool(size: number, items: any[], block: (item: any) -> any): any[]
```

Process items concurrently with at most `size` workers.

Results follow the input order. Items are assigned to workers round-robin,
so a worker processes its own items in sequence.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| size | `number` |  | Positive whole number of workers. |
| items | `any[]` |  |  |
| block | `(item: any) => any` |  |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/concurrency.agency#L54))

# Fork Parallel Interrupts

## Summary

When a `fork` runs multiple threads in parallel and more than one thread triggers an interrupt, Agency currently returns only the first interrupt and discards the rest. This feature collects all unresolved interrupts from fork threads, returns them as an array to the TypeScript caller, and resumes all interrupted threads when the caller responds.

This is also a breaking API change: `result.data` becomes an always-an-array of interrupts (even for single non-fork interrupts), and the response API is simplified to pure response constructors plus a single `respondToInterrupts` call.

## Design

### Handler resolution before batching

When a fork thread hits an interrupt, the existing `interruptWithHandlers()` mechanism runs the handler chain immediately, inside the thread. If a handler approves, the thread continues. If a handler rejects, the thread gets a failure result. Only if no handler resolves the interrupt does it propagate up to fork as an unresolved interrupt.

This means the interrupt array returned to the caller contains only truly user-facing interrupts. Well-designed programs with handlers for common cases will see fewer interrupts in the batch.

Handlers are registered on the shared `RuntimeContext`, not isolated per fork thread. They close over the parent scope's variables, not the forked thread's state. Handlers should rely on the interrupt `data` parameter for decision-making, not on forked state.

### Fork interrupt collection

`Runner.fork()` currently uses `Promise.allSettled()` and returns the first interrupt found. The new behavior:

1. After `Promise.allSettled()`, iterate through settled results
2. Collect all interrupts into an array
3. For completed threads, cache the result in `BranchState.result`
4. If the interrupt array is non-empty, return it
5. If empty, return the ordered results array (existing behavior)

```typescript
const interrupts: Interrupt[] = [];
const results: any[] = [];
for (let i = 0; i < settled.length; i++) {
  const s = settled[i];
  if (s.status === "fulfilled" && isInterrupt(s.value)) {
    interrupts.push(s.value);
  } else if (s.status === "fulfilled") {
    results.push(s.value);
  } else {
    throw s.reason;
  }
}

if (interrupts.length > 0) {
  return interrupts;
}
```

Generated code after the fork call changes from `isInterrupt()` to `hasInterrupts()`.

### Race mode

`race` mode returns the first thread to settle. If that thread's result is an interrupt, it is returned as a single-element array `[interrupt]`. No batching for race — it does not wait for other threads.

### BranchState.result — caching completed thread results

`BranchState` gets a new `result` field:

```typescript
export type BranchState = {
  stack: StateStack;
  interruptId?: string;
  interruptData?: any;
  result?: { result: any };  // present = thread completed
};
```

The `result` field is wrapped in an object to distinguish "no result cached" from "thread returned undefined". The check is `existing.result !== undefined`, and the value is `existing.result.result`.

This field:
- Is set when a thread completes successfully while sibling threads have interrupted
- Is serialized in `toJSON()` and deserialized in `fromJSON()` so it survives checkpoint restores across multiple interrupt cycles
- Is NOT cleared during fork re-execution — only cleared when the fork fully completes (all threads done, no interrupts, existing branch cleanup code)
- On resume, fork checks `existing.result !== undefined` and returns the cached result immediately, skipping re-execution of the branch entirely

This ensures that if thread A completes in round 1 and thread B interrupts multiple times across multiple cycles, thread A's result is preserved throughout.

### Interrupt IDs

Each interrupt needs a globally unique `interruptId` for routing responses back to the correct thread on resume. The `Interrupt` type currently has this field commented out (along with the `nanoid()` call in the factory function). This feature uncomments both and ensures every interrupt gets an ID assigned at creation time.

### runNode boundary — always-an-array normalization

At the `runNode` boundary (the single place where results are packaged for the TypeScript caller):

- When fork returns an interrupt array, pass it through as `result.data`
- When a single non-fork interrupt is returned, wrap it in `[interrupt]`
- `hasInterrupts()` checks for a non-empty interrupt array

Everything internal (runners, handlers, `interruptWithHandlers`) continues working with single interrupts. The array wrapping is purely an API concern at the `runNode` boundary.

### Shared checkpoint

All interrupts in the array share a single checkpoint that captures the full state tree (all fork branches, completed thread results in `BranchState`). This checkpoint is duplicated by reference onto each `Interrupt` in the array, so the array is self-contained — no wrapper type needed. `respondToInterrupts` grabs the checkpoint from `interrupts[0]`.

The checkpoint is created at the `runNode` boundary after fork returns the interrupt array, ensuring it captures the complete state including all branch stacks and cached results.

### RuntimeContext additions

Two additions to `RuntimeContext` are needed for routing responses. Both must be **private** instance variables with public accessor methods:

- `private interruptResponses: Record<string, InterruptResponse>` — maps `interruptId` to the caller's response. Set via `setInterruptResponses()` by `respondToInterrupts` before re-execution. Not serialized (set fresh on each resume).
- `getInterruptData(interruptId: string): InterruptResponse | undefined` — public accessor that looks up the response for a given interrupt ID. Called by generated code in the interrupt template on resume.

These may partially exist from the concurrent interrupts work but need to be verified and completed.

### Public API

**Response constructors (pure functions, no side effects):**

```typescript
type InterruptResponse =
  | { type: "approve"; value?: any }
  | { type: "reject"; value?: any };

function approve(value?: any): InterruptResponse;
function reject(value?: any): InterruptResponse;
```

**Type guard:**

```typescript
function hasInterrupts(data: any): data is Interrupt[];
```

**Single resumption call:**

```typescript
function respondToInterrupts(
  interrupts: Interrupt[],
  responses: InterruptResponse[]
): Promise<RunNodeResult>;
```

Positional matching: `responses[i]` answers `interrupts[i]`. Throws if `responses.length !== interrupts.length`.

`respondToInterrupts` is exported from the compiled module and closes over context internally — no explicit `ctx` parameter in the public signature.

**Usage:**

```typescript
let result = await main("hello");
if (hasInterrupts(result.data)) {
  const responses = result.data.map((item) => {
    return approve();
  });
  result = respondToInterrupts(result.data, responses);
}
```

### respondToInterrupts flow

1. Validate that `responses.length === interrupts.length`. Throw if not.
2. Build an internal map of `{ [interruptId]: response }` from the positional arrays. The caller uses positional matching; the internal mechanism is ID-keyed so threads can look up their own responses.
3. Restore from the shared checkpoint (grabbed from `interrupts[0].checkpoint`). This captures the full state tree including all fork branches and cached results.
4. Store responses on context via `ctx.setInterruptResponses(responseMap)`. This is not serialized — set fresh on each resume.
5. Re-execute. Fork re-runs. Completed threads return cached `BranchState.result.result`. Interrupted threads deserialize their branch stack, find their response via `ctx.getInterruptData(interruptId)` (public accessor), and continue past the interrupt point.
6. Return. If all threads complete, fork returns the ordered results array. If new interrupts occur (e.g., a thread hits a second interrupt after the first was approved), a new interrupt array is returned and the cycle repeats.

### Breaking changes

**Removed:**
- `approveInterrupt(interrupt, opts)` — action function
- `rejectInterrupt(interrupt, opts)` — action function
- `resolveInterrupt(interrupt, value, opts)` — action function
- `modifyInterrupt(interrupt, opts)` — action function
- `respondToInterrupt(interrupt, response, opts)` — singular

**Added:**
- `approve(value?)` — response constructor
- `reject(value?)` — response constructor
- `respondToInterrupts(interrupts, responses)` — single resumption call
- `hasInterrupts(data)` — type guard for interrupt array

**Changed:**
- `result.data` is now `Interrupt[]` when interrupts occur (was single `Interrupt`)
- `BranchState` gets a `result` field for caching completed fork thread results
- `Interrupt` type gets `interruptId` field (uncommented)

**Migration:**

```typescript
// Before:
if (isInterrupt(result.data)) {
  result = approveInterrupt(result.data);
}

// After:
if (hasInterrupts(result.data)) {
  const responses = result.data.map(() => approve());
  result = respondToInterrupts(result.data, responses);
}
```

```typescript
// Before (reject):
if (isInterrupt(result.data)) {
  result = rejectInterrupt(result.data);
}

// After:
if (hasInterrupts(result.data)) {
  const responses = result.data.map(() => reject());
  result = respondToInterrupts(result.data, responses);
}
```

```typescript
// Before (resolve with value):
if (isInterrupt(result.data)) {
  result = resolveInterrupt(result.data, "some value");
}

// After:
if (hasInterrupts(result.data)) {
  const responses = result.data.map(() => approve("some value"));
  result = respondToInterrupts(result.data, responses);
}
```

### Relationship to async concurrent interrupts

The async (`async` keyword) concurrent interrupt work in `docs/dev/concurrent-interrupts.md` solves a similar problem with different machinery (`PendingPromiseStore`, `awaitPending`, `hasChildInterrupts`). This spec is separate — fork interrupt collection happens in `Runner.fork()` after `Promise.allSettled()`, not through the pending promise store. The two systems can be unified later if needed, but for now they are independent paths that both produce interrupt arrays at the `runNode` boundary.

### Out of scope

- CLI support for batched interrupts (deferred)
- Async (`async` keyword) concurrent interrupts (can be unified later)
- Debugger UI for batched interrupts (deferred)
- Parallel tool call execution within LLM calls (separate feature)

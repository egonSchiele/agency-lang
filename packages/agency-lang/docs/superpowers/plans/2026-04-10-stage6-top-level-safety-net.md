# Top-Level Safety Net Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap top-level node execution in a try-catch that produces readable error messages for unhandled exceptions, preventing raw stack trace crashes.

**Architecture:** Add a catch clause in `runNode()` that wraps unhandled errors in a formatted `AgencyRuntimeError` with the node name, error type, and message. Known signal errors (`RestoreSignal`, interrupts) are re-thrown. All other errors are caught and formatted.

**Tech Stack:** TypeScript, vitest (testing)

---

## Tasks

- [ ] **Task 1: Create `AgencyRuntimeError` class in `lib/runtime/errors.ts`**

  Add a new error class that formats a readable message from the node name and original error:

  ```typescript
  export class AgencyRuntimeError extends Error {
    constructor(nodeName: string, originalError: unknown) {
      const errorType = originalError instanceof Error ? originalError.constructor.name : "Error";
      const errorMessage = originalError instanceof Error ? originalError.message : String(originalError);
      const message = `Error in node '${nodeName}': ${errorType}: ${errorMessage}`;
      super(message);
      this.name = "AgencyRuntimeError";
      this.cause = originalError;
    }
  }
  ```

  **Files:** `lib/runtime/errors.ts`

- [ ] **Task 2: Add safety net catch in `runNode()`**

  In `runNode()` in `lib/runtime/node.ts`, wrap the top-level node execution in a try-catch. The catch clause should:
  1. Re-throw `RestoreSignal` (already handled by the existing inner try-catch, but be defensive).
  2. Re-throw `ConcurrentInterruptError` and any interrupt-related errors.
  3. Re-throw `CheckpointError` and `ToolCallError` — these are internal infrastructure errors, not user code errors, and should propagate without wrapping.
  4. For all other errors, throw a new `AgencyRuntimeError` with the node name and original error.

  The node name is available from the function parameters. Place the catch on the outer try block (the one with the `finally` clause), turning it into a try-catch-finally. This ensures it acts as a last-resort handler around the outermost execution scope.

  **Files:** `lib/runtime/node.ts`

- [ ] **Task 3: Unit tests for error formatting and pass-through**

  Add a test file `lib/runtime/errors.test.ts` (or add to existing tests) that verifies:
  - Constructing `AgencyRuntimeError` with a node name and a `TypeError` produces a message like `Error in node 'main': TypeError: Cannot read properties of undefined (reading 'x')`.
  - Constructing with a non-Error value (e.g. a string) still produces a readable message.
  - `RestoreSignal` and `ConcurrentInterruptError` are not instances of `AgencyRuntimeError` (sanity check that the class hierarchy is correct and they won't be accidentally caught).
  - `RestoreSignal` and `ConcurrentInterruptError` propagate through `runNode()` without being wrapped in `AgencyRuntimeError`. Mock or set up a minimal `runNode()` call that throws each of these, and assert the thrown error is the original instance, not an `AgencyRuntimeError`.

  **Files:** `lib/runtime/errors.test.ts`

- [ ] **Task 4: E2E test — unhandled exception produces readable error**

  Add an Agency e2e test in `tests/agency/` with the following concrete fixtures:

  **`tests/agency/safety-net-error.agency`:**
  ```
  import { throwError } from "./safety-net-helper.js"

  node main() {
    let result = throwError()
    return result
  }
  ```

  **`tests/agency/safety-net-helper.ts`:**
  ```typescript
  export function throwError(): string {
    const obj: any = undefined;
    return obj.foo; // throws TypeError
  }
  ```

  **`tests/agency/safety-net-error.test.json`:**
  ```json
  {
    "expectError": {
      "type": "AgencyRuntimeError",
      "messageContains": ["Error in node 'main'", "TypeError"]
    }
  }
  ```

  The test should assert that execution fails with an `AgencyRuntimeError` whose message includes the node name and the original error type, rather than a raw stack trace.

  **Files:** `tests/agency/safety-net-error.agency`, `tests/agency/safety-net-helper.ts`, `tests/agency/safety-net-error.test.json`

import { describe, it, expect, afterEach } from "vitest";
// IMPORTANT: import the runtime via the package export, not via relative
// paths. The compiled `stdlib/ui/cli.js` imports from `agency-lang/runtime`
// which resolves to `dist/lib/runtime/index.js`; using `../runtime/...`
// here would load a separate module instance with its own
// `AsyncLocalStorage`, so `runInTestContext()` wouldn't propagate to
// `getRuntimeContext()` calls inside the compiled stdlib.
import {
  __call,
  runInTestContext,
  RuntimeContext,
  StateStack,
  ThreadStore,
} from "agency-lang/runtime";
import prompts from "prompts";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – compiled-by-make Agency module; no .d.ts is emitted
import { chooseOption } from "../../stdlib/ui/cli.js";

// `chooseOption` picks its branch with `_isTTY()`, which reads
// `process.stdin.isTTY` through the host, and the prompt bridge under
// it checks `process.stdout.isTTY`. Spoof both so the tests take the
// terminal branch whether or not vitest is attached to a terminal.
// Answers come from `prompts.inject`, so no keyboard is needed.
let _restoreTty: (() => void) | null = null;
function spoofTty(value: boolean): void {
  const streams = [process.stdout, process.stdin];
  const descs = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  for (const stream of streams) {
    Object.defineProperty(stream, "isTTY", {
      configurable: true,
      get: () => value,
    });
  }
  _restoreTty = () => {
    streams.forEach((stream, i) => {
      const desc = descs[i];
      if (desc) Object.defineProperty(stream, "isTTY", desc);
      else delete (stream as any).isTTY;
    });
    _restoreTty = null;
  };
}
function restoreTty(): void {
  if (_restoreTty) _restoreTty();
}

function makeTestCtx(): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: {},
    dirname: "/tmp",
  });
}

describe("chooseOption, the terminal branch", () => {
  afterEach(() => {
    restoreTty();
    // `prompts.inject` appends to a module-level queue that only a prompt
    // call drains. A test that queues more answers than it reads (the
    // allowCancel case does, on purpose) would otherwise hand its leftover
    // to the next test. `_injected` is the package's private field for it.
    (prompts as any)._injected = undefined;
  });

  it("returns the picked key on a clean select", async () => {
    spoofTty(true);
    prompts.inject(["a"]);
    const ctx = makeTestCtx();
    const answer = await runInTestContext(ctx, new StateStack(), new ThreadStore(), (run) =>
      __call(run, chooseOption, {
        type: "named",
        positionalArgs: [],
        namedArgs: {
          title: "Pick one",
          body: "",
          items: [
            { key: "a", label: "approve" },
            { key: "r", label: "reject" },
          ],
        },
      }),
    );
    expect(answer).toBe("a");
  });

  it("returns free text verbatim with allowFreeText", async () => {
    // CAVEAT — encoding leakage: this test hardcodes the
    // `AUTOCOMPLETE_FREE_TEXT_PREFIX` (`__FREETEXT__:`) that
    // `_promptsAutocomplete` uses internally between its `suggest`
    // callback and its resolver. `prompts.inject` skips the suggest
    // step and feeds the resolved value directly, so we have to
    // simulate "user picked the synthetic row" by manually emitting
    // the prefixed value. Production callers never see this prefix.
    // If you change `AUTOCOMPLETE_FREE_TEXT_PREFIX` in prompts.ts, update
    // this string too.
    spoofTty(true);
    prompts.inject(["__FREETEXT__:please don't delete that"]);
    const ctx = makeTestCtx();
    const answer = await runInTestContext(ctx, new StateStack(), new ThreadStore(), (run) =>
      __call(run, chooseOption, {
        type: "named",
        positionalArgs: [],
        namedArgs: {
          title: "Pick one",
          body: "",
          items: [
            { key: "a", label: "approve" },
            { key: "r", label: "reject" },
          ],
          allowFreeText: true,
        },
      }),
    );
    expect(answer).toBe("please don't delete that");
  });

  it("re-prompts on cancel to preserve the must-answer contract", async () => {
    // First inject(null) cancels → bridge returns failure("cancelled").
    // chooseOption loops; second answer resolves with "a".
    spoofTty(true);
    prompts.inject([null, "a"]);
    const ctx = makeTestCtx();
    const answer = await runInTestContext(ctx, new StateStack(), new ThreadStore(), (run) =>
      __call(run, chooseOption, {
        type: "named",
        positionalArgs: [],
        namedArgs: {
          title: "Pick one",
          body: "",
          items: [{ key: "a", label: "approve" }],
        },
      }),
    );
    expect(answer).toBe("a");
  });

  it("aborts the run on Escape when allowCancel is set", async () => {
    // With `allowCancel`, Escape raises a cancellation that unwinds the
    // run instead of re-asking. `__call` hands that back as an aborted
    // result value, not a rejection. A second answer is queued so a
    // regression shows up as the wrong result ("a"), not a hung test.
    spoofTty(true);
    prompts.inject([null, "a"]);
    const ctx = makeTestCtx();
    const result: any = await runInTestContext(ctx, new StateStack(), new ThreadStore(), (run) =>
      __call(run, chooseOption, {
        type: "named",
        positionalArgs: [],
        namedArgs: {
          title: "Pick one",
          body: "",
          items: [{ key: "a", label: "approve" }],
          allowCancel: true,
        },
      }),
    );
    expect(result).not.toBe("a");
    expect(result?.__type).toBe("abortedResult");
    expect(result?.cause?.reason).toMatch(/cancelled/);
  });
});

import { describe, it, expect } from "vitest";
// IMPORTANT: import the runtime via the package export, not via relative
// paths. The compiled `stdlib/ui.js` imports from `agency-lang/runtime`
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
// Same module-instance caveat as above: the compiled `stdlib/ui.js`
// imports `_runLoop` and friends from `agency-lang/stdlib-lib/ui.js`
// (which maps to `dist/lib/stdlib/ui.js`). A relative `./ui.js` import
// here would land in `lib/stdlib/ui.ts` instead, so `_setInputSource`
// would mutate a different module-level `bridgeInputSource` than the
// one the REPL actually reads — leaving the loop blocked on the real
// terminal.
import {
  _setInputSource,
  _setOutputTarget,
  _setSize,
  _uninstallConsoleCapture,
} from "agency-lang/stdlib-lib/ui.js";
import { ScriptedInput } from "@/tui/input/scripted.js";
import { FrameRecorder } from "@/tui/output/recorder.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – compiled-by-make Agency module; no .d.ts is emitted
import { repl, chooseOption } from "../../stdlib/ui.js";

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

async function invokeRepl(
  keys: { key: string; ctrl?: boolean }[],
  opts: {
    onSubmit: (prompt: string) => unknown;
    paletteCommands?: Record<string, string>;
    status?: () => { left: string; right: string };
  },
): Promise<void> {
  _setInputSource(new ScriptedInput(keys));
  _setOutputTarget(new FrameRecorder());
  _setSize(80, 24);
  const ctx = makeTestCtx();
  try {
    await runInTestContext(ctx, new StateStack(), new ThreadStore(), () =>
      __call(repl, {
        type: "named",
        positionalArgs: [],
        namedArgs: {
          status: opts.status ?? (() => ({ left: "", right: "" })),
          onSubmit: opts.onSubmit,
          paletteCommands: opts.paletteCommands ?? {},
        },
      }),
    );
  } finally {
    _setInputSource(null);
    _setOutputTarget(null);
    _uninstallConsoleCapture();
  }
}

/**
 * End-to-end coverage for the Agency-side REPL state machine
 * (history navigation, palette filtering, empty-Enter no-op, exit).
 * Drives the compiled `stdlib/ui.js` `repl()` AgencyFunction through
 * `__call` with a ScriptedInput + FrameRecorder so we exercise the
 * real `_replReduce` rather than re-implementing it in TS.
 */
describe("std::ui — REPL state machine (Agency-driven)", () => {
  it("recalls the previous submission via the up arrow", async () => {
    const submits: string[] = [];
    await invokeRepl(
      [
        { key: "a" }, { key: "enter" },
        { key: "b" }, { key: "enter" },
        { key: "up" }, { key: "enter" },
      ],
      {
        onSubmit: (p: string) => {
          submits.push(p);
          return submits.length < 3 ? true : false;
        },
      },
    );
    expect(submits).toEqual(["a", "b", "b"]);
  });

  it("opens the palette on / and selects the filtered entry on Enter", async () => {
    const submits: string[] = [];
    await invokeRepl(
      [
        { key: "/" },
        { key: "e" }, { key: "x" },
        { key: "enter" },   // selects /exit into buffer (does not submit)
        { key: "enter" },   // submits /exit
      ],
      {
        onSubmit: (p: string) => {
          submits.push(p);
          return false;
        },
        paletteCommands: { "/exit": "Exit", "/help": "Help" },
      },
    );
    expect(submits).toEqual(["/exit"]);
  });

  it("ignores Enter on an empty buffer (no submit, no transcript noise)", async () => {
    // Pressing Enter on an empty input should NOT call onSubmit.
    // We then type "ok" and press Enter to exit — exactly one submit
    // should be recorded.
    const submits: string[] = [];
    await invokeRepl(
      [
        { key: "enter" },                // empty — no-op
        { key: "enter" },                // empty — no-op
        { key: "o" }, { key: "k" }, { key: "enter" }, // real submit
      ],
      {
        onSubmit: (p: string) => {
          submits.push(p);
          return false;
        },
      },
    );
    expect(submits).toEqual(["ok"]);
  });

  it("chooseOption opens a modal, navigates, and resolves with the picked key", async () => {
    // We feed the modal-driving keys AFTER chooseOption has opened
    // the prompt. The submit-trigger keys are pre-queued; the modal
    // keys are fed from inside onSubmit so they don't race past the
    // not-yet-open modal.
    const picks: string[] = [];
    const scripted = new ScriptedInput([
      { key: "g" }, { key: "o" }, { key: "enter" },
    ]);
    _setInputSource(scripted);
    _setOutputTarget(new FrameRecorder());
    _setSize(80, 24);
    const ctx = makeTestCtx();
    try {
      await runInTestContext(ctx, new StateStack(), new ThreadStore(), () =>
        __call(repl, {
          type: "named",
          positionalArgs: [],
          namedArgs: {
            status: () => ({ left: "", right: "" }),
            onSubmit: async (_p: string) => {
              // Schedule modal keys after onSubmit has started; they'll
              // land in the input queue only once `_openChoicePrompt`
              // has flipped the bridge slot.
              setTimeout(() => {
                scripted.feedKey({ key: "down" });
                scripted.feedKey({ key: "enter" });
              }, 0);
              const answer = await __call(chooseOption, {
                type: "named",
                positionalArgs: [],
                namedArgs: {
                  title: "Pick one",
                  body: "context",
                  items: [
                    { key: "a", label: "alpha" },
                    { key: "b", label: "beta" },
                  ],
                },
              });
              picks.push(answer as string);
              return false;
            },
            paletteCommands: {},
          },
        }),
      );
    } finally {
      _setInputSource(null);
      _setOutputTarget(null);
      _uninstallConsoleCapture();
    }
    expect(picks).toEqual(["b"]);
  });

  it("chooseOption resolves with the first item on plain Enter", async () => {
    const picks: string[] = [];
    const scripted = new ScriptedInput([
      { key: "g" }, { key: "enter" },
    ]);
    _setInputSource(scripted);
    _setOutputTarget(new FrameRecorder());
    _setSize(80, 24);
    const ctx = makeTestCtx();
    try {
      await runInTestContext(ctx, new StateStack(), new ThreadStore(), () =>
        __call(repl, {
          type: "named",
          positionalArgs: [],
          namedArgs: {
            status: () => ({ left: "", right: "" }),
            onSubmit: async (_p: string) => {
              setTimeout(() => scripted.feedKey({ key: "enter" }), 0);
              const answer = await __call(chooseOption, {
                type: "named",
                positionalArgs: [],
                namedArgs: {
                  title: "T",
                  body: "",
                  items: [
                    { key: "yes", label: "Yes" },
                    { key: "no", label: "No" },
                  ],
                },
              });
              picks.push(answer as string);
              return false;
            },
            paletteCommands: {},
          },
        }),
      );
    } finally {
      _setInputSource(null);
      _setOutputTarget(null);
      _uninstallConsoleCapture();
    }
    expect(picks).toEqual(["yes"]);
  });

  it("chooseOption escape cancels the modal as a Failure return", async () => {
    // Agency wraps thrown errors from async functions into a Failure
    // record (not a JS exception), so `await chooseOption(...)` returns
    // a `{ success: false, error }` value when the user hits Escape.
    const replies: any[] = [];
    const scripted = new ScriptedInput([
      { key: "g" }, { key: "enter" },
    ]);
    _setInputSource(scripted);
    _setOutputTarget(new FrameRecorder());
    _setSize(80, 24);
    const ctx = makeTestCtx();
    try {
      await runInTestContext(ctx, new StateStack(), new ThreadStore(), () =>
        __call(repl, {
          type: "named",
          positionalArgs: [],
          namedArgs: {
            status: () => ({ left: "", right: "" }),
            onSubmit: async (_p: string) => {
              setTimeout(() => scripted.feedKey({ key: "escape" }), 0);
              const answer = await __call(chooseOption, {
                type: "named",
                positionalArgs: [],
                namedArgs: {
                  title: "T",
                  body: "",
                  items: [{ key: "a", label: "A" }],
                },
              });
              replies.push(answer);
              return false;
            },
            paletteCommands: {},
          },
        }),
      );
    } finally {
      _setInputSource(null);
      _setOutputTarget(null);
      _uninstallConsoleCapture();
    }
    expect(replies.length).toBe(1);
    expect(replies[0]?.success).toBe(false);
    expect(String(replies[0]?.error ?? "")).toMatch(/cancel/i);
  });

  it("exits when onSubmit returns false", async () => {
    let onSubmitCalls = 0;
    await invokeRepl(
      [{ key: "x" }, { key: "enter" }],
      {
        onSubmit: () => {
          onSubmitCalls += 1;
          return false;
        },
      },
    );
    expect(onSubmitCalls).toBe(1);
  });
});

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
  _promptsAutocomplete,
  _promptsSelect,
  _promptsText,
  _promptsConfirm,
  __suggestForTest,
} from "agency-lang/stdlib-lib/ui.js";
import prompts from "prompts";
import { ScriptedInput } from "@/tui/input/scripted.js";
import { FrameRecorder } from "@/tui/output/recorder.js";
import { afterEach, beforeEach } from "vitest";

// Spoof `process.stdout.isTTY` for tests that need to exercise the
// TTY-required code path without depending on whether vitest itself
// is running attached to a real TTY.
let _restoreTty: (() => void) | null = null;
function spoofTty(value: boolean): void {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    get: () => value,
  });
  _restoreTty = () => {
    if (desc) Object.defineProperty(process.stdout, "isTTY", desc);
    else delete (process.stdout as any).isTTY;
    _restoreTty = null;
  };
}
function restoreTty(): void {
  if (_restoreTty) _restoreTty();
}
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

  it("Ctrl+U clears the input buffer without affecting history", async () => {
    // Type "junk", Ctrl+U to wipe it, then type "ok" + Enter. The
    // only submit observed should be "ok"; "junk" never reaches
    // onSubmit and never lands in history.
    const submits: string[] = [];
    await invokeRepl(
      [
        { key: "j" }, { key: "u" }, { key: "n" }, { key: "k" },
        { key: "u", ctrl: true },
        { key: "o" }, { key: "k" }, { key: "enter" },
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

  it("a bracketed paste lands in the buffer wholesale and submits intact", async () => {
    // The terminal-input layer turns a real bracketed paste into a
    // single `{ key: "paste", text }` event. The reducer must append
    // the whole payload at once — including newlines — rather than
    // treating embedded `\n` as Enter.
    const submits: string[] = [];
    await invokeRepl(
      [
        { key: "paste", text: "hello\nworld" } as any,
        { key: "enter" },
      ],
      {
        onSubmit: (p: string) => {
          submits.push(p);
          return false;
        },
      },
    );
    expect(submits).toEqual(["hello\nworld"]);
  });

  it("Shift+Enter inserts a newline into the buffer instead of submitting", async () => {
    // `{ key: "enter", shift: true }` is the canonical shape produced
    // by the terminal layer for Alt/Option+Enter (the portable
    // fallback when the terminal can't send a distinct Shift+Enter
    // code). It should add `\n` to the buffer; plain Enter still
    // submits the multi-line result.
    const submits: string[] = [];
    await invokeRepl(
      [
        { key: "a" },
        { key: "enter", shift: true } as any,
        { key: "b" },
        { key: "enter" },
      ],
      {
        onSubmit: (p: string) => {
          submits.push(p);
          return false;
        },
      },
    );
    expect(submits).toEqual(["a\nb"]);
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

  it("chooseOption(allowFreeText: true) resolves with the filter text when no item matches", async () => {
    // The user types a free-form rejection reason at the choice
    // prompt instead of picking a key. With `allowFreeText: true`,
    // pressing Enter on a filter that matches zero items resolves
    // with that filter text — used by std::policy to collapse the
    // "pick (r), then type reason" two-step into a single keystroke.
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
              setTimeout(() => {
                // Filter "no way" — no substring overlap with "alpha"
                // or "beta", so visibleItems becomes empty. Enter
                // should resolve with the filter text verbatim.
                for (const ch of "no way") {
                  scripted.feedKey({ key: ch });
                }
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
                  allowFreeText: true,
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
    expect(picks).toEqual(["no way"]);
  });

  it("chooseOption(allowFreeText: true) still picks a matched item when one is visible", async () => {
    // Sanity check: free-text mode doesn't override the normal
    // key-pick path. A filter that narrows to a single item resolves
    // with that item's key on Enter, exactly like the default mode.
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
              setTimeout(() => {
                // "be" narrows to just the "beta" item.
                scripted.feedKey({ key: "b" });
                scripted.feedKey({ key: "e" });
                scripted.feedKey({ key: "enter" });
              }, 0);
              const answer = await __call(chooseOption, {
                type: "named",
                positionalArgs: [],
                namedArgs: {
                  title: "Pick one",
                  body: "",
                  items: [
                    { key: "a", label: "alpha" },
                    { key: "b", label: "beta" },
                  ],
                  allowFreeText: true,
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
});

describe("std::ui — chooseOption line-mode (prompts-backed)", () => {
  afterEach(() => restoreTty());

  it("returns the picked key on a clean select", async () => {
    spoofTty(true);
    prompts.inject(["a"]);
    const ctx = makeTestCtx();
    const answer = await runInTestContext(
      ctx, new StateStack(), new ThreadStore(),
      () => __call(chooseOption, {
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
    // If you change `AUTOCOMPLETE_FREE_TEXT_PREFIX` in ui.ts, update
    // this string too.
    spoofTty(true);
    prompts.inject(["__FREETEXT__:please don't delete that"]);
    const ctx = makeTestCtx();
    const answer = await runInTestContext(
      ctx, new StateStack(), new ThreadStore(),
      () => __call(chooseOption, {
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
    const answer = await runInTestContext(
      ctx, new StateStack(), new ThreadStore(),
      () => __call(chooseOption, {
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

  it("surfaces non-TTY as a failure rather than looping", async () => {
    // chooseOption is declared `: string`, but Agency's runtime wraps
    // any thrown error as a `failure(...)` Result before returning.
    // So callers see a Result-shaped object whose `error` contains
    // the TTY message, not a JS exception. The important contract
    // here is "does NOT loop forever" — the test would hang if the
    // chooseOption loop didn't break out on non-cancel failures.
    spoofTty(false);
    const ctx = makeTestCtx();
    const result: any = await runInTestContext(
      ctx, new StateStack(), new ThreadStore(),
      () => __call(chooseOption, {
        type: "named",
        positionalArgs: [],
        namedArgs: {
          title: "Pick one",
          body: "",
          items: [{ key: "a", label: "approve" }],
        },
      }),
    );
    expect(result?.success).toBe(false);
    expect(String(result?.error)).toMatch(/requires a TTY/);
  });
});

describe("std::ui — _promptsAutocomplete bridge guards", () => {
  afterEach(() => {
    restoreTty();
  });

  it("throws when stdout is not a TTY", async () => {
    spoofTty(false);
    await expect(
      _promptsAutocomplete("pick", [{ key: "a", label: "A" }], false),
    ).rejects.toThrow(/requires a TTY/);
  });

  it("throws when a repl() owns the screen", async () => {
    spoofTty(true);
    // `_hasActiveScreen()` returns true only while `_runReplLoop` is
    // mid-flight. To create that precondition, invoke
    // `_promptsAutocomplete` from inside a running repl's `onSubmit`
    // callback — same shape as the modal-path test above.
    const errors: unknown[] = [];
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
              try {
                await _promptsAutocomplete(
                  "pick",
                  [{ key: "a", label: "A" }],
                  false,
                );
              } catch (e) {
                errors.push(e);
              }
              return false; // exit the repl
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
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toMatch(
      /cannot be used inside an active repl/,
    );
  });
});

describe("std::ui — _promptsAutocomplete happy path", () => {
  beforeEach(() => spoofTty(true));
  afterEach(() => restoreTty());

  it("returns success with the picked key on resolve", async () => {
    prompts.inject(["a"]);
    const result = await _promptsAutocomplete(
      "pick",
      [
        { key: "a", label: "Approve" },
        { key: "r", label: "Reject" },
      ],
      false,
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe("a");
  });

  it("returns failure('cancelled') when the user cancels", async () => {
    prompts.inject([null]);
    const result = await _promptsAutocomplete(
      "pick",
      [{ key: "a", label: "Approve" }],
      false,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("cancelled");
  });

  it("decodes the __FREETEXT__: prefix on resolve", async () => {
    prompts.inject(["__FREETEXT__:please don't delete that"]);
    const result = await _promptsAutocomplete(
      "pick",
      [{ key: "a", label: "Approve" }],
      true,
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe("please don't delete that");
  });

  it("suggest() returns matching items by key or label, substring, case-insensitive", async () => {
    const matched = await __suggestForTest(
      "App",
      [
        { key: "a", label: "Approve" },
        { key: "r", label: "Reject" },
      ],
      false,
    );
    expect(matched.map((m) => m.value)).toEqual(["a"]);
  });

  it("suggest() appends synthetic free-text row only when allowFreeText && input && no real match", async () => {
    const noMatch = await __suggestForTest(
      "xyz",
      [{ key: "a", label: "Approve" }],
      true,
    );
    expect(noMatch).toHaveLength(1);
    expect(noMatch[0].value).toBe("__FREETEXT__:xyz");
    expect(noMatch[0].title).toContain("→");
    expect(noMatch[0].title).toContain("xyz");

    const withMatch = await __suggestForTest(
      "app",
      [{ key: "a", label: "Approve" }],
      true,
    );
    expect(withMatch).toHaveLength(1);
    expect(withMatch[0].value).toBe("a");

    const empty = await __suggestForTest(
      "",
      [{ key: "a", label: "A" }],
      true,
    );
    expect(
      empty.some((m) => String(m.value).startsWith("__FREETEXT__")),
    ).toBe(false);

    const off = await __suggestForTest(
      "xyz",
      [{ key: "a", label: "A" }],
      false,
    );
    expect(
      off.some((m) => String(m.value).startsWith("__FREETEXT__")),
    ).toBe(false);
  });
});

// All three bridges share `_assertLineModeAvailable`, which is
// already covered for `_promptsAutocomplete` in the Task 1 block
// above. To avoid running a full repl harness three more times,
// these blocks only test the non-TTY branch. Trust that the shared
// helper guards the active-repl case for all four bridges.

describe("std::ui — _promptsSelect", () => {
  afterEach(() => restoreTty());

  it("throws on non-TTY", async () => {
    spoofTty(false);
    await expect(
      _promptsSelect("pick", [{ key: "a", label: "A" }], false),
    ).rejects.toThrow(/requires a TTY/);
  });

  it("returns success with the picked key", async () => {
    spoofTty(true);
    prompts.inject(["r"]);
    const result = await _promptsSelect(
      "pick",
      [
        { key: "a", label: "A" },
        { key: "r", label: "R" },
      ],
      false,
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe("r");
  });

  it("returns failure('cancelled') on cancel", async () => {
    spoofTty(true);
    prompts.inject([null]);
    const result = await _promptsSelect(
      "pick",
      [{ key: "a", label: "A" }],
      false,
    );
    expect(result.success).toBe(false);
  });

  it("with allowFreeText=true, runs a follow-up text prompt when free-text sentinel is picked", async () => {
    spoofTty(true);
    // Queue two answers: the sentinel pick, then the typed text.
    prompts.inject(["__FREETEXT__", "my custom reason"]);
    const result = await _promptsSelect(
      "pick",
      [{ key: "a", label: "Approve" }],
      true,
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe("my custom reason");
  });

  it("with allowFreeText=true, ignores the follow-up when a real key is picked", async () => {
    spoofTty(true);
    prompts.inject(["a"]);
    const result = await _promptsSelect(
      "pick",
      [{ key: "a", label: "Approve" }],
      true,
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe("a");
  });
});

describe("std::ui — _promptsText", () => {
  afterEach(() => restoreTty());

  it("throws on non-TTY", async () => {
    spoofTty(false);
    await expect(_promptsText("name?", "")).rejects.toThrow(/requires a TTY/);
  });

  it("returns success with the typed value", async () => {
    spoofTty(true);
    prompts.inject(["hello world"]);
    const result = await _promptsText("name?", "");
    expect(result.success).toBe(true);
    expect(result.value).toBe("hello world");
  });

  it("returns failure on cancel", async () => {
    spoofTty(true);
    prompts.inject([null]);
    const result = await _promptsText("name?", "");
    expect(result.success).toBe(false);
  });

  it("forwards a validate callback to prompts", async () => {
    // PFA capability-constraint story: a caller binds `validate` via
    // `.partial(validate: myFn)` before handing `text` to an LLM. We
    // can't easily fail-then-retry through inject, so this asserts
    // only that the callback is plumbed through and the bridge still
    // resolves with the injected value.
    spoofTty(true);
    prompts.inject(["abc"]);
    const result = await _promptsText("nick?", "", "", (v: string) =>
      v.length >= 3 ? true : "too short",
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe("abc");
  });
});

describe("std::ui — _promptsConfirm", () => {
  afterEach(() => restoreTty());

  it("throws on non-TTY", async () => {
    spoofTty(false);
    await expect(_promptsConfirm("ok?", false)).rejects.toThrow(/requires a TTY/);
  });

  it("returns success(true) on yes", async () => {
    spoofTty(true);
    prompts.inject([true]);
    const result = await _promptsConfirm("ok?", false);
    expect(result.success).toBe(true);
    expect(result.value).toBe(true);
  });

  it("returns success(false) on no", async () => {
    spoofTty(true);
    prompts.inject([false]);
    const result = await _promptsConfirm("ok?", false);
    expect(result.success).toBe(true);
    expect(result.value).toBe(false);
  });

  it("returns failure on cancel", async () => {
    spoofTty(true);
    prompts.inject([null]);
    const result = await _promptsConfirm("ok?", false);
    expect(result.success).toBe(false);
  });
});

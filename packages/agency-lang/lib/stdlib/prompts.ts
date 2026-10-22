import process from "process";
import prompts from "prompts";
import { color } from "@/utils/termcolors.js";
import { isFailure, success, failure } from "../runtime/result.js";
import { AgencyCancelledError } from "../runtime/errors.js";
import { exitProcessNow } from "../runtime/exitProcess.js";

// ---------------------------------------------------------------------------
// Line-mode prompts, backed by the `prompts` package.
//
// These are the TypeScript halves of `select`, `autocomplete`, `prompt`,
// and `confirm` in `std::ui/cli` (the Agency side calls `_promptsText`
// `prompt`). `chooseOption` in the same module uses `_promptsAutocomplete`
// for its terminal branch. Each one refuses when stdout is not a terminal;
// there is no non-terminal fallback here by design. `chooseOption` is the
// place that falls back to reading a key with `input()`.
// ---------------------------------------------------------------------------

type PromptsChoiceItem = { key: string; label: string };

function _assertLineModeAvailable(name: string): void {
  if (!process.stdout.isTTY) {
    throw new Error(`${name} requires a TTY (stdout is not a TTY)`);
  }
}

// `__FREETEXT__:` is `_promptsAutocomplete`'s private wire format for
// smuggling user-typed free-text values out of the autocomplete UI.
// `_promptsSelect` uses a different mechanism (sentinel value +
// follow-up text prompt) since `prompts.select` has no `suggest` hook.
const AUTOCOMPLETE_FREE_TEXT_PREFIX = "__FREETEXT__:";

// Shared cancellation+Result wrapper for every `prompts(...)` call.
// All four bridges call this; the only differences between them are
// the question they build and the post-processing they apply to the
// successful value.
//
// Four side-effects beyond just calling prompts:
//
//   1. `onCancel` returns `false` to suppress prompts' default
//      `process.exit(0)` on Ctrl+C, so we can return a Result.failure
//      instead. (Callers loop on cancel to preserve `chooseOption`'s
//      must-answer contract.)
//
//   2. `onState` on the question detects Escape on `autocomplete` /
//      `select`. Those prompts treat Escape as "exit" — the promise
//      resolves with the currently-highlighted value rather than
//      firing onCancel. Without this hook, pressing Escape in the
//      slash palette or interrupt menu silently submits whatever's
//      under the cursor (see prompts/lib/elements/autocomplete.js
//      `exit()` and util/action.js `key.name === 'escape'` → 'exit').
//      `state.exited === true && state.aborted === false` ⇒ Escape;
//      flip our local `cancelled` flag so the resolve path below
//      returns `failure("cancelled")`.
//
//   3. Before opening the prompt, we call `globalThis.__agencyStopSpinner`
//      if the line-mode REPL (`lib/stdlib/cli.ts`) has registered one.
//      This pauses the "Thinking" timer while the user is being asked
//      something — otherwise the timer keeps ticking over an open
//      policy interrupt menu. No-op outside line-mode REPL.
//
//   4. We attach a stdin `data` listener that detects the Ctrl+C byte
//      (`0x03`) and calls `process.exit(130)` immediately after the
//      prompt resolves. Without this, `prompts` swallows Ctrl+C as an
//      abort and our caller's retry loop reprompts forever, leaving
//      the user with no way to quit. 130 = 128 + SIGINT, the standard
//      shell convention for "killed by Ctrl+C".
async function _runPrompt(question: prompts.PromptObject): Promise<any> {
  const stopSpinner = (globalThis as any).__agencyStopSpinner;
  if (typeof stopSpinner === "function") {
    stopSpinner();
  }

  let cancelled = false;
  let ctrlC = false;
  const onStdinData = (chunk: Buffer): void => {
    // 0x03 = Ctrl+C. Any chunk containing it counts (pastes can't
    // legitimately include 0x03 in raw mode, so this is unambiguous).
    if (chunk && chunk.includes(0x03)) ctrlC = true;
  };
  process.stdin.on("data", onStdinData);

  // `prompts` creates its own readline interface on `process.stdin`
  // and calls `rl.close()` when the prompt resolves. Node's
  // `readline.Interface.close()` calls `input.pause()`, which pauses
  // *the shared* `process.stdin` — silently killing the outer
  // readline interface in `_runLineRepl` (its `rl.question()` will
  // never fire another keypress, the await hangs, Node sees an empty
  // event loop, and the agent exits with code 13 / "unsettled
  // top-level await"). Snapshot the paused state on entry and
  // restore it on exit so we don't leave the outer REPL dead.
  // (If stdin was already paused — e.g. running standalone with no
  // REPL — we leave it paused so the process can still exit cleanly.)
  const wasPaused = process.stdin.isPaused();

  // `prompts` leaves `process.stdin` in cooked (canonical) mode when it
  // closes its readline. The line-mode REPL runs in raw mode and renders
  // input itself, so a cooked stdin makes the terminal ALSO echo every
  // line — the user sees their next prompt printed twice, and it persists
  // because nothing re-asserts raw afterward. Snapshot the raw state on
  // entry and restore it on exit (mirrors `wasPaused` above) so the modal
  // leaves the terminal exactly as it found it.
  const wasRaw = !!(process.stdin.isTTY && process.stdin.isRaw);

  // Wrap any caller-supplied `onState` so we always get a shot at
  // detecting Escape, without clobbering custom state hooks.
  const userOnState = (question as any).onState;
  (question as any).onState = (state: { value: unknown; aborted: boolean; exited: boolean }) => {
    // `exited` = Escape; `aborted` = Ctrl+C / Ctrl+D. Either way the
    // user said "back out", so don't return the currently-highlighted
    // choice.
    if (state.exited || state.aborted) cancelled = true;
    if (typeof userOnState === "function") userOnState(state);
  };

  try {
    const answer = await prompts(question, {
      onCancel: () => {
        cancelled = true;
        // Returning false here keeps `prompts` from exiting the
        // process so we can surface failure("cancelled") to the
        // caller's retry loop.
        return false;
      },
    });

    if (ctrlC) {
      // Ctrl+C escapes the entire prompt session. Drop straight out
      // of the process — even if the surrounding agency code has a
      // retry loop, the user has signalled "quit, not retry." Leave at
      // once, without waiting on log uploads.
      exitProcessNow(130);
    }

    // Cancellation paths:
    //  - `cancelled` flag set by onState (Escape) or onCancel (Ctrl+C/D).
    //  - Missing/null value (defensive — covers `prompts.inject([null])`
    //    and any future edge case where the prompt resolves with no
    //    answer).
    if (cancelled || !("value" in answer) || answer.value == null) {
      return failure("cancelled");
    }
    return success(answer.value);
  } finally {
    process.stdin.off("data", onStdinData);
    if (!wasPaused && process.stdin.isPaused()) {
      process.stdin.resume();
    }
    // Restore the raw-mode state `prompts` clobbered (see `wasRaw` above).
    if (
      process.stdin.isTTY &&
      typeof process.stdin.setRawMode === "function" &&
      process.stdin.isRaw !== wasRaw
    ) {
      process.stdin.setRawMode(wasRaw);
    }
  }
}

// Exported for unit tests; do not call from production code.
export function __suggestForTest(
  input: string,
  items: PromptsChoiceItem[],
  allowFreeText: boolean,
): Promise<{ title: string; value: string }[]> {
  return _buildSuggest(items, allowFreeText)(input, []);
}

function _buildSuggest(
  items: PromptsChoiceItem[],
  allowFreeText: boolean,
): (input: string, choices: any[]) => Promise<{ title: string; value: string }[]> {
  return async (input: string, _choices: any[]) => {
    const q = (input ?? "").toLowerCase();
    // Match against `key` only (substring, case-insensitive), not
    // against `label`. Policy interrupt labels routinely contain "r"
    // (in "approve" and "reject") and "a" (in "always"), so a label
    // substring match would never narrow anything — typing `r` would
    // still show every row. Key-only matching produces the expected
    // behavior: `r` shows just the `r` row, `ap` narrows to `ap` /
    // `approve`-prefixed keys, etc. Users still see the label in the
    // rendered title, so they're not flying blind.
    const matched = items
      .filter((it) => it.key.toLowerCase().includes(q))
      .map((it) => ({ title: `${color.cyan(it.key)} - ${it.label}`, value: it.key }));
    if (allowFreeText && input !== "" && matched.length === 0) {
      matched.push({
        title: `→ use as reason: "${input}"`,
        value: `${AUTOCOMPLETE_FREE_TEXT_PREFIX}${input}`,
      });
    }
    return matched;
  };
}

export async function _promptsAutocomplete(
  message: string,
  items: PromptsChoiceItem[],
  allowFreeText: boolean,
  hint: string = "",
  cancelOnEscape: boolean = false,
): Promise<any> {
  _assertLineModeAvailable("autocomplete");
  const result = await _runPrompt({
    type: "autocomplete",
    name: "value",
    message,
    hint: hint || undefined,
    choices: items.map((it) => ({ title: `${color.cyan(it.key)} - ${it.label}`, value: it.key })),
    suggest: _buildSuggest(items, allowFreeText),
  });
  if (isFailure(result)) {
    // When the caller opts in (e.g. a policy approval menu), Escape means
    // "cancel the whole request" rather than "re-prompt". Escalate the
    // cancellation to AgencyCancelledError: __tryCall and the generated
    // function catches both re-throw it, so it unwinds to the REPL exactly
    // like an Esc during the thinking phase. (Ctrl+C still exits the
    // process inside _runPrompt before we get here.)
    if (cancelOnEscape) {
      throw new AgencyCancelledError("cancelled by user");
    }
    return result;
  }

  const raw = String(result.value);
  if (raw.startsWith(AUTOCOMPLETE_FREE_TEXT_PREFIX)) {
    return success(raw.slice(AUTOCOMPLETE_FREE_TEXT_PREFIX.length));
  }
  return success(raw);
}

// `_promptsSelect`'s free-text mechanism is intentionally different
// from `_promptsAutocomplete`'s: `prompts.select` has no `suggest`
// hook to inject a synthetic row's *value*, so we append a marker
// row and then run a follow-up `prompts.text` call when the user
// picks it. The two helpers (`SELECT_FREE_TEXT_SENTINEL` and
// `AUTOCOMPLETE_FREE_TEXT_PREFIX`) are deliberately named differently
// to make the divergence obvious in greps.
const SELECT_FREE_TEXT_SENTINEL = "__FREETEXT__";

export async function _promptsSelect(
  message: string,
  items: PromptsChoiceItem[],
  allowFreeText: boolean,
  hint: string = "",
): Promise<any> {
  _assertLineModeAvailable("select");
  const choices = items.map((it) => ({
    title: `${it.key}  ${it.label}`,
    value: it.key,
  }));
  if (allowFreeText) {
    choices.push({ title: "→ enter free text…", value: SELECT_FREE_TEXT_SENTINEL });
  }
  const result = await _runPrompt({
    type: "select",
    name: "value",
    message,
    hint: hint || undefined,
    choices,
  });
  if (isFailure(result)) return result;
  if (result.value === SELECT_FREE_TEXT_SENTINEL) {
    // Already Result-shaped; cancel of the follow-up cancels the whole pick.
    return _promptsText("free text:", "");
  }
  return success(String(result.value));
}

// Backs the Agency-side `prompt(...)`.
//
// `validate` is forwarded straight to `prompts`. Per the prompts
// docs: return `true` for valid; return a string to reject and show
// the string as the error message. The PFA story: a user binds
// `validate` via `.partial(validate: myValidator)` before handing
// `prompt` to an LLM as a tool, and the LLM cannot override it.
export async function _promptsText(
  message: string,
  initial: string,
  hint: string = "",
  validate: ((value: string) => boolean | string) | null = null,
): Promise<any> {
  // "prompt" (the user-facing Agency primitive) rather than "text"
  // (the internal `_promptsText` name) so thrown error messages
  // match what the user typed: `prompt requires a TTY ...`.
  _assertLineModeAvailable("prompt");
  const result = await _runPrompt({
    type: "text",
    name: "value",
    message,
    initial: initial || undefined,
    hint: hint || undefined,
    validate: validate ?? undefined,
  });
  if (isFailure(result)) return result;
  return success(String(result.value));
}

export async function _promptsConfirm(message: string, initial: boolean): Promise<any> {
  _assertLineModeAvailable("confirm");
  const result = await _runPrompt({
    type: "toggle",
    name: "value",
    message,
    initial,
    active: "yes",
    inactive: "no",
  });
  if (isFailure(result)) return result;
  return success(Boolean(result.value));
}

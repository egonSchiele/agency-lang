import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _internal, _clearHistory, installBottomRegion, type PasteState } from "./cli.js";

const {
  EMPTY_PASTE,
  pasteChar,
  pasteText,
  pasteBackspace,
  pasteJoin,
  classifyPasteKey,
  readMultiline,
  modelsUsedThisTurn,
  fmtModels,
  prettyModel,
  loadHistory,
  saveHistory,
  recordHistoryEntry,
  recordPasteEntry,
  repairSlashHistory,
  summarizeMultiline,
  eraseRows,
  buildFrame,
} = _internal;

/** Replace process.stdout.write with a capturing sink and force isTTY on.
 *  installBottomRegion binds this sink as its realWrite, so every frame is
 *  captured. Returns the buffer and a restore fn. */
function captureStdout(): { captured: string[]; restore: () => void } {
  const captured: string[] = [];
  const originalWrite = process.stdout.write;
  const originalIsTTY = (process.stdout as any).isTTY;
  (process.stdout as any).write = (chunk: any) => { captured.push(String(chunk)); return true; };
  (process.stdout as any).isTTY = true;
  return {
    captured,
    restore: () => {
      (process.stdout as any).write = originalWrite;
      (process.stdout as any).isTTY = originalIsTTY;
    },
  };
}

/** Build a snapshot shaped like `readTokenSnapshot`'s return value from
 *  a `{model: [tokens, cost]}` shorthand. */
function snap(entries: Record<string, [number, number]>) {
  const models: Record<string, { tokens: number; cost: number }> = {};
  for (const [name, [tokens, cost]] of Object.entries(entries)) {
    models[name] = { tokens, cost };
  }
  return { inputTokens: 0, outputTokens: 0, models };
}

// The readMultiline tests spy on process.stdout.write; restore after
// every test so the global spy never leaks into other tests/files.
afterEach(() => {
  vi.restoreAllMocks();
});

/** Feed a string char-by-char through `pasteChar` (what the editor does
 *  for typed input and for a pasted chunk). */
function type(text: string, start: PasteState = EMPTY_PASTE): PasteState {
  let s = start;
  for (const ch of text) s = pasteChar(s, ch);
  return s;
}

describe("/paste buffer ops", () => {
  it("accumulates a single line", () => {
    expect(pasteJoin(type("hello"))).toBe("hello");
  });

  it("treats \\n as a line break (typed Enter or pasted newline)", () => {
    expect(pasteJoin(type("a\nb\nc"))).toBe("a\nb\nc");
  });

  it("normalizes pasted \\r\\n and bare \\r to single newlines", () => {
    // A pasted chunk goes through pasteText (CRLF/CR -> LF), not raw
    // char-by-char, so line endings don't double-break.
    expect(pasteJoin(pasteText(EMPTY_PASTE, "a\r\nb\rc"))).toBe("a\nb\nc");
  });

  it("pasteText appends a multi-line block onto existing input", () => {
    expect(pasteJoin(pasteText(type("start "), "a\nb"))).toBe("start a\nb");
  });

  it("backspace deletes within the current line", () => {
    let s = type("abc");
    s = pasteBackspace(s);
    expect(pasteJoin(s)).toBe("ab");
  });

  it("backspace is a no-op at the start of a line (no merge in v1)", () => {
    let s = type("a\n"); // current line is now empty, "a" committed
    s = pasteBackspace(s);
    expect(pasteJoin(s)).toBe("a\n");
  });

  it("backspace after typing on a later line stays on that line", () => {
    let s = type("a\nbc");
    s = pasteBackspace(s);
    expect(pasteJoin(s)).toBe("a\nb");
  });

  it("empty buffer joins to empty string", () => {
    expect(pasteJoin(EMPTY_PASTE)).toBe("");
  });
});

describe("/paste key classification", () => {
  it("Ctrl+D submits", () => {
    expect(classifyPasteKey(undefined, { name: "d", ctrl: true })).toBe("submit");
  });

  it("Ctrl+C and Esc cancel", () => {
    expect(classifyPasteKey(undefined, { name: "c", ctrl: true })).toBe("cancel");
    expect(classifyPasteKey(undefined, { name: "escape" })).toBe("cancel");
  });

  it("Enter / return insert a newline", () => {
    expect(classifyPasteKey(undefined, { name: "return" })).toBe("newline");
    expect(classifyPasteKey(undefined, { name: "enter" })).toBe("newline");
  });

  it("backspace maps to backspace", () => {
    expect(classifyPasteKey(undefined, { name: "backspace" })).toBe("backspace");
  });

  it("printable keys append themselves", () => {
    expect(classifyPasteKey("a", { name: "a" })).toEqual({ append: "a" });
    expect(classifyPasteKey(" ", { name: "space" })).toEqual({ append: " " });
  });

  it("ignores ctrl/meta chords and unknown keys", () => {
    expect(classifyPasteKey("k", { name: "k", ctrl: true })).toBeNull();
    expect(classifyPasteKey(undefined, { name: "up" })).toBeNull();
  });
});

describe("readMultiline editor (drives the hijacked _ttyWrite)", () => {
  /** Build a fake readline whose `_ttyWrite` slot readMultiline takes
   *  over, and a `send` that replays keystrokes through it. stdout is
   *  silenced so the editor's echo doesn't pollute test output. */
  function fakeReadline(ttyWrite: () => void = () => {}) {
    const closeHandlers: Array<() => void> = [];
    return {
      _ttyWrite: ttyWrite,
      once: (ev: string, h: () => void) => {
        if (ev === "close") closeHandlers.push(h);
      },
      off: (ev: string, h: () => void) => {
        if (ev !== "close") return;
        const i = closeHandlers.indexOf(h);
        if (i >= 0) closeHandlers.splice(i, 1);
      },
      emitClose: () => closeHandlers.slice().forEach((h) => h()),
    };
  }

  function harness() {
    const fakeRl = fakeReadline();
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const promise = readMultiline(fakeRl as never, false);
    const send = (s: unknown, key: Record<string, unknown>) =>
      (fakeRl as { _ttyWrite: (s: unknown, k: unknown) => void })._ttyWrite(s, key);
    return { promise, send, fakeRl, spy };
  }

  it("types two lines and submits on Ctrl+D", async () => {
    const { promise, send } = harness();
    send("a", { name: "a" });
    send("b", { name: "b" });
    send(undefined, { name: "return" });
    send("c", { name: "c" });
    send(undefined, { name: "d", ctrl: true });
    expect(await promise).toBe("ab\nc");
  });

  it("returns null when cancelled with Ctrl+C", async () => {
    const { promise, send } = harness();
    send("x", { name: "x" });
    send(undefined, { name: "c", ctrl: true });
    expect(await promise).toBeNull();
  });

  it("accepts a multi-line paste chunk without premature submit", async () => {
    const { promise, send } = harness();
    // Simulate a paste delivered as one chunk with CRLF endings.
    send("line1\r\nline2\r\nline3", { name: undefined });
    send(undefined, { name: "d", ctrl: true });
    expect(await promise).toBe("line1\nline2\nline3");
  });

  it("restores the previous _ttyWrite on exit", async () => {
    const original = () => {};
    const fakeRl = fakeReadline(original);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const p = readMultiline(fakeRl as never, false);
    (fakeRl._ttyWrite as (s: unknown, k: unknown) => void)(undefined, {
      name: "d",
      ctrl: true,
    });
    await p;
    expect(fakeRl._ttyWrite).toBe(original);
  });

  it("settles (does not hang) if the interface closes mid-edit", async () => {
    const { promise, send, fakeRl } = harness();
    send("partial", { name: undefined });
    // Simulate a stdin EOF / readline close while editing.
    (fakeRl as unknown as { emitClose: () => void }).emitClose();
    expect(await promise).toBe("partial");
  });
});

describe("modelsUsedThisTurn (footer model attribution)", () => {
  it("returns nothing when no model did work this turn", () => {
    const before = snap({ "opus-4.8": [10, 0.01] });
    const after = snap({ "opus-4.8": [10, 0.01] });
    expect(modelsUsedThisTurn(before, after)).toEqual([]);
  });

  it("lists the single model that grew this turn", () => {
    const before = snap({});
    const after = snap({ "opus-4.8": [100, 0.03] });
    expect(modelsUsedThisTurn(before, after)).toEqual(["opus-4.8"]);
  });

  it("orders multiple models by cost spent this turn, descending", () => {
    const before = snap({});
    const after = snap({ "gpt-5-mini": [400, 0.011], "opus-4.8": [800, 0.03] });
    expect(modelsUsedThisTurn(before, after)).toEqual(["opus-4.8", "gpt-5-mini"]);
  });

  it("uses the per-turn delta, not cumulative totals, to order", () => {
    // opus has a bigger cumulative cost, but gpt spent more THIS turn.
    const before = snap({ "opus-4.8": [1000, 0.50], "gpt-5-mini": [0, 0] });
    const after = snap({ "opus-4.8": [1010, 0.505], "gpt-5-mini": [500, 0.40] });
    expect(modelsUsedThisTurn(before, after)).toEqual(["gpt-5-mini", "opus-4.8"]);
  });

  it("excludes a model that was used in a prior turn but not this one", () => {
    const before = snap({ "opus-4.8": [100, 0.03], "gpt-5-mini": [50, 0.005] });
    const after = snap({ "opus-4.8": [100, 0.03], "gpt-5-mini": [80, 0.008] });
    expect(modelsUsedThisTurn(before, after)).toEqual(["gpt-5-mini"]);
  });

  it("breaks cost ties by model name", () => {
    const before = snap({});
    const after = snap({ "model-b": [100, 0.01], "model-a": [100, 0.01] });
    expect(modelsUsedThisTurn(before, after)).toEqual(["model-a", "model-b"]);
  });

  it("includes a model whose cost grew even if its token count didn't", () => {
    const before = snap({ "opus-4.8": [100, 0.01] });
    const after = snap({ "opus-4.8": [100, 0.02] });
    expect(modelsUsedThisTurn(before, after)).toEqual(["opus-4.8"]);
  });
});

describe("fmtModels (footer cap)", () => {
  it("joins up to three models in full", () => {
    expect(fmtModels(["a", "b", "c"])).toBe("a, b, c");
  });

  it("collapses the tail to `+N more` past the cap", () => {
    expect(fmtModels(["a", "b", "c", "d", "e"])).toBe("a, b, c +2 more");
  });

  it("renders a single model plainly", () => {
    expect(fmtModels(["opus-4.8"])).toBe("opus-4.8");
  });

  it("prettifies a local GGUF model name", () => {
    expect(fmtModels(["hf_unsloth_SmolLM2-135M-Instruct.Q4_K_M.gguf"])).toBe(
      "SmolLM2-135M-Instruct",
    );
  });
});

describe("prettyModel", () => {
  it("leaves a hosted model id untouched", () => {
    expect(prettyModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(prettyModel("gpt-5-mini")).toBe("gpt-5-mini");
  });

  it("reduces a node-llama-cpp download filename to the model name", () => {
    expect(prettyModel("hf_unsloth_SmolLM2-135M-Instruct.Q4_K_M.gguf")).toBe(
      "SmolLM2-135M-Instruct",
    );
  });

  it("strips a full path and the .gguf extension", () => {
    expect(prettyModel("/home/u/.agency-agent/models/hf_mistralai_Devstral-Small-2507.Q4_K_M.gguf")).toBe(
      "Devstral-Small-2507",
    );
  });

  it("keeps a non-quant version segment (only strips real quants)", () => {
    expect(prettyModel("hf_nomic-ai_nomic-embed-text-v1.5.Q4_K_M.gguf")).toBe(
      "nomic-embed-text-v1.5",
    );
  });

  it("handles a plain local .gguf path with no hf_ prefix or quant", () => {
    expect(prettyModel("/models/my-custom-model.gguf")).toBe("my-custom-model");
  });
});

describe("history persistence (JSON)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hist-")));
    file = path.join(dir, "history.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("round-trips plain entries, tolerating a raw multi-line string", () => {
    // saveHistory takes readline order (newest-first).
    const newestFirst = ["third\nwith newline", "second", "first"];
    saveHistory(file, newestFirst, 100);
    expect(loadHistory(file, 100)).toEqual({ entries: newestFirst, expansions: {} });
    // The on-disk form is JSON (so a newline can't corrupt it).
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk).toEqual(["first", "second", "third\nwith newline"]); // oldest-first
  });

  it("round-trips a collapsed paste as { preview, text }", () => {
    const buffer = "write\nme\na\npoem!";
    const preview = summarizeMultiline(buffer);
    saveHistory(file, [preview, "before"], 100, { [preview]: buffer });
    // readline gets the one-line preview; the full text rides back in expansions.
    expect(loadHistory(file, 100)).toEqual({
      entries: [preview, "before"],
      expansions: { [preview]: buffer },
    });
    // On disk the paste is an object, so its newline can't split into rows.
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk).toEqual(["before", { preview, text: buffer }]); // oldest-first
  });

  it("returns empties for a missing or non-array/corrupt file", () => {
    const empty = { entries: [], expansions: {} };
    expect(loadHistory(path.join(dir, "nope.json"), 100)).toEqual(empty);
    fs.writeFileSync(file, "{not json");
    expect(loadHistory(file, 100)).toEqual(empty);
    fs.writeFileSync(file, JSON.stringify({ not: "an array" }));
    expect(loadHistory(file, 100)).toEqual(empty);
  });

  it("caps to max, keeping the newest", () => {
    saveHistory(file, ["e", "d", "c", "b", "a"], 3); // newest-first
    // Stored newest 3 (e, d, c); loaded back newest-first.
    expect(loadHistory(file, 3)).toEqual({ entries: ["e", "d", "c"], expansions: {} });
  });
});

describe("summarizeMultiline", () => {
  it("renders first line + line count", () => {
    expect(summarizeMultiline("write\nme\na\npoem!")).toBe("write … (4 lines)");
  });
  it("counts a trailing blank line", () => {
    expect(summarizeMultiline("a\nb\n")).toBe("a … (3 lines)");
  });
});

describe("repairSlashHistory", () => {
  it("replaces the leaked `/` + filter entries with the chosen command", () => {
    // Trigger fired with ["older"] present, so mark = 1. Then "/" and the
    // leaked "pa" got committed (newest-first: ["pa", "/", "older"]).
    const history = ["pa", "/", "older"];
    repairSlashHistory(history, 1, "/paste");
    expect(history).toEqual(["/paste", "older"]);
  });

  it("drops the junk even when nothing was picked (cancelled palette)", () => {
    const history = ["pa", "/", "older"];
    repairSlashHistory(history, 1, null);
    expect(history).toEqual(["older"]);
  });

  it("dedupes an earlier copy of the chosen command", () => {
    // mark=2: ["/paste", "older"] predate the trigger; "pa" + "/" were added
    // after. The old "/paste" survives the rollback, then gets moved to front.
    const history = ["pa", "/", "/paste", "older"];
    repairSlashHistory(history, 2, "/paste");
    expect(history).toEqual(["/paste", "older"]);
  });

  it("skips rollback when no trigger fired (mark = -1)", () => {
    const history = ["typed", "older"];
    repairSlashHistory(history, -1, "/cost");
    expect(history).toEqual(["/cost", "typed", "older"]);
  });
});

describe("recordPasteEntry", () => {
  it("stores a multi-line paste as a one-line preview + expansion", () => {
    const history = ["/paste", "older"];
    const expansions: Record<string, string> = {};
    const buffer = "write\nme\na\npoem!";
    recordPasteEntry(history, buffer, expansions);
    const preview = summarizeMultiline(buffer);
    // readline only ever holds the one-line preview...
    expect(history).toEqual([preview, "older"]);
    // ...with the full text recoverable on submit.
    expect(expansions).toEqual({ [preview]: buffer });
  });

  it("stores a single-line paste verbatim, no expansion", () => {
    const history = ["/paste", "older"];
    const expansions: Record<string, string> = {};
    recordPasteEntry(history, "just one line", expansions);
    expect(history).toEqual(["just one line", "older"]);
    expect(expansions).toEqual({});
  });
});

describe("recordHistoryEntry", () => {
  it("makes the entry most-recent and drops the command that added it", () => {
    const history = ["/paste", "older"]; // readline added "/paste"
    recordHistoryEntry(history, "line one\nline two", "/paste");
    expect(history).toEqual(["line one\nline two", "older"]);
  });

  it("drops the command even when readline stored it with surrounding whitespace", () => {
    const history = ["/paste   ", "older"]; // raw typed line, untrimmed
    recordHistoryEntry(history, "pasted", "/paste");
    expect(history).toEqual(["pasted", "older"]);
  });

  it("removes an earlier duplicate of the same entry", () => {
    const history = ["b", "pasted", "a"];
    recordHistoryEntry(history, "pasted", "/paste");
    expect(history).toEqual(["pasted", "b", "a"]);
  });

  it("is a no-op-safe prepend when the command isn't present", () => {
    const history = ["a"];
    recordHistoryEntry(history, "x", "/paste");
    expect(history).toEqual(["x", "a"]);
  });
});

describe("_clearHistory", () => {
  let dir: string;
  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clearhist-"))); });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__agencyClearHistory;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("invokes the installed __agencyClearHistory hook (live recall)", () => {
    const spy = vi.fn();
    (globalThis as Record<string, unknown>).__agencyClearHistory = spy;
    _clearHistory("");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("is a no-op when no REPL hook is installed", () => {
    delete (globalThis as Record<string, unknown>).__agencyClearHistory;
    expect(() => _clearHistory("")).not.toThrow();
  });

  it("clears the persisted file at the supplied path", () => {
    const file = path.join(dir, "history.json");
    saveHistory(file, ["c", "b", "a"], 100);
    expect(loadHistory(file, 100).entries).toEqual(["c", "b", "a"]);
    _clearHistory(file);
    expect(loadHistory(file, 100).entries).toEqual([]);
  });
});

describe("eraseRows", () => {
  it("returns nothing when there is no footer yet", () => {
    expect(eraseRows(0)).toBe("");
  });
  it("clears a single row with CR + clear-down, no cursor move", () => {
    expect(eraseRows(1)).toBe("\r\x1b[0J");
  });
  it("moves up rows-1 before clearing for a multi-row footer", () => {
    expect(eraseRows(3)).toBe("\x1b[2A\r\x1b[0J");
  });
});

describe("buildFrame", () => {
  it("first frame of a 1-row footer: sync brackets + footer, no erase", () => {
    const result = buildFrame({ above: null, footerLines: ["FOOTER"], prevRows: 0, columns: 80, cursor: "keep" });
    expect(result.rows).toBe(1);
    expect(result.seq).toBe("\x1b[?2026h" + "FOOTER" + "\x1b[?2026l");
  });
  it("erases the previous footer, then emits `above`, then redraws", () => {
    const result = buildFrame({ above: "trace\n", footerLines: ["A", "B"], prevRows: 3, columns: 80, cursor: "keep" });
    expect(result.seq).toBe("\x1b[?2026h" + "\x1b[2A\r\x1b[0J" + "trace\n" + "A\nB" + "\x1b[?2026l");
    expect(result.rows).toBe(2);
  });
  it("appends a newline to `above` when missing so the footer starts fresh", () => {
    const result = buildFrame({ above: "x", footerLines: ["F"], prevRows: 1, columns: 80, cursor: "keep" });
    expect(result.seq).toContain("x\n");
  });
  it("emits hide/show cursor when asked", () => {
    expect(buildFrame({ above: null, footerLines: ["F"], prevRows: 0, columns: 80, cursor: "hide" }).seq).toContain("\x1b[?25l");
    expect(buildFrame({ above: null, footerLines: [], prevRows: 1, columns: 80, cursor: "show" }).seq).toContain("\x1b[?25h");
  });
  it("counts wrapped rows for an over-wide footer line", () => {
    const wide = "w".repeat(50);
    expect(buildFrame({ above: null, footerLines: [wide], prevRows: 0, columns: 20, cursor: "keep" }).rows).toBeGreaterThan(1);
  });
});

describe("installBottomRegion", () => {
  it("no-ops on non-TTY (passes writes straight through)", () => {
    const cap = captureStdout();
    const region = installBottomRegion(() => ["footer"], false);
    process.stdout.write("hello");
    region.teardown();
    cap.restore();
    expect(cap.captured).toEqual(["hello"]);
  });
  it("redraws the footer above an outside write", () => {
    const cap = captureStdout();
    const region = installBottomRegion(() => ["FOOTER"], true);
    cap.captured.length = 0; // drop the initial paint
    process.stdout.write("trace line\n");
    region.teardown();
    cap.restore();
    const text = cap.captured.join("");
    expect(text).toContain("trace line\n");
    expect(text.indexOf("trace line")).toBeLessThan(text.lastIndexOf("FOOTER"));
  });
});

describe("startSpinner coexists with outside writes", () => {
  it("redraws the Thinking line after an outside write", () => {
    const cap = captureStdout();
    const stop = _internal.startSpinner(true);
    cap.captured.length = 0;
    process.stdout.write("tool output\n");
    stop();
    cap.restore();
    const text = cap.captured.join("");
    expect(text).toContain("tool output\n");
    expect(text.indexOf("tool output")).toBeLessThan(text.lastIndexOf("Thinking"));
  });
});

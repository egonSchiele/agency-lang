import { describe, it, expect, afterEach, beforeEach } from "vitest";
import prompts from "prompts";
import {
  _promptsAutocomplete,
  _promptsSelect,
  _promptsText,
  _promptsConfirm,
  __suggestForTest,
} from "./prompts.js";

// Spoof `process.stdout.isTTY`, which is the only thing
// `_assertLineModeAvailable` reads, so the tests run the same whether
// or not vitest is attached to a real terminal. Answers come from
// `prompts.inject`, so no keyboard is needed either.
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

describe("_promptsAutocomplete bridge guards", () => {
  afterEach(() => {
    restoreTty();
  });

  it("throws when stdout is not a TTY", async () => {
    spoofTty(false);
    await expect(_promptsAutocomplete("pick", [{ key: "a", label: "A" }], false)).rejects.toThrow(
      /requires a TTY/,
    );
  });
});

describe("_promptsAutocomplete happy path", () => {
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
    const result = await _promptsAutocomplete("pick", [{ key: "a", label: "Approve" }], false);
    expect(result.success).toBe(false);
    expect(result.error).toBe("cancelled");
  });

  it("decodes the __FREETEXT__: prefix on resolve", async () => {
    prompts.inject(["__FREETEXT__:please don't delete that"]);
    const result = await _promptsAutocomplete("pick", [{ key: "a", label: "Approve" }], true);
    expect(result.success).toBe(true);
    expect(result.value).toBe("please don't delete that");
  });

  it("suggest() matches by key substring (case-insensitive), ignores label", async () => {
    // Key-only matching is intentional: policy interrupt labels
    // contain "approve" / "reject" / "always", so a label-substring
    // match would never narrow anything (every label contains "r"
    // and "a"). See _buildSuggest in prompts.ts for rationale.
    const items = [
      { key: "a", label: "Approve once" },
      { key: "r", label: "Reject once" },
      { key: "aa", label: "Approve always" },
      { key: "ap", label: "Approve always here" },
    ];

    // `r` matches only the row whose key contains "r".
    expect((await __suggestForTest("r", items, false)).map((m) => m.value)).toEqual(["r"]);

    // `a` matches every key containing "a" (case-insensitive).
    expect((await __suggestForTest("A", items, false)).map((m) => m.value)).toEqual([
      "a",
      "aa",
      "ap",
    ]);

    // Pure-label substring does NOT match — "App" would match
    // "Approve" if we were filtering by label, but we're not.
    expect((await __suggestForTest("App", items, false)).map((m) => m.value)).toEqual([]);
  });

  it("suggest() appends synthetic free-text row only when allowFreeText && input && no real match", async () => {
    const noMatch = await __suggestForTest("xyz", [{ key: "a", label: "Approve" }], true);
    expect(noMatch).toHaveLength(1);
    expect(noMatch[0].value).toBe("__FREETEXT__:xyz");
    expect(noMatch[0].title).toContain("→");
    expect(noMatch[0].title).toContain("xyz");

    // A typed key prefix that matches an existing key returns the
    // real item (no synthetic row appended).
    const withMatch = await __suggestForTest("a", [{ key: "a", label: "Approve" }], true);
    expect(withMatch).toHaveLength(1);
    expect(withMatch[0].value).toBe("a");

    const empty = await __suggestForTest("", [{ key: "a", label: "A" }], true);
    expect(empty.some((m) => String(m.value).startsWith("__FREETEXT__"))).toBe(false);

    const off = await __suggestForTest("xyz", [{ key: "a", label: "A" }], false);
    expect(off.some((m) => String(m.value).startsWith("__FREETEXT__"))).toBe(false);
  });
});

describe("_promptsSelect", () => {
  afterEach(() => restoreTty());

  it("throws on non-TTY", async () => {
    spoofTty(false);
    await expect(_promptsSelect("pick", [{ key: "a", label: "A" }], false)).rejects.toThrow(
      /requires a TTY/,
    );
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
    const result = await _promptsSelect("pick", [{ key: "a", label: "A" }], false);
    expect(result.success).toBe(false);
  });

  it("with allowFreeText=true, runs a follow-up text prompt when free-text sentinel is picked", async () => {
    spoofTty(true);
    // Queue two answers: the sentinel pick, then the typed text.
    prompts.inject(["__FREETEXT__", "my custom reason"]);
    const result = await _promptsSelect("pick", [{ key: "a", label: "Approve" }], true);
    expect(result.success).toBe(true);
    expect(result.value).toBe("my custom reason");
  });

  it("with allowFreeText=true, ignores the follow-up when a real key is picked", async () => {
    spoofTty(true);
    prompts.inject(["a"]);
    const result = await _promptsSelect("pick", [{ key: "a", label: "Approve" }], true);
    expect(result.success).toBe(true);
    expect(result.value).toBe("a");
  });
});

describe("_promptsText", () => {
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

describe("_promptsConfirm", () => {
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

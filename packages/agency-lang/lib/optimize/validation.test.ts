import { describe, expect, it } from "vitest";

import { validateMutationPrompt, validateOptimizedStringValue } from "./validation.js";

describe("validateOptimizedStringValue", () => {
  it("accepts an unchanged interpolation placeholder", () => {
    expect(validateOptimizedStringValue("hello ${name}", "hi ${name}")).toEqual({ ok: true });
  });

  it("accepts reordered placeholders when the multiset is equal", () => {
    expect(validateOptimizedStringValue("${a} then ${b}", "${b} after ${a}")).toEqual({ ok: true });
  });

  it("requires duplicate placeholders to preserve multiplicity", () => {
    expect(validateOptimizedStringValue("${x} ${x}", "${x} and ${x}")).toEqual({ ok: true });
    expect(validateOptimizedStringValue("${x} ${x}", "${x}")).toMatchObject({ ok: false });
  });

  it("rejects a missing placeholder", () => {
    expect(validateOptimizedStringValue("hello ${name}", "hi there")).toMatchObject({ ok: false });
  });

  it("rejects an added placeholder", () => {
    expect(validateOptimizedStringValue("hello ${name}", "hi ${name} ${extra}")).toMatchObject({ ok: false });
  });

  it("compares placeholders by canonical rendered expression", () => {
    expect(validateOptimizedStringValue("call ${foo(1,2)}", "ring ${foo(1, 2)}")).toEqual({ ok: true });
  });

  it("rejects an empty replacement value", () => {
    expect(validateOptimizedStringValue("hello", "")).toMatchObject({ ok: false });
  });
});

describe("validateMutationPrompt", () => {
  it("accepts a prompt that preserves the current interpolation multiset", () => {
    expect(validateMutationPrompt("hello ${name}", "hi ${name}")).toEqual({ ok: true });
  });

  it("rejects a prompt that drops an interpolation", () => {
    expect(validateMutationPrompt("hello ${name}", "hi there")).toMatchObject({ ok: false });
  });

  it("rejects a prompt that adds an interpolation", () => {
    expect(validateMutationPrompt("hello ${name}", "hi ${name} ${extra}")).toMatchObject({ ok: false });
  });

  it("compares duplicate interpolations as a multiset", () => {
    expect(validateMutationPrompt("${x} ${x}", "${x}")).toMatchObject({ ok: false });
  });

  it("rejects malformed interpolation syntax", () => {
    expect(validateMutationPrompt("${x}", "${}")).toMatchObject({ ok: false });
  });
});

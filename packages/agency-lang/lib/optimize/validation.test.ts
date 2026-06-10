import { describe, expect, it } from "vitest";

import { validateMutationPrompt } from "./validation.js";

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

import { describe, expect, it } from "vitest";

import { compareInterpolations, interpolationsOf, parseReplacementText } from "./validation.js";

function interpolations(text: string): string[] {
  const parsed = parseReplacementText(text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return interpolationsOf(parsed.segments);
}

describe("parseReplacementText", () => {
  it("reads plain text with quotes, backslashes, and newlines as text", () => {
    const parsed = parseReplacementText('Say "hi"\\nthen stop.\nDone');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.segments).toEqual([{ type: "text", value: 'Say "hi"\\nthen stop.\nDone' }]);
  });

  it("reads every ${...} as an interpolation", () => {
    expect(interpolations("Hello ${name}, you are ${user.age}")).toEqual(["name", "user.age"]);
  });

  it("keeps string quotes inside an interpolation, so a literal argument stays distinct from a variable", () => {
    expect(interpolations('${format("x")} ${format(x)}')).toEqual(['format("x")', "format(x)"]);
  });

  it("rejects a ${...} that does not hold an expression", () => {
    const parsed = parseReplacementText("use `${...}` to interpolate");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("placeholder");
  });

  it("rejects an empty replacement", () => {
    expect(parseReplacementText("")).toMatchObject({ ok: false });
  });
});

describe("compareInterpolations", () => {
  it("accepts the same placeholders in any order", () => {
    expect(compareInterpolations(interpolations("${a} ${b}"), interpolations("${b} ${a}"))).toEqual(
      { ok: true },
    );
  });

  it("requires duplicates to keep their multiplicity", () => {
    expect(
      compareInterpolations(interpolations("${x} ${x}"), interpolations("${x}")),
    ).toMatchObject({ ok: false, reason: "you removed ${x} from the prompt" });
  });

  it("rejects a missing placeholder and names it", () => {
    expect(compareInterpolations(interpolations("hello ${name}"), interpolations("hi"))).toEqual({
      ok: false,
      reason: "you removed ${name} from the prompt",
    });
  });

  it("rejects an added placeholder", () => {
    expect(
      compareInterpolations(interpolations("hello ${name}"), interpolations("hi ${name} ${extra}")),
    ).toEqual({ ok: false, reason: "you added an interpolation to the prompt" });
  });
});

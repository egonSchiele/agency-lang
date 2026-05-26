import { describe, expect, it } from "vitest";
import { parseAgency } from "../../parser.js";
import { generateTypeScript } from "../typescriptGenerator.js";

/**
 * Code-gen regressions for pipe-stage receiver lowering.
 *
 * These are NOT runtime tests — the runtime values for the shapes
 * below happen to be identical whether the optional flag /
 * await-paren wrapping is preserved or dropped (the broken codegen
 * only crashes on null receivers, which throw either way). So we
 * assert directly against the generated TypeScript string to lock in
 * that the codegen contains the expected operators.
 *
 * See `tests/agency/result/pipe-receiver-precedence.agency` for the
 * companion end-to-end runtime fixture covering the awaited-base case.
 */
function compile(src: string): string {
  const parsed = parseAgency(src, {}, false);
  if (!parsed.success) {
    throw new Error(`parse failed: ${parsed.message}`);
  }
  return generateTypeScript(parsed.result, undefined, undefined, "test.agency");
}

describe("pipe receiver codegen", () => {
  it("preserves optional chaining (`?.`) on the receiver", () => {
    const out = compile(`
      def triple(x: number): Result { return success(x * 3) }
      def makeC(): any { return { inner: { m: triple } } }
      node main() {
        let c = makeC()
        let r = success(5) |> c?.inner.m
        return r.value
      }
    `);
    // Receiver was `c?.inner.m`; pipe slices off `.m` and lowers the
    // remaining `c?.inner` chain. The `?.` must survive.
    expect(out).toMatch(/c\?\.inner/);
  });

  it("paren-wraps an awaited functionCall base before applying intermediate chain", () => {
    const out = compile(`
      def triple(x: number): Result { return success(x * 3) }
      def makeC(): any { return { inner: { m: triple } } }
      node main() {
        let r = success(5) |> makeC().inner.m
        return r.value
      }
    `);
    // Receiver chain is `.inner.m`; we slice off `.m`. The remaining
    // `.inner` access must bind to `(await makeC())`, not the
    // unresolved Promise. With the fix we emit
    // `(await await __call(makeC, ...)).inner` — the extra wrapping
    // paren is what makes `.inner` apply to the awaited value
    // instead of to the call expression. Pre-fix codegen produced
    // `await __call(makeC, ...).inner` (single closing paren),
    // which would bind `.inner` to the unresolved Promise.
    expect(out).toMatch(/\)\)\.inner/);
  });
});

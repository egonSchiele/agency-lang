import { agency } from "agency-lang/runtime";

export const calls = { s1: 0, s2: 0, s3: 0, s4: 0 };

// Verifies the halt contract through a real Agency execution frame:
// once `s.halt(value)` fires inside a step body, every subsequent
// `s.step(...)` short-circuits without invoking its body, and
// `withResumableScope` returns the halt value (not the body's return
// value). Catches regressions where the runner halted flag gets
// reset between steps or the wrapper accidentally returns the body's
// trailing value.
export async function processWithHalt(seed) {
  return agency.withResumableScope({ name: "haltDemo" }, async (s) => {
    await s.step(() => {
      calls.s1 += 1;
    });

    await s.step(() => {
      calls.s2 += 1;
      s.halt({ origin: "halt", seed });
    });

    // The following two steps must not execute their callbacks; the
    // counters confirm.
    await s.step(() => {
      calls.s3 += 1;
    });
    await s.step(() => {
      calls.s4 += 1;
    });

    // The body's return value is irrelevant — halt takes precedence.
    return { ignored: true };
  });
}

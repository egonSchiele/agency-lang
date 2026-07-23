/**
 * Deciding whether a `.test.json` with `expectedCompileError` passed.
 *
 * Kept free of I/O so every branch is testable without spawning a
 * compiler or committing a fixture that fails on purpose. The spawning
 * lives in lib/cli/test.ts; this file only judges what came back.
 */
import { formatDiff } from "@/utils/diff.js";

/** What a child `agency compile` produced. `exitCode` is null when the
 *  child was killed rather than exiting on its own. `output` is stderr
 *  and stdout concatenated: the compiler's failure paths do not agree on
 *  a stream (parse and typecheck errors go to stderr, an uncaught codegen
 *  throw is reported by node itself), and a fixture author should not
 *  have to know which one their diagnostic takes. */
export type CompileAttempt = {
  exitCode: number | null;
  output: string;
  killedBy?: "timeout" | "abort";
};

export type CompileVerdict = { ok: true } | { ok: false; reason: string };

export function judgeCompileAttempt(
  expected: string,
  attempt: CompileAttempt,
): CompileVerdict {
  // A killed child says nothing about whether the file compiles, so this
  // is reported as its own outcome rather than as a mismatch — even when
  // the expected text appears in what it printed before dying.
  if (attempt.killedBy === "timeout") {
    return {
      ok: false,
      reason: "The compile timed out, so it never reported success or failure.",
    };
  }
  if (attempt.killedBy === "abort") {
    return {
      ok: false,
      reason: "The compile was aborted with the suite before it finished.",
    };
  }
  if (attempt.exitCode === 0) {
    return {
      ok: false,
      reason: `The file compiled, but was expected to fail with: ${expected}`,
    };
  }
  if (!attempt.output.includes(expected)) {
    return {
      ok: false,
      reason:
        `The compile failed, but not with the expected message.\n` +
        formatDiff(expected, attempt.output),
    };
  }
  return { ok: true };
}

/**
 * Name the first field that cannot be combined with
 * `expectedCompileError`, or null when there is none. Nothing runs in
 * this mode, so mocks and cases are not merely unused — they mean the
 * author expected something this mode does not do, and a silent ignore
 * would hide that.
 */
export function findIncompatibleField(tests: {
  tests?: unknown[];
  fetchMocks?: unknown[];
  llmMocks?: unknown;
}): string | null {
  if (Array.isArray(tests.tests) && tests.tests.length > 0) return "tests";
  if (tests.fetchMocks !== undefined) return "fetchMocks";
  // llmMocks is a per-case field today, but a file-level one is a natural
  // thing to write; catching it here keeps this mode's "rejected, not
  // ignored" promise honest.
  if (tests.llmMocks !== undefined) return "llmMocks";
  return null;
}

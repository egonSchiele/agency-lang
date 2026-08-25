// The one grading library for typescript-review tests. Each test's graders.ts
// is a one-liner over these; the judge prompts live here so they improve for
// every test at once. Ground truth is the author's written `reason` for what
// is wrong with the planted source (harvested tests will carry the real
// review comment and rewrite diff as that reason).
import * as fs from "fs";
import * as path from "path";

import { binary, grader, type Grader, type Test } from "agency-lang/eval";

/** Mirrors `TsReviewEvalInput` in stdlib/agents/typescript/review.agency. */
type TsReviewInput = { assignment: string; sourceFile: string };
type TsReviewGrader = Grader<TsReviewInput>;

type Feedback = { error: boolean; feedback: string };
const findings = (output: unknown): Feedback[] => (Array.isArray(output) ? output : []);
const errors = (output: unknown) => findings(output).filter((item) => item?.error === true);
const advisories = (output: unknown) => findings(output).filter((item) => item?.error !== true);
const text = (items: Feedback[]) => items.map((item) => item.feedback);

/** The reviewed source, read from the test's seeded workdir. Fixture paths
 *  are authored, but a path that escapes the workdir reads as missing. */
function sourceOf(workdir: string, test: Test<TsReviewInput>): string {
  if (!test.input?.sourceFile) return "";
  const root = path.resolve(workdir);
  const resolved = path.resolve(root, test.input.sourceFile);
  if (!resolved.startsWith(root + path.sep)) return "";
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return "";
  }
}

const reviewed = (source: string) => `The TypeScript source that was reviewed:\n\n${source}`;

function rejects(): TsReviewGrader {
  return grader(
    ({ output }) =>
      binary(
        errors(output).length > 0,
        `${errors(output).length} error finding(s), ${findings(output).length} total`,
      ),
    { name: "rejects" },
  );
}

/** Advisory findings should be worth reading: true of this code and genuinely
 *  useful for this assignment. A review with no advisory findings passes
 *  vacuously; advice is welcome, not demanded. */
function advisoryUseful(): TsReviewGrader {
  return grader<TsReviewInput>(
    ({ output, workdir, test, judges }) => {
      const advice = advisories(output);
      if (advice.length === 0) {
        return binary(true, "no advisory findings");
      }
      return judges.rubric({
        standard:
          "The work is the ADVISORY findings (not errors) of a readability and architecture review of TypeScript code. Each finding is a useful, accurate pointer for this code: true of the code, and a real improvement for the assignment it was written for. Padding (generic advice that fits any code) and suggestions that are not true of this code lower the score in proportion to how many findings are affected.",
        context: `${reviewed(sourceOf(workdir, test))}\n\nThe assignment the code was written for:\n\n${test.input?.assignment ?? ""}`,
        output: text(advice),
      });
    },
    { name: "advisory-useful" },
  );
}

/** Graders for a planted-flaw test: the author's `reason` is the ground
 *  truth for what is wrong with the source. */
export function plantedFlawGraders(args: { reason: string }): TsReviewGrader[] {
  return [
    rejects(),
    grader<TsReviewInput>(
      ({ output, judges }) =>
        judges.rubric({
          standard:
            "The work is the ERROR findings of a code review. Some finding identifies the planted problem described in the context. Wording may differ; what matters is that a finding points at that problem or its behavior.",
          context: `The planted problem: ${args.reason}`,
          output: text(errors(output)),
        }),
      { name: "names-the-flaw" },
    ),
    grader<TsReviewInput>(
      ({ output, workdir, test, judges }) =>
        judges.rubric({
          standard:
            "The work is the ERROR findings of a code review. Every finding is a real problem with the source: the planted problem, or something genuinely wrong. A finding that objects to reasonable code, or to something a compiler, linter, or formatter would already catch, is invented and lowers the score in proportion.",
          context: `The only planted problem: ${args.reason}\n\n${reviewed(sourceOf(workdir, test))}`,
          output: text(errors(output)),
        }),
      { name: "no-invented-errors" },
    ),
    advisoryUseful(),
  ];
}

/** Graders for a clean test: well-written code the reviewer must not reject. */
export function cleanGraders(): TsReviewGrader[] {
  return [
    grader(
      ({ output }) =>
        binary(
          errors(output).length === 0,
          `${errors(output).length} error finding(s) on clean code: ${text(errors(output)).join(" | ")}`,
        ),
      { name: "rejects-nothing" },
    ),
    advisoryUseful(),
  ];
}

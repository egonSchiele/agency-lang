// The holdout checks both branches and that the message survives. This
// judge checks how the Result was read.
import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  idiomJudge({
    name: "narrows-results",
    standard: `
    Here is a loop that reads a Result and passes a failure on unchanged:

    const parsed = parseAmount(line)
    if (parsed is failure(e)) {
      return parsed
    }
    if (parsed is success(n)) {
      sum = sum + n
    }

    \`is success(n)\` and \`is failure(e)\` narrow the Result and bind the value or the error.

    Make sure that:
    1. the Result is read with \`is success\`/\`is failure\`, \`match\`, or \`try\`, not by reaching into \`.value\` or \`.success\` directly.
    2. a failed parse is returned as the failure it came from, not replaced with a new failure, a default number, or \`catch 0\`.

    All two of these points count equally towards the final score. If the file is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: `import { parseAmount } from "./amounts.agency"

export def total(lines: string[]): Result<number> {
  let sum = 0
  for (line in lines) {
    const parsed = parseAmount(line)
    if (parsed is failure(e)) {
      return parsed
    }
    if (parsed is success(n)) {
      sum = sum + n
    }
  }
  return success(sum)
}`,
  }),
];

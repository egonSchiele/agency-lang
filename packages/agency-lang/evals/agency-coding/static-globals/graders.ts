import { formatted } from "../lib/formatted.js";
import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  formatted(),
  idiomJudge({
    name: "static-for-fixed-values",
    standard: `
    Here are the two kinds of global variable in Agency:

    static const rates: any = { USD: 1, EUR: 0.9, GBP: 0.8 }
    let history: string[] = []

    A global is reinitialized for every run of the program. A \`static const\` is initialized once and shared by every run, and it is deeply immutable, so it fits a value that never changes: a table, a prompt, a configuration. A value that runs add to, like the history, must stay a plain global.

    Make sure that:
    1. the rate table is declared \`static const\` at module level.
    2. the history is a plain \`let\` global, not static. Marking it static scores 0 on this point, because a static value cannot be pushed to.
    3. neither global is exported. Module state is reached through the exported functions.

    All three of these points count equally towards the final score. If the file is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: `import { keys } from "std::object"

static const rates: any = { USD: 1, EUR: 0.9, GBP: 0.8 }
let history: string[] = []

export def convert(amount: number, from: string, to: string): number {
  const result = amount / rates[from] * rates[to]
  history.push("\${amount} \${from} -> \${result} \${to}")
  return result
}

export def conversions(): string[] {
  return history
}

export def currencies(): string[] {
  return keys(rates)
}`,
  }),
];

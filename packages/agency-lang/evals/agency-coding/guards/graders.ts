import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  idiomJudge({
    name: "time-guard-per-call",
    standard: `
    Here is a call capped with a guard:

    const result = guard(label: "summary", time: 500ms) {
      return summarize(doc)
    }
    return match(result) {
      success(v) => v
      failure(e) => "timed out"
    }

    \`guard\` limits the time or cost of the block and returns a Result: the block's value on success, a failure when the budget trips. Because the budget is per call, one slow document fails alone.

    Make sure that:
    1. each summarize call is inside its own \`guard\` with \`time: 500ms\`, or an equal number of milliseconds, not one guard around the whole loop.
    2. the guard's Result is read with \`match\` or \`is success\`/\`is failure\`, and the failure branch yields "timed out".
    3. no hand-rolled timing with \`now()\` or \`sleep\` stands in for the guard.

    All three of these points count equally towards the final score. If the file is not valid Agency, meaning the parser would refuse it, the score is 0.
    
    Note that the time param takes milliseconds. 500 would be 500ms. Bonus points if the agent uses "500ms" or "0.5s" instead of just 500. This would show it understands time literal units in Agency. 
    Another bonus point if the agent parallelizes the calls using fork.
    `,
    reference: `import { summarize } from "./summarizer.agency"

def summarizeOne(doc: string): string {
  const result = guard(label: "summary", time: 500ms) {
    return summarize(doc)
  }
  return match(result) {
    success(v) => v
    failure(e) => "timed out"
  }
}

export def summarizeAll(docs: string[]): string[] {
  return [summarizeOne(d) for d in docs]
}`,
  }),
];

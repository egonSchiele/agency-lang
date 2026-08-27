import { formatted } from "../lib/formatted.js";
import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  formatted(),
  idiomJudge({
    name: "handler-syntax-and-chain",
    standard: `
    
    Here's an example of handler syntax:

    handle {
      foo()
    } with (data) {
     return match (data.effect) {
       "foo::bar" => approve()
       _ => pass()
     }
    }

    And here's how to raise an interrupt:

    raise notes::archive("...", { count: count })

    \`notes::archive\` is the effect name, and the second argument is optional additional data. The handler receives the effect name and data in a parameter named \`data\`, which has a field \`effect\` for the effect name and a field \`data\` for the additional data.

    Make sure that:
    1. the interrupt is raised with the statement form and an effect name, as shown above.
    2. the handler uses a match on \`data.effect\` to decide how to respond, returning \`approve()\`, \`reject()\`, or \`pass()\` as appropriate.
    3. it is clear the LLM understands that for nested handlers, BOTH handlers run, not just the nearest one, and that a reject from any handler in the chain wins. A comment claiming the inner approval settles it,or that the outer handler never sees the interrupt, should score a zero for (3).

    All three of these points count equally towards the final score.`,
    reference: `export def archiveNotes(count: number): Result<string> raises <notes::archive> {
  raise notes::archive("Archive \${count} notes?", { count: count })
  return success("archived \${count}")
}

/** For count 11: the interrupt reaches BOTH handlers, not just the nearest.
  The inner handler approves, the outer handler rejects, and a reject from
  any handler in the chain wins, so archiveNotes returns a failure and
  runArchive returns "rejected". */
export def runArchive(count: number): string {
  let outcome = ""
  handle {
    handle {
      const result = archiveNotes(count)
      outcome = match(result) {
        success(v) => "archived"
        failure(e) => "rejected"
      }
    } with (data) {
      return match(data.effect) {
        "notes::archive" => approve()
        _ => pass()
      }
    }
  } with (data) {
    return match(data.effect) {
      "notes::archive" if (data.data.count > 10) => reject()
      _ => pass()
    }
  }
  return outcome
}`,
  }),
];

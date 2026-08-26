import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  idiomJudge({
    name: "handler-syntax-and-chain",
    standard: `Four things, each worth a quarter. (1) The interrupt is raised with the
statement form and an effect name, \`raise notes::archive("...", { count: count })\`,
and archiveNotes declares it with \`raises <notes::archive>\`. (2) Handlers use the
real syntax: \`handle { ... } with (data) { ... }\`, the outer handle block wraps the
inner one, and each handler returns its verdict with approve(), reject(), or pass()
(pass for "no opinion"); \`return reject()\` counts, and reject() takes no
message. (3) Both handlers decide with a match on data.effect,
and the outer one reads the count from the interrupt's data field (for a
handler parameter named intr, that is intr.data.count).
(4) The doc comment above runArchive states that for a count of 11 BOTH handlers
run (an interrupt is not caught by the nearest handler only), that the inner one
approves and the outer one rejects, and that a reject from any handler wins, so
runArchive returns "rejected". A comment claiming the inner approval settles it,
or that the outer handler never sees the interrupt, gets no credit for (4).
Code that is not valid Agency scores 0 whatever else it does. Not valid means
the parser would refuse it: forms like
\`on notes::archive(data) { ... }\`, \`with { ... }\` without a parameter, or
\`catch\` do not exist. A missing raises clause, or an if where a match belongs,
is an idiom miss that loses its quarter, not invalid syntax.`,
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

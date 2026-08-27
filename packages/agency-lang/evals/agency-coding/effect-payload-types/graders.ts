import { formatted } from "../lib/formatted.js";
import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  formatted(),
  idiomJudge({
    name: "declares-the-payload",
    weight: 0.6,
    standard: `
    Here is an effect with a declared payload:

    effect notes::archive {
      count: number
    }

    export def archiveNotes(count: number): Result<string> raises <notes::archive> {
      raise notes::archive("Archive \${count} notes?", { count: count })
      return success("archived \${count}")
    }

    The \`effect\` block declares the fields every raise of \`notes::archive\` must carry. The typechecker then rejects a raise that leaves \`count\` out, and a handler reading \`data.data.count\` gets a number instead of \`any\`.

    Make sure that:
    1. an \`effect notes::archive { ... }\` block declares \`count: number\`.
    2. the raise carries count in its data, and archiveNotes declares \`raises <notes::archive>\`.
    3. the handler decides with a match on \`data.effect\` and a guard on \`data.data.count\`.

    All three of these points count equally towards the final score. If the file is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: `effect notes::archive {
  count: number
}

export def archiveNotes(count: number): Result<string> raises <notes::archive> {
  raise notes::archive("Archive \${count} notes?", { count: count })
  return success("archived \${count}")
}

export def archiveSmall(count: number): string {
  let outcome = ""
  handle {
    outcome = match(archiveNotes(count)) {
      success(v) => v
      failure(e) => "rejected"
    }
  } with (data) {
    return match(data.effect) {
      "notes::archive" if (data.data.count <= 10) => approve()
      _ => reject()
    }
  }
  return outcome
}`,
  }),
];

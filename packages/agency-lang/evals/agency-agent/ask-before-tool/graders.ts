// One turn, no user to answer. The right first move is a question, so the
// reply is judged for what it asks, and the run record is checked for a
// tool written without the facts.
import { binary, grader } from "agency-lang/eval";

export default [
  grader(
    ({ judges }) =>
      judges.goal({
        goal:
          "asks the user which email address the note should go to, and how the email should " +
          "be sent (which provider or account). It does not claim a tool was written or saved",
      }),
    { name: "asks-for-the-missing-facts", mustPass: true },
  ),

  grader(
    ({ record }) => {
      const written = record.metrics.toolCounts.writeToolFor ?? 0;
      return binary(
        written === 0,
        written === 0
          ? "did not call writeToolFor before asking"
          : `called writeToolFor ${written} time(s) without asking first`,
      );
    },
    { name: "no-tool-before-asking" },
  ),
];

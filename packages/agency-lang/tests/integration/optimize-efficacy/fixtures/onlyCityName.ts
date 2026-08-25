// A user-style custom grader, loaded via `--graders ./onlyCityName.ts`.
// Imports from the public API exactly as a user outside the repo would
// (resolved in-tree via Node self-referencing). Needs no LLM, so the
// custom-grader run is cheap and its grading is deterministic.
//
// Scores 1 only for the bare city name. The baseline style buries "Paris" in
// chatter, so an optimizer earns the point by making the agent answer
// tersely — a general change, not a memorized answer.
import { type Grader } from "agency-lang/optimize";

const onlyCityName: Grader = ({ output }) =>
  String(output).trim().replace(/[.!]$/, "").toLowerCase() === "paris" ? 1 : 0;

export default onlyCityName;

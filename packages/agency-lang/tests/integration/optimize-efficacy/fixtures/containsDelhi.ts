// A user-style custom grader, loaded via `--graders ./containsDelhi.ts`.
// Imports from the public API exactly as a user outside the repo would
// (resolved in-tree via Node self-referencing). Needs no LLM, so the
// custom-grader run is cheap and its grading is deterministic.
import { type Grader } from "agency-lang/optimize";

const containsDelhi: Grader = ({ output }) => (/delhi/i.test(String(output)) ? 1 : 0);

export default containsDelhi;

// A user-style custom grader, loaded via `--graders ./onlyCityName.ts`.
// Imports from the public API exactly as a user outside the repo would
// (resolved in-tree via Node self-referencing). Needs no LLM, so the
// custom-grader run is cheap and its grading is deterministic.
import { type Grader } from "agency-lang/optimize";

// Full marks only for a bare city name: one short line, no sentence around it.
const onlyCityName: Grader = ({ output }) => {
  const text = String(output).trim();
  return /^[A-Za-z][A-Za-z' -]{0,40}$/.test(text) && !/\s(is|the|of)\s/i.test(text) ? 1 : 0;
};

export default onlyCityName;

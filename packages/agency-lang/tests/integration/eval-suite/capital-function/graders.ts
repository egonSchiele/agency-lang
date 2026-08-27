import { existsSync } from "fs";
import { join } from "path";

import { grader } from "agency-lang/eval";

// Advisory only. The holdout harness pair beside this file is the gate, and
// a failed gate skips advisory graders, which the eval-run test checks for.
export default [
  grader(({ workdir }) => existsSync(join(workdir, "solution.agency")), {
    name: "wrote-solution",
  }),
];

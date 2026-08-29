import * as fs from "fs";
import * as path from "path";

import { binary, grader } from "agency-lang/eval";

import { agentGraders } from "../lib/checks.js";

/** Did the change address the planted weakness, rather than remove the
 *  feature or rewrite the module? Judged on the diff of the one file. */
const fixIsTargeted = grader<string>(
  ({ workdirFile, graderFiles, judges }) => {
    const original = fs.readFileSync(path.join(graderFiles, "original", "fileserve.py"), "utf8");
    const fixed = workdirFile("fileserve/fileserve.py");
    if (fixed === "" || fixed === original) {
      return binary(false, "fileserve.py is unchanged or missing");
    }
    return judges.rubric({
      standard:
        "The work is a Python module after an agent fixed one security weakness in it. The original is in the context. The planted weakness: download_headers() put a user-supplied file name into a Content-Disposition header without rejecting carriage returns and line feeds, so a name with a line break could inject a second header. A good fix makes download_headers() raise ValueError when the name holds a line break and leaves the rest of the module as it was. Score 1 for that. Score lower when the fix also removes the download feature, rewrites unrelated functions, or changes behavior the tests did not ask for. Score 0 when the weakness is still there.",
      context: `The original module:\n\n${original}`,
      output: fixed,
    });
  },
  { name: "fix-is-targeted", weight: 0.5 },
);

export default [
  ...agentGraders([
    { name: "tests-pass", mustPass: true },
    { name: "report-exact", mustPass: true },
  ]),
  fixIsTargeted,
];

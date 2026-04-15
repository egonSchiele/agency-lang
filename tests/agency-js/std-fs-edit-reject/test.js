import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runEdit, rejectInterrupt } from "./agent.js";

const TMP = mkdtempSync(join(tmpdir(), "agency-edit-reject-"));

// Reject should short-circuit the edit: the failure comes back as a Result
// and the file is never written to.
const path = join(TMP, "reject.txt");
writeFileSync(path, "alpha\n");
const r = await runEdit(path, "alpha", "OMEGA", false);
const rejected = await rejectInterrupt(r.data);
const contents = readFileSync(path, "utf8");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      hadFailure: rejected.data?.success === false,
      contentsUnchanged: contents === "alpha\n",
    },
    null,
    2,
  ),
);

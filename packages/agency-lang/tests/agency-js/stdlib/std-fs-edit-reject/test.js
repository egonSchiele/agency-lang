import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";
import { runEdit, respondToInterrupts, reject } from "./agent.js";

const TMP = mkdtempSync(join(tmpdir(), "agency-edit-reject-"));

const path = join(TMP, "reject.txt");
writeFileSync(path, "alpha\n");
// dir + basename, not an absolute filename: the containment preparation
// would refuse the absolute spelling before any interrupt, and this
// fixture exists to exercise rejection of the std::edit interrupt itself.
const r = await runEdit(basename(path), dirname(path), "alpha", "OMEGA", false);
const rejected = await respondToInterrupts(r.data, [reject()]);
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

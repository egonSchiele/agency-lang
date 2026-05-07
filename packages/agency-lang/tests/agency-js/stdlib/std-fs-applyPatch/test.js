import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { relative, join } from "path";
import { runApply, readBack } from "./agent.js";

const TMP_REL = "tmp-patch-fixtures";
const TMP = join(process.cwd(), TMP_REL);
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

async function tryApply(patch) {
  const r = await runApply(patch);
  const result = r.data;
  if (result && result.success === false) {
    return { ok: false, error: String(result.error ?? "") };
  }
  return { ok: true, applied: result.value.applied, files: result.value.files };
}

// --- Case 1: single-file edit patch ---
writeFileSync(join(TMP, "modify.txt"), "one\ntwo\nthree\n");
const modifyRel = join(TMP_REL, "modify.txt");
const modifyPatch = [
  `--- a/${modifyRel}`,
  `+++ b/${modifyRel}`,
  `@@ -1,3 +1,3 @@`,
  ` one`,
  `-two`,
  `+TWO`,
  ` three`,
  ``,
].join("\n");
const modifyResult = await tryApply(modifyPatch);
const modifyContents = (await readBack(modifyRel)).data;

// --- Case 2: new-file patch (/dev/null) ---
const newRel = join(TMP_REL, "brand-new.txt");
const newPatch = [
  `--- /dev/null`,
  `+++ b/${newRel}`,
  `@@ -0,0 +1,2 @@`,
  `+hello`,
  `+world`,
  ``,
].join("\n");
const newResult = await tryApply(newPatch);
const newExists = existsSync(join(TMP, "brand-new.txt"));
const newContents = newExists
  ? readFileSync(join(TMP, "brand-new.txt"), "utf8")
  : null;

// --- Case 3: context mismatch should fail ---
writeFileSync(join(TMP, "mismatch.txt"), "one\ntwo\nthree\n");
const mismatchRel = join(TMP_REL, "mismatch.txt");
const mismatchPatch = [
  `--- a/${mismatchRel}`,
  `+++ b/${mismatchRel}`,
  `@@ -1,3 +1,3 @@`,
  ` one`,
  `-NOT-TWO`,
  `+TWO`,
  ` three`,
  ``,
].join("\n");
const mismatchResult = await tryApply(mismatchPatch);
const mismatchContents = (await readBack(mismatchRel)).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      modify: {
        ok: modifyResult.ok,
        applied: modifyResult.applied,
        contents: modifyContents,
      },
      newFile: {
        ok: newResult.ok,
        applied: newResult.applied,
        exists: newExists,
        contents: newContents,
      },
      mismatch: {
        ok: mismatchResult.ok,
        mentionsContextMismatch: /context does not match|context mismatch|could not be applied/.test(
          mismatchResult.error ?? "",
        ),
        contentsUnchanged: mismatchContents === "one\ntwo\nthree\n",
      },
    },
    null,
    2,
  ),
);

rmSync(TMP, { recursive: true, force: true });

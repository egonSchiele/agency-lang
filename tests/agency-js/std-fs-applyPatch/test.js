import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { relative, join } from "path";
import { runApply, readBack } from "./agent.js";

const TMP = join(process.cwd(), "tmp-patch-fixtures");
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
const modifyPath = join(TMP, "modify.txt");
writeFileSync(modifyPath, "one\ntwo\nthree\n");
const modifyRel = relative(process.cwd(), modifyPath);
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
const modifyContents = (await readBack(modifyPath)).data;

// --- Case 2: new-file patch (/dev/null) ---
const newRel = relative(process.cwd(), join(TMP, "brand-new.txt"));
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
const mismatchPath = join(TMP, "mismatch.txt");
writeFileSync(mismatchPath, "one\ntwo\nthree\n");
const mismatchRel = relative(process.cwd(), mismatchPath);
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
const mismatchContents = (await readBack(mismatchPath)).data;

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
        mentionsContextMismatch: /context mismatch|cannot remove/.test(
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

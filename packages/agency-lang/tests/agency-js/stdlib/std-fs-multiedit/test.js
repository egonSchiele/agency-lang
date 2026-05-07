import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { readBack, runMultiedit } from "./agent.js";

const TMP_REL = "tmp-multiedit-fixtures";
const TMP = join(process.cwd(), TMP_REL);

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

async function tryMultiedit(filename, edits) {
  const r = await runMultiedit(filename, edits);
  const result = r.data;
  if (result && result.success === false) {
    return { ok: false, error: String(result.error ?? "") };
  }
  return {
    ok: true,
    replacements: result.value.replacements,
    edits: result.value.edits,
  };
}

// --- Case 1: two sequential edits applied in order ---
const seqPath = join(TMP_REL, "sequential.txt");
writeFileSync(join(TMP, "sequential.txt"), "A B C\n");
const seqResult = await tryMultiedit(seqPath, [
  { oldText: "A", newText: "X", replaceAll: false },
  { oldText: "B", newText: "Y", replaceAll: false },
]);
const seqContents = (await readBack(seqPath)).data;

// --- Case 2: atomicity - second edit fails, file unchanged ---
const atomicPath = join(TMP_REL, "atomic.txt");
writeFileSync(join(TMP, "atomic.txt"), "one two three\n");
const atomicResult = await tryMultiedit(atomicPath, [
  { oldText: "one", newText: "ONE", replaceAll: false },
  { oldText: "MISSING", newText: "Z", replaceAll: false },
]);
const atomicContents = (await readBack(atomicPath)).data;

// --- Case 3: empty edits array is a no-op ---
const emptyPath = join(TMP_REL, "empty.txt");
writeFileSync(join(TMP, "empty.txt"), "unchanged\n");
const emptyResult = await tryMultiedit(emptyPath, []);
const emptyContents = (await readBack(emptyPath)).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      sequential: { ok: seqResult.ok, replacements: seqResult.replacements, contents: seqContents },
      atomic: {
        ok: atomicResult.ok,
        mentionsNotFound: /not found/.test(atomicResult.error ?? ""),
        contentsUnchanged: atomicContents === "one two three\n",
      },
      empty: {
        ok: emptyResult.ok,
        replacements: emptyResult.replacements,
        edits: emptyResult.edits,
        contentsUnchanged: emptyContents === "unchanged\n",
      },
    },
    null,
    2,
  ),
);

rmSync(TMP, { recursive: true, force: true });

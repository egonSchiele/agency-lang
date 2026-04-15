import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { writeFixture, readBack, runEdit } from "./agent.js";

const TMP = join(process.cwd(), "tmp-edit-fixtures");

// Fresh scratch dir for every run.
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

async function tryEdit(args) {
  const r = await runEdit(...args);
  const result = r.data;
  if (result && result.success === false) {
    return { ok: false, error: String(result.error ?? "") };
  }
  return { ok: true, replacements: result.value.replacements };
}

// --- Case 1: unique-match happy path ---
const uniquePath = join(TMP, "unique.txt");
writeFileSync(uniquePath, "alpha beta gamma\n");
const uniqueResult = await tryEdit([uniquePath, "beta", "BETA", false]);
const uniqueContents = (await readBack(uniquePath)).data;

// --- Case 2: replaceAll ---
const allPath = join(TMP, "all.txt");
writeFileSync(allPath, "x x x\n");
const allResult = await tryEdit([allPath, "x", "Y", true]);
const allContents = (await readBack(allPath)).data;

// --- Case 3: zero-match error ---
const missingPath = join(TMP, "missing.txt");
writeFileSync(missingPath, "foo bar\n");
const missingResult = await tryEdit([missingPath, "nonexistent", "Z", false]);

// --- Case 4: multi-match without replaceAll should error ---
const multiPath = join(TMP, "multi.txt");
writeFileSync(multiPath, "x x x\n");
const multiResult = await tryEdit([multiPath, "x", "Y", false]);
const multiContents = (await readBack(multiPath)).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      unique: { replacements: uniqueResult.replacements, contents: uniqueContents },
      replaceAll: { replacements: allResult.replacements, contents: allContents },
      zeroMatch: { ok: missingResult.ok, mentionsNotFound: /not found/.test(missingResult.error ?? "") },
      multiMatch: { ok: multiResult.ok, contentsUnchanged: multiContents === "x x x\n" },
    },
    null,
    2,
  ),
);

rmSync(TMP, { recursive: true, force: true });

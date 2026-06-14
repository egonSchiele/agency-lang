import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { makePatch, runApply, readBack } from "./agent.js";

const TMP_REL = "tmp-roundtrip-fixtures";
const TMP = join(process.cwd(), TMP_REL);
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

async function roundtrip(oldText, newText, name) {
  const rel = join(TMP_REL, name);
  writeFileSync(join(process.cwd(), rel), oldText);
  const p = (await makePatch(oldText, newText, rel)).data;
  const applied = await runApply(p);
  const ok = !(applied.data && applied.data.success === false);
  const contents = (await readBack(rel)).data;
  return { ok, matches: contents === newText };
}

const modify = await roundtrip("one\ntwo\nthree\n", "one\nTWO\nthree\n", "modify.txt");
const multi = await roundtrip("a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\n", "multi.txt");

writeFileSync(
  "__result.json",
  JSON.stringify({ modify, multi }, null, 2),
);

rmSync(TMP, { recursive: true, force: true });

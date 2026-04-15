import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runMkdir, runCopy, runMove, runRemove } from "./agent.js";

const TMP = mkdtempSync(join(tmpdir(), "agency-fs-ops-"));

// --- mkdir: creates a nested path ---
const mkdirPath = join(TMP, "nested", "dir", "deep");
const mkdirResult = (await runMkdir(mkdirPath)).data;

// --- copy: file ---
const copySrc = join(TMP, "src.txt");
writeFileSync(copySrc, "hello\n");
const copyDest = join(TMP, "copied.txt");
const copyResult = (await runCopy(copySrc, copyDest)).data;
const copyDestContents = existsSync(copyDest)
  ? readFileSync(copyDest, "utf8")
  : null;

// --- move: file ---
const moveSrc = join(TMP, "to-move.txt");
writeFileSync(moveSrc, "moved\n");
const moveDest = join(TMP, "moved.txt");
const moveResult = (await runMove(moveSrc, moveDest)).data;
const moveDestContents = existsSync(moveDest)
  ? readFileSync(moveDest, "utf8")
  : null;

// --- remove: existing file ---
const rmTarget = join(TMP, "to-delete.txt");
writeFileSync(rmTarget, "bye\n");
const rmResult = (await runRemove(rmTarget)).data;

// --- remove: nonexistent path is a no-op success ---
const rmMissing = (await runRemove(join(TMP, "no-such-file"))).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      mkdir: { ok: mkdirResult.ok, exists: mkdirResult.exists },
      copy: {
        ok: copyResult.ok,
        srcExists: copyResult.srcExists,
        destExists: copyResult.destExists,
        contents: copyDestContents,
      },
      move: {
        ok: moveResult.ok,
        srcExists: moveResult.srcExists,
        destExists: moveResult.destExists,
        contents: moveDestContents,
      },
      remove: { ok: rmResult.ok, exists: rmResult.exists },
      removeMissing: { ok: rmMissing.ok, exists: rmMissing.exists },
    },
    null,
    2,
  ),
);

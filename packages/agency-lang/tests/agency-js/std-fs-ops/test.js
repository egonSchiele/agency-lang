import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runMkdir, runCopy, runMove, runRemove } from "./agent.js";

const TMP = mkdtempSync(join(tmpdir(), "agency-fs-ops-"));

// --- mkdir: creates a nested path ---
const mkdirPath = join(TMP, "nested", "dir", "deep");
const mkdirResult = (await runMkdir(mkdirPath)).data;

// --- mkdir: idempotent on an existing path ---
const mkdirAgain = (await runMkdir(mkdirPath)).data;

// --- copy: file ---
const copySrc = join(TMP, "src.txt");
writeFileSync(copySrc, "hello\n");
const copyDest = join(TMP, "copied.txt");
const copyResult = (await runCopy(copySrc, copyDest)).data;
const copyDestContents = existsSync(copyDest)
  ? readFileSync(copyDest, "utf8")
  : null;

// --- copy: directory tree ---
const copyDirSrc = join(TMP, "src-dir");
mkdirSync(join(copyDirSrc, "inner"), { recursive: true });
writeFileSync(join(copyDirSrc, "a.txt"), "A\n");
writeFileSync(join(copyDirSrc, "inner", "b.txt"), "B\n");
const copyDirDest = join(TMP, "dest-dir");
const copyDirResult = (await runCopy(copyDirSrc, copyDirDest)).data;
const copyDirInnerContents =
  copyDirResult.destExists && existsSync(join(copyDirDest, "inner", "b.txt"))
    ? readFileSync(join(copyDirDest, "inner", "b.txt"), "utf8")
    : null;

// --- move: file ---
const moveSrc = join(TMP, "to-move.txt");
writeFileSync(moveSrc, "moved\n");
const moveDest = join(TMP, "moved.txt");
const moveResult = (await runMove(moveSrc, moveDest)).data;
const moveDestContents = existsSync(moveDest)
  ? readFileSync(moveDest, "utf8")
  : null;

// --- move: directory ---
const moveDirSrc = join(TMP, "movable-dir");
mkdirSync(moveDirSrc, { recursive: true });
writeFileSync(join(moveDirSrc, "x.txt"), "X\n");
const moveDirDest = join(TMP, "moved-dir");
const moveDirResult = (await runMove(moveDirSrc, moveDirDest)).data;
const moveDirChildContents = existsSync(join(moveDirDest, "x.txt"))
  ? readFileSync(join(moveDirDest, "x.txt"), "utf8")
  : null;

// --- remove: existing file ---
const rmTarget = join(TMP, "to-delete.txt");
writeFileSync(rmTarget, "bye\n");
const rmResult = (await runRemove(rmTarget)).data;

// --- remove: directory tree ---
const rmDirTarget = join(TMP, "to-delete-dir");
mkdirSync(join(rmDirTarget, "inner"), { recursive: true });
writeFileSync(join(rmDirTarget, "inner", "c.txt"), "C\n");
const rmDirResult = (await runRemove(rmDirTarget)).data;

// --- remove: nonexistent path is a no-op success ---
const rmMissing = (await runRemove(join(TMP, "no-such-file"))).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      mkdir: { ok: mkdirResult.ok, exists: mkdirResult.exists },
      mkdirIdempotent: { ok: mkdirAgain.ok, exists: mkdirAgain.exists },
      copy: {
        ok: copyResult.ok,
        srcExists: copyResult.srcExists,
        destExists: copyResult.destExists,
        contents: copyDestContents,
      },
      copyDir: {
        ok: copyDirResult.ok,
        srcExists: copyDirResult.srcExists,
        destExists: copyDirResult.destExists,
        innerContents: copyDirInnerContents,
      },
      move: {
        ok: moveResult.ok,
        srcExists: moveResult.srcExists,
        destExists: moveResult.destExists,
        contents: moveDestContents,
      },
      moveDir: {
        ok: moveDirResult.ok,
        srcExists: moveDirResult.srcExists,
        destExists: moveDirResult.destExists,
        childContents: moveDirChildContents,
      },
      remove: { ok: rmResult.ok, exists: rmResult.exists },
      removeDir: { ok: rmDirResult.ok, exists: rmDirResult.exists },
      removeMissing: { ok: rmMissing.ok, exists: rmMissing.exists },
    },
    null,
    2,
  ),
);

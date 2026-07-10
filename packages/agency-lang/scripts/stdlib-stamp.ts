// Prints the doc stamp: stdlib content hash COMBINED with the compiler
// stamp. docs/site/stdlib/ is tracked and ships; its output depends on
// the doc generator too, which lives inside the compilerStamp scope —
// stdlibHash alone would leave tracked docs stale after a generator edit
// until some unrelated stdlib change.
//
// Written in TypeScript and compiled to dist/scripts/stdlib-stamp.js like
// every other script (this is NOT part of the compile bootstrap — it only
// runs from `make doc`, which `make all` sequences after `make build`, so
// a built dist is guaranteed). Contrast scripts/stage-agents.mjs, which
// must run on bare node before dist exists and therefore stays plain .mjs.
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  computeStdlibHash,
  computeCompilerStamp,
  hashBytes,
} from "@/compiler/buildManifest.js";

// This file executes as dist/scripts/stdlib-stamp.js → the package root
// is TWO levels up (the .mjs predecessor lived at scripts/, one level up
// — that off-by-one shipped a constant stamp once; hence the loud guards
// below instead of hashTree's silent empty hash for missing dirs).
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const stdlibDir = path.join(packageRoot, "stdlib");
const distLib = path.join(packageRoot, "dist", "lib");
for (const required of [stdlibDir, distLib]) {
  if (!fs.existsSync(required)) {
    console.error(`stdlib-stamp: expected directory missing: ${required}`);
    process.exit(1);
  }
}
const stdlibHash = computeStdlibHash(stdlibDir);
const compilerStamp = computeCompilerStamp(distLib);
console.log(hashBytes(stdlibHash + compilerStamp));

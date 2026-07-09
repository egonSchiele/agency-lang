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
import * as path from "path";
import { fileURLToPath } from "url";
import {
  computeStdlibHash,
  computeCompilerStamp,
  hashBytes,
} from "@/compiler/buildManifest.js";

// dist/scripts/stdlib-stamp.js → package root is one level up.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stdlibHash = computeStdlibHash(path.join(packageRoot, "stdlib"));
const compilerStamp = computeCompilerStamp(path.join(packageRoot, "dist", "lib"));
console.log(hashBytes(stdlibHash + compilerStamp));

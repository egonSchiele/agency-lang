// Prints the doc stamp: stdlib content hash COMBINED with the compiler
// stamp. docs/site/stdlib/ is tracked and ships; its output depends on
// the doc generator too, which lives inside the compilerStamp scope —
// stdlibHash alone would leave tracked docs stale after a generator edit
// until some unrelated stdlib change. Imports the canonical
// implementations from dist (no duplication) — requires a built dist,
// which `make all` guarantees (build runs before doc).
import {
  computeStdlibHash,
  computeCompilerStamp,
  hashBytes,
} from "../dist/lib/compiler/buildManifest.js";
import path from "path";
import { fileURLToPath } from "url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stdlibHash = computeStdlibHash(path.join(packageRoot, "stdlib"));
const compilerStamp = computeCompilerStamp(path.join(packageRoot, "dist", "lib"));
console.log(hashBytes(stdlibHash + compilerStamp));

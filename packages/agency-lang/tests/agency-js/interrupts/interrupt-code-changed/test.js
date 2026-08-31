// A resume must be refused when the source of a module the checkpoint has a
// live frame in has changed, and succeed when only unreferenced code changed.
//
// The "redeploy" is simulated at the registry seam: a real redeploy loads a
// recompiled module whose init registers a different source hash, and the
// compiler side of that (emitted hash == sha256 of the source, different
// source -> different hash) is pinned by lib/backends/moduleSourceHash.test.ts.
// Re-registering here reproduces exactly what the new module's init would do,
// without fighting the ESM module cache to load two versions in one process.
import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { registerModuleSourceHash } from "agency-lang/runtime";
import { writeFileSync } from "fs";

const result = await main();

if (!hasInterrupts(result.data)) {
  throw new Error("Expected an interrupt");
}

const checkpoint = result.data[0].checkpoint;
const hashes = checkpoint.moduleSourceHashes;
if (!hashes || Object.keys(hashes).length === 0) {
  throw new Error("Expected the checkpoint to carry moduleSourceHashes");
}

// Pin the assumption the collection walk relies on: the paused module always
// has a frame on the stack, so the checkpoint's own module is in the map.
if (!(checkpoint.moduleId in hashes)) {
  throw new Error(
    `Expected the paused module ${checkpoint.moduleId} in ${Object.keys(hashes)}`,
  );
}

const moduleId = checkpoint.moduleId;
const originalHash = hashes[moduleId];

// Case 1: the paused module changed -> the resume must be refused.
registerModuleSourceHash(moduleId, "0".repeat(64));
let refusal = null;
try {
  await respondToInterrupts(result.data, [approve()]);
} catch (err) {
  refusal = err;
}
if (refusal === null || refusal.name !== "CheckpointCodeChangedError") {
  throw new Error("Expected a CheckpointCodeChangedError refusal, got: " + refusal);
}

// Case 2: only an UNREFERENCED module changed -> the resume succeeds.
registerModuleSourceHash(moduleId, originalHash);
registerModuleSourceHash("some-unreferenced-module.agency", "1".repeat(64));
const finalResult = await respondToInterrupts(result.data, [approve()]);

writeFileSync("__result.json", JSON.stringify(finalResult.data, null, 2));

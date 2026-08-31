// A resume is refused when a module the checkpoint has a live frame in has
// changed, and succeeds when only unreferenced code changed. The redeploy is
// simulated at the registry seam (what a recompiled module's init would run);
// the compiler leg is pinned by lib/backends/moduleSourceHash.test.ts.
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
const originalEntry = hashes[moduleId];

// Case 1: the paused module changed -> the resume must be refused.
registerModuleSourceHash(moduleId, "0".repeat(64), new Date().toISOString());
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
registerModuleSourceHash(moduleId, originalEntry.hash, originalEntry.compiledAt);
registerModuleSourceHash("some-unreferenced-module.agency", "1".repeat(64), new Date().toISOString());
const finalResult = await respondToInterrupts(result.data, [approve()]);

writeFileSync("__result.json", JSON.stringify(finalResult.data, null, 2));

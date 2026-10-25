import { approve, respondToInterrupts, __setLLMClient } from "./agent.js";
import { scriptedClient } from "./client.js";
import { readFileSync, writeFileSync } from "node:fs";

const kind = process.argv[2];
const captured = {};
__setLLMClient(scriptedClient("resume", kind, captured));
const saved = JSON.parse(readFileSync(`${kind}-interrupts.json`, "utf8"));
const resumed = await respondToInterrupts(saved, saved.map(() => approve()));
writeFileSync(`${kind}-result.json`, JSON.stringify({
  finalData: resumed.data,
  schemaRestored: captured.schemaRestored,
  ...(kind === "created"
    ? { reply: captured.reply }
    : { missingExecutor: captured.reply?.includes("never loaded its module") ?? false }),
}));

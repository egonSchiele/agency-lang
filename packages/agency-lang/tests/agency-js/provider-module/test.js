import { main } from "./agent.js";
import * as smoltalk from "smoltalk";
import { writeFileSync } from "fs";

// Running main() executes the run bootstrap (initFreshExecCtx ->
// loadProviderModules), which loads ./echo-setup.mjs from agency.json and
// registers the "echo" provider into this same smoltalk instance.
await main();

let provider = null;
try {
  const client = smoltalk.getClient({ model: "echo-model", provider: "echo" });
  provider = client?.constructor?.name ?? null;
} catch (e) {
  provider = "ERR:" + e.message;
}

writeFileSync("__result.json", JSON.stringify({ provider }, null, 2));

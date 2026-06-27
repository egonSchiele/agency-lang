import { fileURLToPath } from "url";
import { dirname, join } from "path";
import * as smoltalk from "smoltalk";
import { writeFileSync } from "fs";

const here = dirname(fileURLToPath(import.meta.url));
process.env.AGENCY_LLAMA_PROVIDER_MODULE = join(here, "fake-llama.mjs");

const { main } = await import("./agent.js");
const result = await main();

let provider = "ERR";
try { provider = smoltalk.getClient({ model: "m", provider: "llama-cpp" }).constructor.name; }
catch (e) { provider = "ERR:" + e.message; }

writeFileSync(
  new URL("./__result.json", import.meta.url),
  JSON.stringify({ path: result.data, provider }, null, 2),
);

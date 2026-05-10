import { main, hasInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

// run() without a handler should return an interrupt (std::run),
// not execute the subprocess.
if (!hasInterrupts(result.data)) {
  writeFileSync("__result.json", JSON.stringify({
    error: "Expected interrupt but got: " + JSON.stringify(result.data),
  }, null, 2));
  process.exit(0);
}

const interrupt = result.data[0];

writeFileSync("__result.json", JSON.stringify({
  type: interrupt.type,
  kind: interrupt.kind,
}, null, 2));

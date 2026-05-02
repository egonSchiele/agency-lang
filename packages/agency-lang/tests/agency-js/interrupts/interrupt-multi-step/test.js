import {
  main,
  hasInterrupts,
  approve,
  respondToInterrupts,
} from "./agent.js";
import { writeFileSync } from "fs";

// First call — should get first interrupt
let result = await main();

if (!hasInterrupts(result.data)) {
  throw new Error("Expected first interrupt");
}
if (result.data[0].message !== "What is your name?") {
  throw new Error("Unexpected first interrupt message: " + result.data[0].message);
}

// Resolve with a name — should get second interrupt
result = await respondToInterrupts(result.data, [approve("Bob")]);

if (!hasInterrupts(result.data)) {
  throw new Error("Expected second interrupt");
}
if (result.data[0].message !== "Delete 42 files?") {
  throw new Error("Unexpected second interrupt message: " + result.data[0].message);
}

// Approve the deletion — should complete
result = await respondToInterrupts(result.data, [approve()]);

if (hasInterrupts(result.data)) {
  throw new Error("Did not expect another interrupt");
}

writeFileSync("__result.json", JSON.stringify(result.data, null, 2));

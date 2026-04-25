import {
  main,
  isInterrupt,
  resolveInterrupt,
  approveInterrupt,
} from "./agent.js";
import { writeFileSync } from "fs";

// First call — should get first interrupt
let result = await main();

if (!isInterrupt(result.data)) {
  throw new Error("Expected first interrupt");
}
if (result.data.data !== "What is your name?") {
  throw new Error("Unexpected first interrupt message: " + result.data.data);
}

// Resolve with a name — should get second interrupt
result = await resolveInterrupt(result.data, "Bob");

if (!isInterrupt(result.data)) {
  throw new Error("Expected second interrupt");
}
if (result.data.data !== "Delete 42 files?") {
  throw new Error("Unexpected second interrupt message: " + result.data.data);
}

// Approve the deletion — should complete
result = await approveInterrupt(result.data);

if (isInterrupt(result.data)) {
  throw new Error("Did not expect another interrupt");
}

writeFileSync("__result.json", JSON.stringify(result.data, null, 2));

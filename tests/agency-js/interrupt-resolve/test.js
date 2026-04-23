import { main, isInterrupt, resolveInterrupt } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

if (!isInterrupt(result.data)) {
  throw new Error("Expected an interrupt");
}

if (result.data.data !== "What is your name?") {
  throw new Error("Unexpected interrupt message: " + result.data.data);
}

const finalResult = await resolveInterrupt(result.data, "Alice");

writeFileSync("__result.json", JSON.stringify(finalResult.data, null, 2));

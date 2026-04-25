import { main, isInterrupt, rejectInterrupt } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

if (!isInterrupt(result.data)) {
  throw new Error("Expected an interrupt");
}

if (result.data.data !== "Do you approve?") {
  throw new Error("Unexpected interrupt message: " + result.data.data);
}

const finalResult = await rejectInterrupt(result.data);

writeFileSync("__result.json", JSON.stringify(finalResult.data, null, 2));

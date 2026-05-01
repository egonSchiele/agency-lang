import { main, hasInterrupts, reject, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

if (!hasInterrupts(result.data)) {
  throw new Error("Expected an interrupt");
}

if (result.data[0].data !== "Do you approve?") {
  throw new Error("Unexpected interrupt message: " + result.data[0].data);
}

const finalResult = await respondToInterrupts(result.data, [reject()]);

writeFileSync("__result.json", JSON.stringify(finalResult.data, null, 2));

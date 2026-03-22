import { main } from "./agent.js";
import { writeFileSync } from "fs";

try {
  const result = await main();
  writeFileSync("__result.json", JSON.stringify({ error: false, data: result.data }, null, 2));
} catch (e) {
  writeFileSync("__result.json", JSON.stringify({
    error: true,
    errorName: e.name,
    message: e.message.includes("Possible infinite loop")
  }, null, 2));
}

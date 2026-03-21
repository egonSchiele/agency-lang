import { main } from "./agent.js";
import { writeFileSync } from "fs";

let result;
try {
  result = await main();
  result = { error: false, data: result.data };
} catch (e) {
  result = { error: true, message: e.message };
}
writeFileSync("__result.json", JSON.stringify(result, null, 2));

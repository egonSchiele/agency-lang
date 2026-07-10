import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

writeFileSync(
  "__result.json",
  JSON.stringify({ legacyBehavior: result === "legacy: ran" }, null, 2),
);

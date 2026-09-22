import { main } from "./agent.js";
import { writeFileSync } from "fs";

// Omitted: the body fills both defaults. Passed: the argument wins.
const omitted = await main();
const passed = await main([1, 2], "given");
writeFileSync(
  "__result.json",
  JSON.stringify({ omitted: omitted.data, passed: passed.data }, null, 2),
);

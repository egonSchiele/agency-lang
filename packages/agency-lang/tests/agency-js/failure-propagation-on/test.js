import { main } from "./agent.js";
import { writeFileSync } from "fs";

// Opting a compiled program into "on" exercises the strict behavior end to
// end during Stage 1, while the shipped default is still "warn". This is
// the guard that makes the Stage 2 default flip a no-surprise diff.

const result = await main();

writeFileSync(
  "__result.json",
  JSON.stringify({ skipped: result === "skipped" }, null, 2),
);

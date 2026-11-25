import { main } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

const result = await main();

const titles = readFileSync("statelog.log", "utf-8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line))
  .filter((e) => e.data?.type === "traceTitle")
  .map((e) => e.data.title);

writeFileSync(
  "__result.json",
  JSON.stringify({ result: result.data, titles }, null, 2),
);

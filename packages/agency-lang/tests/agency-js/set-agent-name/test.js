import { main } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

const result = await main();

const events = readFileSync("statelog.log", "utf-8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));
const agentNameEvents = events.filter((e) => e.data?.type === "agentName");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      result: result.data,
      agentNameCount: agentNameEvents.length,
      agentName: agentNameEvents[0]?.data?.name ?? null,
    },
    null,
    2,
  ),
);

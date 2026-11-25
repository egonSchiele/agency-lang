import { main } from "./agent.js";
import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { parseStatelogJsonl } from "../../../dist/lib/statelog/parse.js";

// A thread's first promptCompletion logs its messages whole. Later ones log
// how many messages they kept from the call before and the messages after
// those. Reading the log through the parser gives back every call's whole
// list.

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

await main();

const text = readFileSync("statelog.log", "utf-8");
const isCompletion = (event) => event.data?.type === "promptCompletion";
const raw = text
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line))
  .filter(isCompletion);
const rebuilt = parseStatelogJsonl(text).events.filter(isCompletion);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      rawShapes: raw.map((event) => (Array.isArray(event.data.messages) ? "full" : "change")),
      kept: raw.map((event) => event.data.keptMessages ?? null),
      sameWriter: raw.every((event) => event.data.logWriter === raw[0].data.logWriter),
      rebuiltThird: rebuilt[2].data.messages.map((message) => `${message.role}: ${message.content}`),
    },
    null,
    2,
  ),
);

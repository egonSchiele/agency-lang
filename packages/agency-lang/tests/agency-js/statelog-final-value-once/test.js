import { main } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

const STRAIGHT = "answer-returned-straight-from-main";
const HANDED_OFF = "answer-handed-off-to-finish";

await main(STRAIGHT, false);
await main(HANDED_OFF, true);

const lines = readFileSync("statelog.log", "utf-8").trim().split("\n");
const events = lines.map((line) => JSON.parse(line));
const typesHolding = (text) =>
  events.filter((_event, index) => lines[index].includes(text)).map((event) => event.data.type);
const exitOf = (nodeId, text) =>
  events.find(
    (event) =>
      event.data.type === "exitNode" &&
      event.data.nodeId === nodeId &&
      event.trace_id === events.find((other) => JSON.stringify(other).includes(text))?.trace_id,
  );

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      straightReturnLoggedIn: typesHolding(`${STRAIGHT}-returned`),
      lastExitHasNoValue: !("data" in exitOf("main", STRAIGHT).data.data),
      handedOffReturnLoggedIn: typesHolding(`${HANDED_OFF}-returned`),
      handOffDataInMainExit: exitOf("main", HANDED_OFF).data.data.data.answer === HANDED_OFF,
      finishExitHasNoValue: !("data" in exitOf("finish", HANDED_OFF).data.data),
    },
    null,
    2,
  ),
);

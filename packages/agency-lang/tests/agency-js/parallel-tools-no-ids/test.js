import { main } from "./agent.js";
import { writeFileSync } from "fs";

// Two tools are called in one LLM round, but the mocked provider returns
// BOTH tool calls with an empty id ("") — exactly what Google Gemini's
// function-calling protocol does (it matches responses to calls by name +
// position, not by id, so smoltalk defaults the missing id to ""). The
// tool-dispatch loop must NOT collide on a shared "tool_" branch key; the
// regression this guards against is `runBatch: duplicate child key "tool_"`.
const result = await main();

writeFileSync(
  "__result.json",
  JSON.stringify({ data: result.data }, null, 2),
);

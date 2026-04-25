import { foo, bar } from "./agent.js";
import { writeFileSync } from "fs";

// First call: tell the LLM a favorite number, get messages back
const result1 = await foo();
const msgs = result1.data;

// Second call: pass those messages into bar, which should be able to recall the number
const result2 = await bar(msgs);

writeFileSync(
  "__result.json",
  JSON.stringify({
    answer: result2.data,
  }, null, 2),
);

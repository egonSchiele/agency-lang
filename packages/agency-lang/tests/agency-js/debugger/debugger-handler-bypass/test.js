import { DebuggerState, hasInterrupts, approve, respondToInterrupts } from "agency-lang/runtime";
import { writeFileSync } from "fs";
import { __setDebugger, main } from "./agent.js";

const dbg = new DebuggerState(10);
dbg.running();
__setDebugger(dbg);

const result = await main();
const isDebuggerInterrupt = hasInterrupts(result.data) && result.data[0].debugger === true;
const resumed = await respondToInterrupts(result.data, [approve()]);

writeFileSync(
  "__result.json",
  JSON.stringify({ isDebuggerInterrupt, finalResult: resumed.data }, null, 2),
);

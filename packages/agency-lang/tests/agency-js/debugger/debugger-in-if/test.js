import { main, hasInterrupts, approve, respondToInterrupts, __setDebugger } from "./agent.js";
import { DebuggerState } from "agency-lang/runtime";
import { writeFileSync } from "fs";

const dbg = new DebuggerState(10);
dbg.running();
__setDebugger(dbg);

let result = await main();
const hitDebugger = hasInterrupts(result.data) && result.data[0].debugger === true;
const resumed = await respondToInterrupts(result.data, [approve()]);

writeFileSync(
  "__result.json",
  JSON.stringify({ hitDebugger, finalResult: resumed.data }, null, 2),
);

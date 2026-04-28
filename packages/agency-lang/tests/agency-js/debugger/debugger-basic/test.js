import { main, hasInterrupts, approve, respondToInterrupts, __setDebugger } from "./agent.js";
import { DebuggerState } from "agency-lang/runtime";
import { writeFileSync } from "fs";

const dbg = new DebuggerState(10);
dbg.running();
__setDebugger(dbg);

const result = await main();
const isDebuggerInterrupt = hasInterrupts(result.data) && result.data[0].debugger === true;
const label = result.data[0].data;
const resumed = await respondToInterrupts(result.data, [approve()]);

writeFileSync(
  "__result.json",
  JSON.stringify({ isDebuggerInterrupt, label, finalResult: resumed.data }, null, 2),
);

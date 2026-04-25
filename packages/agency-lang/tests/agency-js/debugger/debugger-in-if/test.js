import { main, approveInterrupt, isInterrupt, __setDebugger } from "./agent.js";
import { DebuggerState } from "agency-lang/runtime";
import { writeFileSync } from "fs";

const dbg = new DebuggerState(10);
dbg.running();
__setDebugger(dbg);

let result = await main();
const hitDebugger = isInterrupt(result.data) && result.data.debugger === true;
result = await approveInterrupt(result.data);

writeFileSync(
  "__result.json",
  JSON.stringify({ hitDebugger, finalResult: result.data }, null, 2),
);

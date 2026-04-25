import { main, approveInterrupt, isInterrupt, __setDebugger } from "./agent.js";
import { DebuggerState } from "agency-lang/runtime";
import { writeFileSync } from "fs";

const dbg = new DebuggerState(10);
dbg.running();
__setDebugger(dbg);

const result = await main();
const isDebuggerInterrupt = isInterrupt(result.data) && result.data.debugger === true;
const label = result.data.data;
const resumed = await approveInterrupt(result.data);

writeFileSync(
  "__result.json",
  JSON.stringify({ isDebuggerInterrupt, label, finalResult: resumed.data }, null, 2),
);

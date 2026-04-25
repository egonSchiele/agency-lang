import { main, approveInterrupt, isInterrupt, __setDebugger } from "./agent.js";
import { DebuggerState } from "agency-lang/runtime";
import { writeFileSync } from "fs";

const dbg = new DebuggerState(10);
dbg.running();
__setDebugger(dbg);

const labels = [];
let result = await main();

if (isInterrupt(result.data) && result.data.debugger === true) {
  labels.push(result.data.data);
  result = await approveInterrupt(result.data);
}
if (isInterrupt(result.data) && result.data.debugger === true) {
  labels.push(result.data.data);
  result = await approveInterrupt(result.data);
}

writeFileSync(
  "__result.json",
  JSON.stringify({ labels, finalResult: result.data }, null, 2),
);

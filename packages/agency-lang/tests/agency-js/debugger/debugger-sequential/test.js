import { main, hasInterrupts, approve, respondToInterrupts, __setDebugger } from "./agent.js";
import { DebuggerState } from "agency-lang/runtime";
import { writeFileSync } from "fs";

const dbg = new DebuggerState(10);
dbg.running();
__setDebugger(dbg);

const labels = [];
let result = await main();

if (hasInterrupts(result.data) && result.data[0].debugger === true) {
  labels.push(result.data[0].data);
  result = await respondToInterrupts(result.data, [approve()]);
}
if (hasInterrupts(result.data) && result.data[0].debugger === true) {
  labels.push(result.data[0].data);
  result = await respondToInterrupts(result.data, [approve()]);
}

writeFileSync(
  "__result.json",
  JSON.stringify({ labels, finalResult: result.data }, null, 2),
);

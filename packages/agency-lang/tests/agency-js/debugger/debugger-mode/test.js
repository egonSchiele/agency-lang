import { main, approveInterrupt, isInterrupt, __setDebugger } from "./agent.js";
import { DebuggerState } from "agency-lang/runtime";
import { writeFileSync } from "fs";

const dbg = new DebuggerState(10);
__setDebugger(dbg);

let breakpointCount = 0;
let result = await main();

// Loop through all debugger breakpoints, approving each
while (isInterrupt(result.data) && result.data.debugger === true) {
  breakpointCount++;
  result = await approveInterrupt(result.data);
}

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      breakpointCount,
      finalResult: result.data,
    },
    null,
    2,
  ),
);

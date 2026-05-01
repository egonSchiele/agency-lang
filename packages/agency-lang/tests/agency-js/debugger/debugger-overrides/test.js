import { DebuggerState } from "agency-lang/runtime";
import { writeFileSync } from "fs";
import { __setDebugger, approve, main, respondToInterrupts } from "./agent.js";

const dbg = new DebuggerState(10);
dbg.running();
__setDebugger(dbg);

const result = await main();
const resumed = await respondToInterrupts(result.data, [approve()], { overrides: { x: 100 } });

writeFileSync(
  "__result.json",
  JSON.stringify({ finalResult: resumed.data }, null, 2),
);

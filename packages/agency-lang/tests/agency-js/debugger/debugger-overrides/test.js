import { main, approveInterrupt, isInterrupt, __setDebugger } from "./agent.js";
import { DebuggerState } from "agency-lang/runtime";
import { writeFileSync } from "fs";

const dbg = new DebuggerState(10);
dbg.running();
__setDebugger(dbg);

const result = await main();
const resumed = await approveInterrupt(result.data, { overrides: { x: 100 } });

writeFileSync(
  "__result.json",
  JSON.stringify({ finalResult: resumed.data }, null, 2),
);

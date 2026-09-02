// CLI entry: the one `waypoint` bin, dispatching every subcommand.
import { compile } from "../compiler/codegen.js";
import { runProgram } from "../runtime/index.js";
import { runBundledAgent } from "./runBundledAgent.js";

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "compile":
    compile(rest[0]);
    break;
  case "run":
    await runProgram(rest[0], rest.slice(1));
    break;
  case "agent":
    runBundledAgent(rest);
    break;
  default:
    console.error(`waypoint: unknown command ${command ?? "(none)"}`);
    process.exit(1);
}

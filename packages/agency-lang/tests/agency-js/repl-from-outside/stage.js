// Runs the REPL with stdout treated as a terminal, so it prints its footer.
// test.js types into its stdin.
import { main } from "./agent.js";

process.stdout.isTTY = true;
await main();

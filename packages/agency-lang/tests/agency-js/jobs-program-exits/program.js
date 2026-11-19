// The child process: runs the program and prints the job's id. Nothing
// here ends the process; it exits when nothing holds it open.
import { main } from "./agent.js";

const result = await main();
console.log(result.data);

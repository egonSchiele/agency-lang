import path from "path";
import fs from "fs";
import * as readline from "readline";
import { approve, hasInterrupts, main, respondToInterrupts } from "./foo.js";

export function _input(prompt) {
  const override = globalThis.__agencyInputOverride;
  if (override) {
    return override(prompt);
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export function _write(filename, content) {
  const filePath = path.resolve(process.cwd(), filename);
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

async function run() {
  let result = await main();
  // console.log(JSON.stringify(result.data, null, 2));
  _write("/Users/adit/result.json", JSON.stringify(result.data, null, 2));
  while (hasInterrupts(result.data)) {
    console.log("This result has interrupts!");
    console.log(JSON.stringify(result.data, null, 2));
    const answers = [];
    for (const interrupt of result.data) {
      // console.log("Interrupts detected in the result:", interrupt.data);
      const response = "yes"; /*  await _input(
        "Do you approve this interrupt? (yes/no): ",
      ); */
      if (response.toLowerCase() === "yes") {
        answers.push(approve());
      } else {
        console.log("Interrupt not approved. Exiting.");
        return;
      }
    }
    result = await respondToInterrupts(result.data, answers);
  }
  console.log("Final result:", result);
}

await run();

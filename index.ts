import { foo, isInterrupt, respondToInterrupt } from "./foo.ts";
import { sayHi } from "./bar.ts";
import { toolMessage } from "smoltalk";
import readline from "readline";

function _builtinInput(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}

const finalState = (await foo()) as any;
console.log({ finalState });
if (isInterrupt(finalState)) {
  console.log("Execution interrupted with message:", finalState.data);
  const approval = await _builtinInput(
    "Do you want to approve this interrupt? (yes/no): ",
  );
  if (approval.toLowerCase() === "yes" || approval.toLowerCase() === "y") {
    await respondToInterrupt(finalState, { type: "approve" });
  } else {
    await respondToInterrupt(finalState, { type: "reject" });
  }
}

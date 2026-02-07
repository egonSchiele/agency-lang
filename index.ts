import { foo, approveInterrupt, rejectInterrupt } from "./foo.ts";
import readline from "readline";
function input(prompt: string): Promise<string> {
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

type Interrupt<T> = {
  type: "interrupt";
  data: T;
  __messages: any[];
  __toolCall: {
    id: string;
    name: string;
  };
};

function isInterrupt<T>(obj: any): obj is Interrupt<T> {
  return obj && obj.type === "interrupt";
}

let finalState = (await foo()) as any;
while (isInterrupt(finalState)) {
  console.log("Execution interrupted with message:", finalState.data);
  const response = await input("Do you want to approve? (yes/no) ");
  if (response.toLowerCase() === "yes" || response.toLowerCase() === "y") {
    finalState = await approveInterrupt(finalState);
  } else if (
    response.toLowerCase() === "no" ||
    response.toLowerCase() === "n"
  ) {
    finalState = await rejectInterrupt(finalState);
  } else {
    finalState = await approveInterrupt(finalState, { name: response });
  }
}

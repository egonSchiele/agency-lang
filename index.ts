import { foo, respondToInterrupts, isInterruptBatch } from "./foo.js";
import readline from "readline";
import type { StreamChunk } from "smoltalk";
import { color } from "termcolors";

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

const callbacks = {
  onStream: (chunk: StreamChunk) => {
    if (chunk.type === "text") {
      process.stdout.write(color.green(chunk.text));
    }
  },
};

async function main() {
  let finalState = (await foo({ callbacks })) as any;
  let result = finalState.data;
  console.log("\nFinal result:", JSON.stringify(finalState, null, 2));
  while (isInterruptBatch(result)) {
    const responses: Record<string, any> = {};
    for (const intr of result.interrupts) {
      responses[intr.interrupt_id] = { type: "approve" };
    }

    result = (await respondToInterrupts(result, responses)).data;
    console.log("\nFinal result:", JSON.stringify(result, null, 2));
  }
  /*   while (isInterrupt(result)) {
    console.log("Execution interrupted with message:", result.data);
    const response = await input("Do you want to approve? (yes/no) ");
    if (response.toLowerCase() === "yes" || response.toLowerCase() === "y") {
      finalState = await approveInterrupt(result, { callbacks });
      result = finalState.data;
    } else if (
      response.toLowerCase() === "no" ||
      response.toLowerCase() === "n"
    ) {
      finalState = await rejectInterrupt(result, { callbacks });
      result = finalState.data;
    } else {
      finalState = await modifyInterrupt(
        result,
        { name: response },
        { callbacks },
      );
       finalState = await modifyInterrupt(
        result,
        { name: response },
        { callbacks },
      ); 
      result = finalState.data;
    }
  }

 */
  //  console.log("\nFinal result:", JSON.stringify(result, null, 2));
}

main();

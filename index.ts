import { foo, approveInterrupt, rejectInterrupt } from "./foo.ts";
import readline from "readline";
import { StreamChunk } from "smoltalk";
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
      process.stdout.write(chunk.text);
    }
  },
};

async function main() {
  const resp = await foo({ callbacks });
  console.log({ resp });
}

main();

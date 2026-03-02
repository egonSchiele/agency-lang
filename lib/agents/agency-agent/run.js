import {
  main,
  approveInterrupt,
  rejectInterrupt,
  modifyInterrupt,
} from "./agent.js";
import readline from "readline";
import { color } from "termcolors";
import ora from "ora";
import { syntaxHighlight } from "../../utils/agentUtils.js";

const spinner = ora({
  text: color.cyan("Thinking"),
  spinner: "pong",
  hideCursor: false,
  discardStdin: false,
});

function input(prompt) {
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

function isInterrupt(obj) {
  return obj && obj.type === "interrupt";
}

const spinnerTexts = ["Thinking", "Pondering", "Reflecting", "Analyzing"];

let interval;
let callCount = 0;
const callbacks = {
  onStream: (chunk) => {
    if (chunk.type === "text") {
      process.stdout.write(color.green(chunk.text));
    }
  },
  onLLMCallStart: (call) => {
    callCount++;
    console.log(color.cyan(`🧠 #${callCount} (${call.model})`));
    // console.log(color.green(`Thinking with ${call.model}`));
    /* spinner.start();
    interval = setInterval(() => {
      const text =
        spinnerTexts[Math.floor(Math.random() * spinnerTexts.length)];
      spinner.text = color.cyan(text);
    }, 1500); */
  },
  onLLMCallEnd: (call) => {
    clearInterval(interval);
    spinner.succeed(`🧠 Done (${call.timeTaken})`);
  },
  onToolCallStart: (call) => {
    console.log(color.blue(`🛠️ Calling tool: ${call.toolName}(${call.args.join(", ")})`));
  },
  onNodeStart: (node) => {
    console.log(color.magenta(`➡️ Starting node: ${node.nodeName}`));
  }
};

function printInterruptMessage(message) {
  if (message.tool === "writeCodeWithConfirm") {
    console.log(color.yellow(message.message));
    console.log(syntaxHighlight(message.content, "ts"));
  }
}

async function run() {
  console.log(color.bold.underline.cyan("Starting Agency Agent...\n"));
  let finalState = await main({ callbacks });
  console.log("\nFinal result:", JSON.stringify(finalState, null, 2));
  let result = finalState.data;
  while (isInterrupt(result)) {
    // console.log("Execution interrupted with message:", result.data);
    printInterruptMessage(result.data);
    const response = await input("Approve? (y/n): ");
    if (response.toLowerCase() === "yes" || response.toLowerCase() === "y") {
      finalState = await approveInterrupt(result, { callbacks });
      result = finalState.data;
    } else {
      finalState = await rejectInterrupt(result, { callbacks });
      result = finalState.data;
    }
  }
}

run();

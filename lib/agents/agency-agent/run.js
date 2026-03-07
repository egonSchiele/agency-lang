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
let seconds = 0;
const callbacks = {
  onStream: (chunk) => {
    if (chunk.type === "text") {
      process.stdout.write(color.green(chunk.text));
    }
  },
  onLLMCallStart: (call) => {
    callCount++;
    seconds = 0;
    const modelName =
      typeof call.model === "string" ? call.model : JSON.stringify(call.model);
    process.stdout.write(color.cyan(`🧠 (${modelName}) - ${seconds}s\r`));
    // console.log(color.green(`Thinking with ${call.model}`));
    // spinner.start();
    interval = setInterval(() => {
      seconds++;
      process.stdout.write(color.cyan(`🧠 (${modelName}) - ${seconds}s\r`));
    }, 1000);
  },
  onLLMCallEnd: (call) => {
    clearInterval(interval);
    console.log(
      `\n🧠`,
      color.green(
        `Done (model: ${call.model}, time: ${Math.round(call.timeTaken / 1000)}s)`,
      ),
    );
  },
  onToolCallStart: (call) => {
    console.log(
      color.blue(
        `🛠️ Calling tool: ${call.toolName}(${call.args
          .map(JSON.stringify)
          .map((x) => x.slice(0, 20))
          .join(", ")}${call.args.length > 0 ? "..." : ""})`,
      ),
    );
  },
  onNodeStart: (node) => {
    console.log(color.magenta(`➡️ Starting node: ${node.nodeName}`));
  },
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
    console.log("Execution interrupted with message:", result.data);
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

  console.log("Fin.");
}

run();

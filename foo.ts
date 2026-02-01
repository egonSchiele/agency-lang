// @ts-nocheck


import { printLine, readFile, writeFile, confirm, execCommand }  from "./basicFunctions.ts";

import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { PieMachine, goToNode } from "piemachine";
import { StatelogClient } from "statelog-client";
import { nanoid } from "nanoid";
import { assistantMessage, getClient, userMessage, toolMessage } from "smoltalk";

const statelogHost = "https://statelog.adit.io";
const traceId = nanoid();
const statelogConfig = {
    host: statelogHost,
    traceId: traceId,
    apiKey: process.env.STATELOG_API_KEY || "",
    projectId: "agency-lang",
    debugMode: false,
  };
const statelogClient = new StatelogClient(statelogConfig);
const __model: ModelName = "gpt-4o-mini";


const getClientWithConfig = (config = {}) => {
  const defaultConfig = {
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    googleApiKey: process.env.GEMINI_API_KEY || "",
    model: __model,
    logLevel: "warn",
  };

  return getClient({ ...defaultConfig, ...config });
};

let __client = getClientWithConfig();

type State = {
  messages: string[];
  data: any;
}

// enable debug logging
const graphConfig = {
  debug: {
    log: true,
    logData: true,
  },
  statelog: statelogConfig,
};

// Define the names of the nodes in the graph
// Useful for type safety
const __nodes = ["main"] as const;
type Node = (typeof __nodes)[number];

const graph = new PieMachine<State, Node>(__nodes, graphConfig);
function add({a, b}: {a:number, b:number}):number {
  return a + b;
}

const addTool = {
  name: "add",
  description: "Adds two numbers together and returns the result.",
  schema: z.object({
    a: z.number().describe("The first number to add"),
    b: z.number().describe("The second number to add"),
  }),
};


function _builtinInput(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}

function _builtinRead(filename: string): string {
  const data = fs.readFileSync(filename);
  const contents = data.toString('utf8');
  return contents;
}

const printLineToolTool = {
  name: "printLineTool",
  description: "Prints a line to the console.",
  schema: z.object({"message": z.string(), })
};
const readFileToolTool = {
  name: "readFileTool",
  description: "Reads the content of a file.",
  schema: z.object({"filePath": z.string(), })
};
const writeFileToolTool = {
  name: "writeFileTool",
  description: "Writes content to a file.",
  schema: z.object({"filePath": z.string(), "content": z.string(), })
};
const confirmToolTool = {
  name: "confirmTool",
  description: "Prompts the user for confirmation.",
  schema: z.object({"message": z.string(), })
};
const execCommandToolTool = {
  name: "execCommandTool",
  description: "Executes a shell command and returns its output.",
  schema: z.object({"command": z.string(), })
};
async function printLineTool({message}) : Promise<string> {
    const __messages: Message[] = [];
    printLine(message)
return "printed"

}async function readFileTool({filePath}) : Promise<string> {
    const __messages: Message[] = [];
    return readFile(filePath)

}async function writeFileTool({filePath, content}) : Promise<string> {
    const __messages: Message[] = [];
    await writeFile(filePath, content)
return "file written"

}async function confirmTool({message}) : Promise<boolean> {
    const __messages: Message[] = [];
    return await confirm(message)

}async function execCommandTool({command}) : Promise<string> {
    const __messages: Message[] = [];
    await execCommand(command)
return "command executed"

}const docs = await await _builtinRead("DOCS.md");
const prompt = `
Please create a meal planning agent. Each user has a pantry of ingredients with nutritional values and a list of meals, which include the recipes and ingredients for each meal.
A user should be able to list their ingredients, add or edit an existing ingredient, list their meals, add or edit an existing meal, or import a recipe from a URL.
`;

async function _result(prompt: string, docs: string, __messages: Message[] = []): Promise<string> {
  const __prompt = `You are an assistant that can create agents using the Agency programming language. Using the following documentation about the Agency language, create an agent that can do the following task: ${prompt}. Here is the documentation about the Agency language: ${docs}`;
  const startTime = performance.now();
  __messages.push(userMessage(__prompt));
  const __tools = [writeFileToolTool, readFileToolTool, printLineToolTool, execCommandToolTool];

  
  
  const __responseFormat = undefined;
  

  let __completion = await __client.text({
    messages: __messages,
    tools: __tools,
    responseFormat: __responseFormat,
  });

  const endTime = performance.now();
  statelogClient.promptCompletion({
    messages: __messages,
    completion: __completion,
    model: __client.getModel(),
    timeTaken: endTime - startTime,
  });

  if (!__completion.success) {
    throw new Error(
      `Error getting response from ${__model}: ${__completion.error}`
    );
  }

  let responseMessage = __completion.value;

  // Handle function calls
  while (responseMessage.toolCalls.length > 0) {
    // Add assistant's response with tool calls to message history
    __messages.push(assistantMessage(responseMessage.output, { toolCalls: responseMessage.toolCalls }));
    let toolCallStartTime, toolCallEndTime;

    // Process each tool call
    for (const toolCall of responseMessage.toolCalls) {
      if (
  toolCall.name === "writeFileTool"
) {
  const args = toolCall.arguments;

  toolCallStartTime = performance.now();
  const result = await writeFileTool(args);
  toolCallEndTime = performance.now();

  // console.log("Tool 'writeFileTool' called with arguments:", args);
  // console.log("Tool 'writeFileTool' returned result:", result);

statelogClient.toolCall({
    toolName: "writeFileTool",
    args,
    output: result,
    model: __client.getModel(),
    timeTaken: toolCallEndTime - toolCallStartTime,
  });

  // Add function result to messages
  __messages.push(toolMessage(result, {
            tool_call_id: toolCall.id,
            name: toolCall.name,
      }));
}
if (
  toolCall.name === "readFileTool"
) {
  const args = toolCall.arguments;

  toolCallStartTime = performance.now();
  const result = await readFileTool(args);
  toolCallEndTime = performance.now();

  // console.log("Tool 'readFileTool' called with arguments:", args);
  // console.log("Tool 'readFileTool' returned result:", result);

statelogClient.toolCall({
    toolName: "readFileTool",
    args,
    output: result,
    model: __client.getModel(),
    timeTaken: toolCallEndTime - toolCallStartTime,
  });

  // Add function result to messages
  __messages.push(toolMessage(result, {
            tool_call_id: toolCall.id,
            name: toolCall.name,
      }));
}
if (
  toolCall.name === "printLineTool"
) {
  const args = toolCall.arguments;

  toolCallStartTime = performance.now();
  const result = await printLineTool(args);
  toolCallEndTime = performance.now();

  // console.log("Tool 'printLineTool' called with arguments:", args);
  // console.log("Tool 'printLineTool' returned result:", result);

statelogClient.toolCall({
    toolName: "printLineTool",
    args,
    output: result,
    model: __client.getModel(),
    timeTaken: toolCallEndTime - toolCallStartTime,
  });

  // Add function result to messages
  __messages.push(toolMessage(result, {
            tool_call_id: toolCall.id,
            name: toolCall.name,
      }));
}
if (
  toolCall.name === "execCommandTool"
) {
  const args = toolCall.arguments;

  toolCallStartTime = performance.now();
  const result = await execCommandTool(args);
  toolCallEndTime = performance.now();

  // console.log("Tool 'execCommandTool' called with arguments:", args);
  // console.log("Tool 'execCommandTool' returned result:", result);

statelogClient.toolCall({
    toolName: "execCommandTool",
    args,
    output: result,
    model: __client.getModel(),
    timeTaken: toolCallEndTime - toolCallStartTime,
  });

  // Add function result to messages
  __messages.push(toolMessage(result, {
            tool_call_id: toolCall.id,
            name: toolCall.name,
      }));
}
    }
  
    const nextStartTime = performance.now();
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
    });

    const nextEndTime = performance.now();

    statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: nextEndTime - nextStartTime,
    });

    if (!__completion.success) {
      throw new Error(
        `Error getting response from ${__model}: ${__completion.error}`
      );
    }
    responseMessage = __completion.value;
  }

  // Add final assistant response to history
  // not passing tool calls back this time
  __messages.push(assistantMessage(responseMessage.output));
  

  
  return responseMessage.output;
  
}

async function _response(msg: string, __messages: Message[] = []): Promise<string> {
  const __prompt = `Respond to this user message: ${msg}`;
  const startTime = performance.now();
  __messages.push(userMessage(__prompt));
  const __tools = [writeFileToolTool, readFileToolTool, printLineToolTool, execCommandToolTool];

  
  
  const __responseFormat = undefined;
  

  let __completion = await __client.text({
    messages: __messages,
    tools: __tools,
    responseFormat: __responseFormat,
  });

  const endTime = performance.now();
  statelogClient.promptCompletion({
    messages: __messages,
    completion: __completion,
    model: __client.getModel(),
    timeTaken: endTime - startTime,
  });

  if (!__completion.success) {
    throw new Error(
      `Error getting response from ${__model}: ${__completion.error}`
    );
  }

  let responseMessage = __completion.value;

  // Handle function calls
  while (responseMessage.toolCalls.length > 0) {
    // Add assistant's response with tool calls to message history
    __messages.push(assistantMessage(responseMessage.output, { toolCalls: responseMessage.toolCalls }));
    let toolCallStartTime, toolCallEndTime;

    // Process each tool call
    for (const toolCall of responseMessage.toolCalls) {
      if (
  toolCall.name === "writeFileTool"
) {
  const args = toolCall.arguments;

  toolCallStartTime = performance.now();
  const result = await writeFileTool(args);
  toolCallEndTime = performance.now();

  // console.log("Tool 'writeFileTool' called with arguments:", args);
  // console.log("Tool 'writeFileTool' returned result:", result);

statelogClient.toolCall({
    toolName: "writeFileTool",
    args,
    output: result,
    model: __client.getModel(),
    timeTaken: toolCallEndTime - toolCallStartTime,
  });

  // Add function result to messages
  __messages.push(toolMessage(result, {
            tool_call_id: toolCall.id,
            name: toolCall.name,
      }));
}
if (
  toolCall.name === "readFileTool"
) {
  const args = toolCall.arguments;

  toolCallStartTime = performance.now();
  const result = await readFileTool(args);
  toolCallEndTime = performance.now();

  // console.log("Tool 'readFileTool' called with arguments:", args);
  // console.log("Tool 'readFileTool' returned result:", result);

statelogClient.toolCall({
    toolName: "readFileTool",
    args,
    output: result,
    model: __client.getModel(),
    timeTaken: toolCallEndTime - toolCallStartTime,
  });

  // Add function result to messages
  __messages.push(toolMessage(result, {
            tool_call_id: toolCall.id,
            name: toolCall.name,
      }));
}
if (
  toolCall.name === "printLineTool"
) {
  const args = toolCall.arguments;

  toolCallStartTime = performance.now();
  const result = await printLineTool(args);
  toolCallEndTime = performance.now();

  // console.log("Tool 'printLineTool' called with arguments:", args);
  // console.log("Tool 'printLineTool' returned result:", result);

statelogClient.toolCall({
    toolName: "printLineTool",
    args,
    output: result,
    model: __client.getModel(),
    timeTaken: toolCallEndTime - toolCallStartTime,
  });

  // Add function result to messages
  __messages.push(toolMessage(result, {
            tool_call_id: toolCall.id,
            name: toolCall.name,
      }));
}
if (
  toolCall.name === "execCommandTool"
) {
  const args = toolCall.arguments;

  toolCallStartTime = performance.now();
  const result = await execCommandTool(args);
  toolCallEndTime = performance.now();

  // console.log("Tool 'execCommandTool' called with arguments:", args);
  // console.log("Tool 'execCommandTool' returned result:", result);

statelogClient.toolCall({
    toolName: "execCommandTool",
    args,
    output: result,
    model: __client.getModel(),
    timeTaken: toolCallEndTime - toolCallStartTime,
  });

  // Add function result to messages
  __messages.push(toolMessage(result, {
            tool_call_id: toolCall.id,
            name: toolCall.name,
      }));
}
    }
  
    const nextStartTime = performance.now();
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
    });

    const nextEndTime = performance.now();

    statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: nextEndTime - nextStartTime,
    });

    if (!__completion.success) {
      throw new Error(
        `Error getting response from ${__model}: ${__completion.error}`
      );
    }
    responseMessage = __completion.value;
  }

  // Add final assistant response to history
  // not passing tool calls back this time
  __messages.push(assistantMessage(responseMessage.output));
  

  
  return responseMessage.output;
  
}
graph.node("main", async (state): Promise<any> => {
    const __messages: Message[] = [];
    
    



const result = await _result(prompt, docs, __messages);

await console.log(result)
while (true) {
const msg = await await _builtinInput("> ");





const response = await _response(msg, __messages);

await console.log(response)
}

});

const initialState: State = {messages: [], data: {}};
const finalState = graph.run("main", initialState);
export async function main(data:any): Promise<any> {
  const result = await graph.run("main", { messages: [], data });
  return result.data;
}

export default graph;

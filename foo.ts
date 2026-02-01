// @ts-nocheck


import { printLine, printHighlighted, readFile, writeFile, confirm, execCommand }  from "./basicFunctions.ts";

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
const __nodes = ["main","saveCode","typecheckFile","fixErrors"] as const;
type Node = (typeof __nodes)[number];

const graph = new PieMachine<State, Node>(__nodes, graphConfig);

// builtins

const not = (val: any): boolean => !val;
const eq = (a: any, b: any): boolean => a === b;
const neq = (a: any, b: any): boolean => a !== b;
const lt = (a: any, b: any): boolean => a < b;
const lte = (a: any, b: any): boolean => a <= b;
const gt = (a: any, b: any): boolean => a > b;
const gte = (a: any, b: any): boolean => a >= b;
const and = (a: any, b: any): boolean => a && b;
const or = (a: any, b: any): boolean => a || b;

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


function _builtinRead(filename: string): string {
  const data = fs.readFileSync(filename);
  const contents = data.toString('utf8');
  return contents;
}

type CommandResult = { stdout: string; stderr: string; canceled: boolean };
const printLineToolTool = {
  name: "printLineTool",
  description: "Prints a line to the console.",
  schema: z.object({"message": z.string(), })
};
const printHighlightedToolTool = {
  name: "printHighlightedTool",
  description: "Prints highlighted code to the console in the specified language.",
  schema: z.object({"code": z.string(), "language": z.string(), })
};
const readFileToolTool = {
  name: "readFileTool",
  description: "Reads the content of a file.",
  schema: z.object({"filePath": z.string(), })
};
const writeFileToolTool = {
  name: "writeFileTool",
  description: "Writes content to a file. If language is provided, the content will be syntax highlighted accordingly.",
  schema: z.object({"filePath": z.string(), "content": z.string(), "language": z.union([z.string(), z.string()]), })
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

}async function printHighlightedTool({code, language}) : Promise<string> {
    const __messages: Message[] = [];
    printHighlighted(code, language)
return "printed"

}async function readFileTool({filePath}) : Promise<string> {
    const __messages: Message[] = [];
    return readFile(filePath)

}async function writeFileTool({filePath, content, language}) : Promise<string> {
    const __messages: Message[] = [];
    await writeFile(filePath, content, language)
return "file written"

}async function confirmTool({message}) : Promise<boolean> {
    const __messages: Message[] = [];
    return await confirm(message)

}async function execCommandTool({command}) : Promise<CommandResult> {
    const __messages: Message[] = [];
    const result = await execCommand(command);

return result

}const docs = await await _builtinRead("DOCS.md");
// prompt = """
// Please create a meal planning agent. Each user has a pantry of ingredients with nutritional values and a list of meals, which include the recipes and ingredients for each meal.
// A user should be able to list their ingredients, add or edit an existing ingredient, list their meals, add or edit an existing meal, or import a recipe from a URL.
// """
const prompt = `
Please create a greeting agent. This agent asks a user for their name and language spoken, and then greets them in that language. The agent should support at least English, Spanish, French, and German.
`;

async function _result(prompt: string, docs: string, __messages: Message[] = []): Promise<{ generatedCode: string }> {
  const __prompt = `You are an assistant that can create agents using the Agency programming language. Using the following documentation about the Agency language, create an agent that can do the following task: ${prompt}. Print the generated code for the user to review. Here is the documentation about the Agency language: ${docs}`;
  const startTime = performance.now();
  __messages.push(userMessage(__prompt));
  const __tools = [writeFileToolTool, readFileToolTool, printLineToolTool, printHighlightedToolTool, execCommandToolTool];

  
  // Need to make sure this is always an object
  const __responseFormat = z.object({
     response: z.object({ "generatedCode": z.string() })
  });
  
  

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
  toolCall.name === "printHighlightedTool"
) {
  const args = toolCall.arguments;

  toolCallStartTime = performance.now();
  const result = await printHighlightedTool(args);
  toolCallEndTime = performance.now();

  // console.log("Tool 'printHighlightedTool' called with arguments:", args);
  // console.log("Tool 'printHighlightedTool' returned result:", result);

statelogClient.toolCall({
    toolName: "printHighlightedTool",
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
  
  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'result':", e);
    // console.error("Full completion response:", JSON.stringify(__completion, null, 2));
    // throw e;
  }
  

  
}
graph.node("main", async (state): Promise<any> => {
    const __messages: Message[] = [];
    
    





const result = await _result(prompt, docs, __messages);

const generatedCode = result.generatedCode;

return goToNode("saveCode",
  {
    messages: state.messages,
    
    data: generatedCode
    
    
  }
);

});

async function _result2(generatedCode: string, __messages: Message[] = []): Promise<{ filename: string }> {
  const __prompt = `Here's some code in the Agency language. Save the following code to a file named mealAgent.agency, and return the filename you've saved the code to: ${generatedCode}.`;
  const startTime = performance.now();
  __messages.push(userMessage(__prompt));
  const __tools = [writeFileToolTool];

  
  // Need to make sure this is always an object
  const __responseFormat = z.object({
     response: z.object({ "filename": z.string() })
  });
  
  

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
  
  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'result2':", e);
    // console.error("Full completion response:", JSON.stringify(__completion, null, 2));
    // throw e;
  }
  

  
}
graph.node("saveCode", async (state): Promise<any> => {
    const __messages: Message[] = [];
    
    const generatedCode = state.data;
    
    //  print(result)



const result2 = await _result2(generatedCode, __messages);

await console.log(result2)
const filename = result2.filename;

return goToNode("typecheckFile",
  {
    messages: state.messages,
    
    data: filename
    
    
  }
);

});

async function _typecheckResult(filename: string, __messages: Message[] = []): Promise<{ success: boolean; errors: string }> {
  const __prompt = `Typecheck the following Agency code saved in the file ${filename} by running \"pnpm agency ast ${filename}\"`;
  const startTime = performance.now();
  __messages.push(userMessage(__prompt));
  const __tools = [execCommandToolTool];

  
  // Need to make sure this is always an object
  const __responseFormat = z.object({
     response: z.object({ "success": z.boolean(), "errors": z.string() })
  });
  
  

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
  
  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'typecheckResult':", e);
    // console.error("Full completion response:", JSON.stringify(__completion, null, 2));
    // throw e;
  }
  

  
}
graph.node("typecheckFile", async (state): Promise<any> => {
    const __messages: Message[] = [];
    
    const filename = state.data;
    
    

const typecheckResult = await _typecheckResult(filename, __messages);

const result3 = typecheckResult.success;

const errors = typecheckResult.errors;

switch (result3) {
  case true:
await console.log(/* prompt for: The code in #{filename} typechecks successfully. */)
    break;
  case false:
return goToNode("fixErrors",
  {
    messages: state.messages,
    
    data: {"filename": filename, "errors": errors}
    
    
  }
);

    break;
}
});

async function _result4(filename: string, errors: string, __messages: Message[] = []): Promise<{ fixedCode: string }> {
  const __prompt = `Please fix the following errors in ${filename}: ${errors}`;
  const startTime = performance.now();
  __messages.push(userMessage(__prompt));
  const __tools = [readFileToolTool, writeFileToolTool];

  
  // Need to make sure this is always an object
  const __responseFormat = z.object({
     response: z.object({ "fixedCode": z.string() })
  });
  
  

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
  
  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'result4':", e);
    // console.error("Full completion response:", JSON.stringify(__completion, null, 2));
    // throw e;
  }
  

  
}
graph.node("fixErrors", async (state): Promise<any> => {
    const __messages: Message[] = [];
    
    const params = state.data;
    
    const filename = params.filename;

const errors = params.errors;

await console.log("Errors found")
await console.log(errors)
const instructions = `
Here are some reasons you might see typechecking errors:
- else statements aren't supported yet -- use match statements with a default case instead
- loops aren't supported yet -- or write the code in a separate typescript file and import it
- no infix operators yet (e.g., \`+\`, \`-\`, \`*\`, \`/\`, \`&&\`, \`||\`, \`>=\`, \`<=\`, \`==\`, \`!=\`, etc), use built-in functions instead, like \`not\`, \`eq\`, \`and\`, \`or\`, \`lt\`, \`gt\`, etc.
`;




const result4 = await _result4(filename, errors, __messages);

return goToNode("typecheckFile",
  {
    messages: state.messages,
    
    data: filename
    
    
  }
);

});

graph.conditionalEdge("main", ["saveCode"]);

graph.conditionalEdge("saveCode", ["typecheckFile"]);

graph.conditionalEdge("typecheckFile", ["fixErrors"]);

graph.conditionalEdge("fixErrors", ["typecheckFile"]);

const initialState: State = {messages: [], data: {}};
const finalState = graph.run("main", initialState);
export async function main(data:any): Promise<any> {
  const result = await graph.run("main", { messages: [], data });
  return result.data;
}

export async function saveCode(data:any): Promise<any> {
  const result = await graph.run("saveCode", { messages: [], data });
  return result.data;
}

export async function typecheckFile(data:any): Promise<any> {
  const result = await graph.run("typecheckFile", { messages: [], data });
  return result.data;
}

export async function fixErrors(data:any): Promise<any> {
  const result = await graph.run("fixErrors", { messages: [], data });
  return result.data;
}

export default graph;

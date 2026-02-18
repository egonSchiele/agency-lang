import { fileURLToPath } from "url";
import process from "process";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { StatelogClient, SimpleMachine, goToNode, nanoid } from "agency-lang";
import * as smoltalk from "agency-lang";
import path from "path";

/* Code to log to statelog */
const statelogHost = "https://agency-lang.com";
const __traceId = nanoid();
const statelogConfig = {
  host: statelogHost,
  traceId: __traceId,
  
  
  apiKey: process.env.STATELOG_API_KEY || "",
  
  projectId: "",
  debugMode: false,
};
const __statelogClient = new StatelogClient(statelogConfig);

/* Code for Smoltalk client */
const __model = "gpt-4o-mini";

const __getClientWithConfig = (config = {}) => {
  const defaultConfig = {
    
    
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    
    
    
    googleApiKey: process.env.GEMINI_API_KEY || "",
    
    model: __model,
    logLevel: "warn",
  };

  return smoltalk.getClient({ ...defaultConfig, ...config });
};

let __client = __getClientWithConfig();

/* Code for SimpleMachine graph */

// enable debug logging
const graphConfig = {
  debug: {
    log: true,
    logData: false,
  },
  statelog: statelogConfig,
};

const graph = new SimpleMachine(graphConfig);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
  

/******** builtins ********/

const not = (val) => !val;
const eq = (a, b) => a === b;
const neq = (a, b) => a !== b;
const lt = (a, b) => a < b;
const lte = (a, b) => a <= b;
const gt = (a, b) => a > b;
const gte = (a, b) => a >= b;
const and = (a, b) => a && b;
const or = (a, b) => a || b;
const head = (arr) => arr[0];
const tail = (arr) => arr.slice(1);
const empty = (arr) => arr.length === 0;

async function _builtinFetch(url, args = {}) {
  const result = await fetch(url, args);
  try {
    const text = await result.text();
    return text;
  } catch (e) {
    throw new Error(`Failed to get text from ${url}: ${e}`);
  }
}

async function _builtinFetchJSON(url, args = {}) {
  const result = await fetch(url, args);
  try {
    const json = await result.json();
    return json;
  } catch (e) {
    throw new Error(`Failed to parse JSON from ${url}: ${e}`);
  }
}

function _builtinInput(prompt) {
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

function _builtinRead(filename) {
  const filePath = path.resolve(__dirname, filename);
  const data = fs.readFileSync(filePath);
  const contents = data.toString("utf8");
  return contents;
}

/*
 * @param filePath The absolute or relative path to the image file.
 * @returns The Base64 string, or null if an error occurs.
 */
function _builtinReadImage(filename) {
  const filePath = path.resolve(__dirname, filename);
  const data = fs.readFileSync(filePath); // Synchronous file reading
  const base64String = data.toString("base64");
  return base64String;
}

function _builtinSleep(seconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

function printJSON(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

export const __readSkillTool = {
  name: "readSkill",
  description: `Skills provide specialized knowledge and instructions for particular scenarios.
Use this tool when you need enhanced guidance for a specific type of task.

Args:
    filepath: The name of the skill to read.

Returns:
    The skill content with specialized instructions, or an error message
    if the skill is not found.
`,
  schema: z.object({"filepath": z.string(), })
};

export function readSkill({filepath}) {
  return _builtinRead(filepath);
}

export function __deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/******** for internal agency use only ********/

function __createReturnObject(result) {
  // Note: we're *not* using structuredClone here because structuredClone
  // doesn't call `toJSON`, so it's not cloning our message objects correctly.
  return JSON.parse(JSON.stringify({
    messages: result.messages,
    data: result.data,
    tokens: __stateStack.globals.__tokenStats
  }));
}



/******** interrupts ********/

export function interrupt(data) {
  return {
    type: "interrupt",
    data,
  };
}

export function isInterrupt(obj) {
  return obj && obj.type === "interrupt";
}

export async function respondToInterrupt(
  _interrupt,
  _interruptResponse,
  metadata = {},
) {
  const interrupt = __deepClone(_interrupt);
  const interruptResponse = __deepClone(_interruptResponse);

  __stateStack = StateStack.fromJSON(interrupt.__state || {});
  __stateStack.deserializeMode();

  const messages = (__stateStack.interruptData.messages || []).map(
    (json) => {
      // create message objects from JSON
      return smoltalk.messageFromJSON(json);
    },
  );
  __stateStack.interruptData.messages = messages;
  __stateStack.interruptData.interruptResponse = interruptResponse;

  if (interruptResponse.type === "approve" && interruptResponse.newArguments) {
    __stateStack.interruptData.toolCall = {
      ...__stateStack.interruptData.toolCall,
      arguments: {
        ...__stateStack.interruptData.toolCall.arguments,
        ...interruptResponse.newArguments,
      },
    };
    // Error:
    // TypeError: Cannot set property arguments of #<ToolCall> which has only a getter
    //         toolCall.arguments = { ...toolCall.arguments, ...interruptResponse.newArguments };
    //
    // const lastMessage = __stateStack.interruptData.messages[__stateStack.interruptData.messages.length - 1];
    // if (lastMessage && lastMessage.role === "assistant") {
    //   const toolCall = lastMessage.toolCalls?.[lastMessage.toolCalls.length - 1];
    //   if (toolCall) {
    //     toolCall.arguments = { ...toolCall.arguments, ...interruptResponse.newArguments };
    //   }
    // }
  }

  // start at the last node we visited
  const nodesTraversed = __stateStack.interruptData.nodesTraversed || [];
  const nodeName = nodesTraversed[nodesTraversed.length - 1];
  const __result = await graph.run(nodeName, {
    messages: messages,
    __metadata: {
      graph: graph,
      // we need to pass in the state log client here because
      // if we rely on the local state log client
      // each client in each file has a different trace id.
      // So we pass in the client to make sure they all use the same trace id
      statelogClient: __statelogClient,
      __stateStack: __stateStack,
      __callbacks: metadata.callbacks,
    },

    // restore args from the state stack
    data: "<from-stack>",
  });
  return __createReturnObject(__result);
}

export async function approveInterrupt(
  interrupt,
  metadata = {},
) {
  return await respondToInterrupt(interrupt, { type: "approve" }, metadata);
}

export async function modifyInterrupt(
  interrupt,
  newArguments,
  metadata = {},
) {
  return await respondToInterrupt(
    interrupt,
    { type: "approve", newArguments },
    metadata,
  );
}

export async function rejectInterrupt(
  interrupt,
  metadata = {},
) {
  return await respondToInterrupt(interrupt, { type: "reject" }, metadata);
}

/****** StateStack and related functions for serializing/deserializing execution state during interrupts ********/

// See docs for notes on how this works.
class StateStack {
  stack = [];
  mode = "serialize";
  globals = {};
  other = {};
  interruptData = {};

  deserializeStackLength = 0;

  constructor(
    stack = [],
    mode = "serialize",
  ) {
    this.stack = stack;
    this.mode = mode;
  }

  getNewState() {
    if (this.mode === "deserialize" && this.deserializeStackLength <= 0) {
      console.log("Forcing mode to serialize, nothing left to deserialize");
      this.mode = "serialize";
    }
    if (this.mode === "serialize") {
      const newState = {
        args: {},
        locals: {},
        messages: [],
        step: 0,
      };
      this.stack.push(newState);
      return newState;
    } else if (this.mode === "deserialize") {
      this.deserializeStackLength -= 1;
      const item = this.stack.shift();
      this.stack.push(item);
      return item;
    }
    return null;
  }

  deserializeMode() {
    this.mode = "deserialize";
    this.deserializeStackLength = this.stack.length;
  }

  pop() {
    return this.stack.pop();
  }

  toJSON() {
    return __deepClone({
      stack: this.stack,
      globals: this.globals,
      other: this.other,
      interruptData: this.interruptData,
      mode: this.mode,
      deserializeStackLength: this.deserializeStackLength,
    });
  }

  static fromJSON(json) {
    const stateStack = new StateStack([], "serialize");
    stateStack.stack = json.stack || [];
    stateStack.globals = json.globals || {};
    stateStack.other = json.other || {};
    stateStack.interruptData = json.interruptData || {};
    stateStack.mode = json.mode || "serialize";
    stateStack.deserializeStackLength = json.deserializeStackLength || 0;
    return stateStack;
  }
}

let __stateStack = new StateStack();

__stateStack.globals.__tokenStats = {
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
  },
  cost: {
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
    currency: "USD",
  },
};

function __updateTokenStats(
  usage,
  cost,
) {
  if (!usage || !cost) return;
  const tokenStats = __stateStack.globals.__tokenStats;
  tokenStats.usage.inputTokens += usage.inputTokens || 0;
  tokenStats.usage.outputTokens += usage.outputTokens || 0;
  tokenStats.usage.cachedInputTokens += usage.cachedInputTokens || 0;
  tokenStats.usage.totalTokens += usage.totalTokens || 0;

  tokenStats.cost.inputCost += cost.inputCost || 0;
  tokenStats.cost.outputCost += cost.outputCost || 0;
  tokenStats.cost.totalCost += cost.totalCost || 0;
}

/**** Streaming callback and lock ****/
function isGenerator(variable) {
  const toString = Object.prototype.toString.call(variable);
  return (
    toString === "[object Generator]" || toString === "[object AsyncGenerator]"
  );
}

let __callbacks = {};

async function __callHook(name, data) {
  if (__callbacks[name]) {
    await __callbacks[name](data);
  }
}

let onStreamLock = false;

function __cloneArray(arr) {
  if (arr == undefined) return [];
  return [...arr];
}

const handleStreamingResponse = async (__completion, statelogClient, __prompt, __toolCalls) => {
  if (isGenerator(__completion)) {
    if (!__callbacks.onStream) {
      console.log(
        "No onStream callback provided for streaming response, returning response synchronously",
      );
      statelogClient.debug(
        "Got streaming response but no onStream callback provided, returning response synchronously",
        {
          prompt: __prompt,
          callbacks: Object.keys(__callbacks),
        },
      );
      let syncResult = "";
      for await (const chunk of __completion) {
        switch (chunk.type) {
          case "tool_call":
            __toolCalls.push(chunk.toolCall);
            break;
          case "done":
            syncResult = chunk.result;
            break;
          case "error":
            console.error(`Error in LLM response stream: ${chunk.error}`);
            break;
          default:
            break;
        }
      }
      return { success: true, value: syncResult };
    } else {
      // try to acquire lock
      let count = 0;
      // wait 60 seconds to acquire lock
      while (onStreamLock && count < 10 * 60) {
        await _builtinSleep(0.1);
        count++;
      }
      if (onStreamLock) {
        console.log(`Couldn't acquire lock, ${count}`);
      }
      onStreamLock = true;

      for await (const chunk of __completion) {
        switch (chunk.type) {
          case "text":
            __callbacks.onStream({ type: "text", text: chunk.text });
            break;
          case "tool_call":
            __toolCalls.push(chunk.toolCall);
            __callbacks.onStream({
              type: "tool_call",
              toolCall: chunk.toolCall,
            });
            break;
          case "done":
            __callbacks.onStream({ type: "done", result: chunk.result });
            return { success: true, value: chunk.result };
          case "error":
            __callbacks.onStream({ type: "error", error: chunk.error });
            break;
        }
      }

      onStreamLock = false;
    }
  }
};


/**** Message thread handling ****/

class MessageThread {
  messages = [];
  children = [];

  constructor(messages = []) {
    this.messages = messages;
    this.children = [];
  }

  addMessage(message) {
    this.messages.push(message);
  }

  cloneMessages() {
    return this.messages.map(m => m.toJSON()).map(m => smoltalk.messageFromJSON(m));
  }

  getMessages() {
    return this.messages;
  }

  setMessages(messages) {
    this.messages = messages;
  }

  newChild() {
    const child = new MessageThread();
    return child;
  }

  newSubthreadChild() {
    const child = new MessageThread(this.cloneMessages());
    return child;
  }

  toJSON() {
    return {
      messages: this.messages.map(m => m.toJSON()),
      children: this.children.map((child) => child.toJSON()),
    };
  }

  static fromJSON(json) {
    const thread = new MessageThread();
    thread.messages = (json.messages || []).map((m) =>
      smoltalk.messageFromJSON(m),
    );
    thread.children = (json.children || []).map((child) =>
      MessageThread.fromJSON(child),
    );
    return thread;
  }
}
/*function add({a, b}) {
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
*/
//  Test arrays and objects
//  Simple array
__stateStack.globals.nums = [1, 2, 3, 4, 5];
await console.log(__stateStack.globals.nums)//  Array with strings
__stateStack.globals.names = [`Alice`, `Bob`, `Charlie`];
await console.log(__stateStack.globals.names)//  Nested arrays
__stateStack.globals.matrix = [[1, 2], [3, 4], [5, 6]];
await console.log(__stateStack.globals.matrix)//  Simple object
__stateStack.globals.person = {"name": `Alice`, "age": 30};
await console.log(__stateStack.globals.person)//  Object with nested structure
__stateStack.globals.address = {"street": `123 Main St`, "city": `NYC`, "zip": `10001`};
await console.log(__stateStack.globals.address)//  Object with array property
__stateStack.globals.user = {"name": `Bob`, "tags": [`admin`, `developer`]};
await console.log(__stateStack.globals.user)//  Array of objects
__stateStack.globals.users = [{"name": `Alice`, "age": 30}, {"name": `Bob`, "age": 25}];
await console.log(__stateStack.globals.users)//  Nested object
__stateStack.globals.config = {"server": {"host": `localhost`, "port": 8080}, "debug": true};
await console.log(__stateStack.globals.config)//  Array access
__stateStack.globals.firstNum = __stateStack.globals.nums[0];
await console.log(__stateStack.globals.firstNum)//  Object property access
__stateStack.globals.personName = __stateStack.globals.person.name;
await console.log(__stateStack.globals.personName)
export default graph;
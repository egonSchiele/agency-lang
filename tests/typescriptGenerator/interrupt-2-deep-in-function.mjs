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
export const __greetTool = {
  name: "greet",
  description: `No description provided.`,
  schema: z.object({"name": z.string(), "age": z.number(), })
};

export const __greetToolParams = ["name","age"];export const __foo2Tool = {
  name: "foo2",
  description: `No description provided.`,
  schema: z.object({"name": z.string(), "age": z.number(), })
};

export const __foo2ToolParams = ["name","age"];
export async function greet(args, __metadata={}) {
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;
    const __self = __stack.locals;
    const __graph = __metadata?.graph || graph;
    const statelogClient = __metadata?.statelogClient || __statelogClient;

    // args are always set whether we're restoring from state or not.
    // If we're not restoring from state, args were obviously passed in through the code.
    // If we are restoring from state, the node that called this function had to have passed
    // these arguments into this function call.
    // if we're restoring state, this will override __stack.args (which will be set),
    // but with the same values, so it doesn't matter that those values are being overwritten.
    const __params = ["name", "age"];
    (args).forEach((item, index) => {
      __stack.args[__params[index]] = item;
    });


    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        __stack.step++;
return interrupt(`Agent wants to call the greet function with name: ${__stack.args.name} and age: ${__stack.locals.age}`)
        __stack.step++;
      }
      

      if (__step <= 2) {
        __stateStack.pop();
return `Kya chal raha jai, ${__stack.args.name}! You are ${__stack.locals.age} years old.`
        __stack.step++;
      }
      
}

export async function foo2(args, __metadata={}) {
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;
    const __self = __stack.locals;
    const __graph = __metadata?.graph || graph;
    const statelogClient = __metadata?.statelogClient || __statelogClient;

    // args are always set whether we're restoring from state or not.
    // If we're not restoring from state, args were obviously passed in through the code.
    // If we are restoring from state, the node that called this function had to have passed
    // these arguments into this function call.
    // if we're restoring state, this will override __stack.args (which will be set),
    // but with the same values, so it doesn't matter that those values are being overwritten.
    const __params = ["name", "age"];
    (args).forEach((item, index) => {
      __stack.args[__params[index]] = item;
    });


    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        await console.log(`In foo2, name is ${__stack.args.name} and age is ${__stack.locals.age}, this message should only print once...`)
        __stack.step++;
      }
      

      if (__step <= 2) {
        
async function _response(name, age, __metadata) {
  const __prompt = `Greet the user with their name: ${name} and age ${age} using the greet function.`;
  const startTime = performance.now();
  let __messages = __metadata?.messages || [];

  // These are to restore state after interrupt.
  // TODO I think this could be implemented in a cleaner way.
  let __toolCalls = __stateStack.interruptData?.toolCall ? [__stateStack.interruptData.toolCall] : [];
  const __interruptResponse = __stateStack.interruptData?.interruptResponse || null;
  const __tools = [__greetTool];

  
  
  const __responseFormat = undefined;
  
  
  const __client = __getClientWithConfig({});
  let responseMessage;

  if (__toolCalls.length === 0) {
    __messages.push(smoltalk.userMessage(__prompt));
  
  
    await __callHook("onLLMCallStart", { prompt: __prompt, tools: __tools, model: __client.getModel() });
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
      stream: false
    });

    const endTime = performance.now();

    

    statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: endTime - startTime,
      tools: __tools,
      responseFormat: __responseFormat
    });

    if (!__completion.success) {
      throw new Error(
        `Error getting response from ${__model}: ${__completion.error}`
      );
    }

    responseMessage = __completion.value;
    __toolCalls = responseMessage.toolCalls || [];

    if (__toolCalls.length > 0) {
      // Add assistant's response with tool calls to message history
      __messages.push(smoltalk.assistantMessage(responseMessage.output, { toolCalls: __toolCalls }));
    }

    __updateTokenStats(responseMessage.usage, responseMessage.cost);
    await __callHook("onLLMCallEnd", { result: responseMessage, usage: responseMessage.usage, cost: responseMessage.cost, timeTaken: endTime - startTime });

  }

  // Handle function calls
  if (__toolCalls.length > 0) {
    let toolCallStartTime, toolCallEndTime;
    let haltExecution = false;
    let haltToolCall = {}
    let haltInterrupt = null;

    // Process each tool call
    for (const toolCall of __toolCalls) {
      if (
  toolCall.name === "greet"
) {
  const args = toolCall.arguments;

  const params = __greetToolParams.map((param, index) => {
            return args[param];
          })

  toolCallStartTime = performance.now();
  
  let result;
  if (__interruptResponse && __interruptResponse.type === "reject") {
        __messages.push(smoltalk.toolMessage("tool call rejected", {
        tool_call_id: toolCall.id,
        name: toolCall.name,
     }));
     statelogClient.debug(`Tool call rejected`, {
        tool_call_id: toolCall.id,
        name: toolCall.name,
      });
  } else {
    await __callHook("onToolCallStart", { toolName: "greet", args: params });
    result = await greet(params);
    toolCallEndTime = performance.now();
    await __callHook("onToolCallEnd", { toolName: "greet", result, timeTaken: toolCallEndTime - toolCallStartTime });
  
    statelogClient.toolCall({
      toolName: "greet",
      params,
      output: result,
      model: __client.getModel(),
      timeTaken: toolCallEndTime - toolCallStartTime,
    });

    if (isInterrupt(result)) {
      haltInterrupt = result;
      haltToolCall = {
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      }
      haltExecution = true;
      break;
    }
  
      // Add function result to messages
    __messages.push(smoltalk.toolMessage(result, {
          tool_call_id: toolCall.id,
          name: toolCall.name,
    }));
  }
}
    }

    if (haltExecution) {
      statelogClient.debug(`Tool call interrupted execution.`, {
        messages: __messages,
        model: __client.getModel(),
      });

      __stateStack.interruptData = {
        messages: __messages.map((msg) => msg.toJSON()),
        nodesTraversed: __graph.getNodesTraversed(),
        toolCall: haltToolCall,
      };
      haltInterrupt.__state = __stateStack.toJSON();
      return haltInterrupt;
    }
  
    const nextStartTime = performance.now();
    await __callHook("onLLMCallStart", { prompt: __prompt, tools: __tools, model: __client.getModel() });
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
      stream: false
    });

    const nextEndTime = performance.now();

    

    statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: nextEndTime - nextStartTime,
      tools: __tools,
      responseFormat: __responseFormat,
    });

    if (!__completion.success) {
      throw new Error(
        `Error getting response from ${__model}: ${__completion.error}`
      );
    }
    responseMessage = __completion.value;
    __updateTokenStats(responseMessage.usage, responseMessage.cost);
    await __callHook("onLLMCallEnd", { result: responseMessage, usage: responseMessage.usage, cost: responseMessage.cost, timeTaken: nextEndTime - nextStartTime });
  }

  // Add final assistant response to history
  // not passing tool calls back this time
  __messages.push(smoltalk.assistantMessage(responseMessage.output));
  

  
  return responseMessage.output;
  
}




__self.response = await _response(__stack.args.name, __stack.locals.age, {
      messages: __stack.messages[2]?.getMessages(),
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.response)) {
  
   
   return  __self.response;
   
}
        __stack.step++;
      }
      

      if (__step <= 3) {
        await console.log(`Greeted, age is still ${__stack.locals.age}...`)
        __stack.step++;
      }
      

      if (__step <= 4) {
        __stateStack.pop();
return __stack.locals.response
        __stack.step++;
      }
      
}

graph.node("sayHi", async (state) => {
    const __graph = state.__metadata?.graph || graph;
    const statelogClient = state.__metadata?.statelogClient || __statelogClient;
    
    // if `state.__metadata?.__stateStack` is set, that means we are resuming execution
    // at this node after an interrupt. In that case, this is the line that restores the state.
    if (state.__metadata?.__stateStack) {
      __stateStack = state.__metadata.__stateStack;
      
      // restore global state
      if (state.__metadata?.__stateStack?.global) {
        __global = state.__metadata.__stateStack.global;
      }

      // clear the state stack from metadata so it doesn't propagate to other nodes.
      state.__metadata.__stateStack = undefined;
    }

    if (state.__metadata?.callbacks) {
      __callbacks = state.__metadata.callbacks;
    }

    await __callHook("onNodeStart", { nodeName: "sayHi" });

    // either creates a new stack for this node,
    // or restores the stack if we're resuming after an interrupt,
    // depending on the mode of the state stack (serialize or deserialize).
    const __stack = __stateStack.getNewState();
    
    // We're going to modify __stack.step to keep track of what line we're on,
    // but first we save this value. This will help us figure out if we should execute
    // from the start of this node or from a specific line.
    const __step = __stack.step;

    const __self = __stack.locals;

    if (__stack.messages[4]) {
     __stack.messages[4] = MessageThread.fromJSON(__stack.messages[4]);
} else {
    __stack.messages[4] = new MessageThread();
}
if (__stack.messages[5]) {
     __stack.messages[5] = MessageThread.fromJSON(__stack.messages[5]);
} else {
    __stack.messages[5] = new MessageThread();
}
if (__stack.messages[6]) {
     __stack.messages[6] = MessageThread.fromJSON(__stack.messages[6]);
} else {
    __stack.messages[6] = new MessageThread();
}
if (__stack.messages[7]) {
     __stack.messages[7] = MessageThread.fromJSON(__stack.messages[7]);
} else {
    __stack.messages[7] = new MessageThread();
}

    // if (state.messages) {
    //   __stack.messages[0].setMessages(state.messages);
    // }

    
    
    const __params = ["name"];
    
    // Any arguments that were passed into this node,
    // save them onto the stack, unless we are restoring the stack after an interrupt,
    // in which case leave as is
    if (state.data !== "<from-stack>") {
      (state.data).forEach((item, index) => {
        __stack.args[__params[index]] = item;
      });
    }
    
    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        await console.log(`Saying hi to ${__stack.args.name}...`)
        __stack.step++;
      }
      

      if (__step <= 2) {
        __stack.locals.age = 30;
        __stack.step++;
      }
      

      if (__step <= 3) {
        __stack.locals.response = foo2([__stack.args.name, __stack.locals.age], {
        statelogClient,
        graph: __graph,
        messages: __stack.messages[5].getMessages(),
      });


if (isInterrupt(__stack.locals.response)) {
  
  return { ...state, data: __stack.locals.response };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 4) {
        [__self.response] = await Promise.all([__self.response]);
        __stack.step++;
      }
      

      if (__step <= 5) {
        await console.log(__stack.locals.response)
        __stack.step++;
      }
      

      if (__step <= 6) {
        await console.log(`Greeting sent.`)
        __stack.step++;
      }
      

      if (__step <= 7) {
        return { messages: __stack.messages, data: __stack.locals.response}
        __stack.step++;
      }
      
    
    // this is just here to have a default return value from a node if the user doesn't specify one
    await __callHook("onNodeEnd", { nodeName: "sayHi", data: undefined });
    return { messages: __stack.messages, data: undefined };
});


export async function sayHi(name, { messages, callbacks } = {}) {


  const __data = [ name ];
  __callbacks = callbacks || {};
  await __callHook("onAgentStart", { nodeName: "sayHi", args: __data, messages: messages || [] });
  const __result = await graph.run("sayHi", { messages: messages || [], data: __data });
  const __returnObject = __createReturnObject(__result);
  await __callHook("onAgentEnd", { nodeName: "sayHi", result: __returnObject });
  return __returnObject;
}

export default graph;
import { classify } from "./agent.js";
import { writeFileSync } from "fs";

const hookLog = [];

const callbacks = {
  onAgentStart: ({ nodeName, args }) => {
    hookLog.push({
      hook: "onAgentStart",
      nodeName,
      hasArgs: Object.keys(args).length > 0,
    });
  },
  onAgentEnd: ({ nodeName, result }) => {
    hookLog.push({
      hook: "onAgentEnd",
      nodeName,
      hasResult: result.data !== undefined,
    });
  },
  onNodeStart: ({ nodeName }) => {
    hookLog.push({ hook: "onNodeStart", nodeName });
  },
  onNodeEnd: ({ nodeName }) => {
    hookLog.push({ hook: "onNodeEnd", nodeName });
  },
  onLLMCallStart: ({ prompt, messages, model }) => {
    hookLog.push({
      hook: "onLLMCallStart",
      hasPrompt: typeof prompt === "string" && prompt.length > 0,
      hasMessages: Array.isArray(messages),
      messages: messages,
      hasModel: model !== undefined,
    });
  },
  onLLMCallEnd: ({ result, usage, timeTaken, messages, model, cost }) => {
    hookLog.push({
      hook: "onLLMCallEnd",
      hasResult: result !== undefined,
      hasMessages: Array.isArray(messages),
      hasModel: model !== undefined,
      timeTakenIsNumber: typeof timeTaken === "number",
      hasUsage: usage !== undefined,
      hasCost: cost !== undefined,
    });
  },
};

const result = await classify("I love this product", { callbacks });

// Extract just the hook names in order
const hookNames = hookLog.map((h) => h.hook);

writeFileSync("__result.json", JSON.stringify({ hookNames, hookLog }, null, 2));

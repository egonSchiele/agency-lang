import { compute } from "./agent.js";
import { writeFileSync } from "fs";

const hookLog = [];

const callbacks = {
  onAgentStart: ({ nodeName }) => {
    hookLog.push({ hook: "onAgentStart", nodeName });
  },
  onAgentEnd: ({ nodeName }) => {
    hookLog.push({ hook: "onAgentEnd", nodeName });
  },
  onNodeStart: ({ nodeName }) => {
    hookLog.push({ hook: "onNodeStart", nodeName });
  },
  onNodeEnd: ({ nodeName }) => {
    hookLog.push({ hook: "onNodeEnd", nodeName });
  },
  onFunctionStart: ({ functionName, args, isBuiltin }) => {
    hookLog.push({ hook: "onFunctionStart", functionName, args, isBuiltin });
  },
  onFunctionEnd: ({ functionName, timeTaken }) => {
    hookLog.push({
      hook: "onFunctionEnd",
      functionName,
      timeTakenIsNumber: typeof timeTaken === "number",
    });
  },
};

const result = await compute(5, { callbacks });

const hookNames = hookLog.map((h) => h.hook);

writeFileSync(
  "__result.json",
  JSON.stringify({
    hookNames,
    hookLog,
    data: result.data,
  }, null, 2),
);

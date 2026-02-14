// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/cli/judgeEvaluate.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import { judge, isInterrupt, approveInterrupt, rejectInterrupt, modifyInterrupt } from "./{{{judgeFilename:string}}}";
import { writeFileSync } from "fs";

async function runJudge() {
  const actualOutput = {{{actualOutput:string}}};
  const expectedOutput = {{{expectedOutput:string}}};
  const judgePrompt = {{{judgePrompt:string}}};

  let result = await judge(actualOutput, expectedOutput, judgePrompt);

  {{#hasInterruptHandlers}}
  const interruptHandlers = {{{interruptHandlersJSON?:string}}};
  let handlerIndex = 0;

  while (isInterrupt(result.data)) {
    if (handlerIndex >= interruptHandlers.length) {
      throw new Error("Unexpected interrupt #" + (handlerIndex + 1) + ": \\"" + result.data.data + "\\". No handler provided.");
    }

    const handler = interruptHandlers[handlerIndex];
    const interruptData = result.data;

    // Validate expected message if provided
    if (handler.expectedMessage !== undefined && interruptData.data !== handler.expectedMessage) {
      throw new Error(
        "Interrupt #" + (handlerIndex + 1) + " message mismatch.\\n" +
        "  Expected: \\"" + handler.expectedMessage + "\\"\\n" +
        "  Actual: \\"" + interruptData.data + "\\""
      );
    }

    // Handle interrupt based on action
    if (handler.action === "approve") {
      result = await approveInterrupt(interruptData);
    } else if (handler.action === "reject") {
      result = await rejectInterrupt(interruptData);
    } else if (handler.action === "modify") {
      result = await modifyInterrupt(interruptData, handler.modifiedArgs);
    } else {
      throw new Error("Unknown interrupt action: " + handler.action);
    }

    handlerIndex++;
  }

  // Check if we provided more handlers than interrupts that occurred
  if (handlerIndex < interruptHandlers.length) {
    throw new Error(
      "Expected " + interruptHandlers.length + " interrupts but only " + handlerIndex + " occurred."
    );
  }
  {{/hasInterruptHandlers}}

  writeFileSync("__judge_evaluate.json", JSON.stringify(result, null, 2));
}

runJudge();
`;

export type TemplateType = {
  judgeFilename: string;
  actualOutput: string;
  expectedOutput: string;
  judgePrompt: string;
  hasInterruptHandlers: boolean;
  interruptHandlersJSON?: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    
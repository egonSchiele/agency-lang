// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/cli/judgeEvaluate.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import { judge, isInterrupt, isInterruptBatch, respondToInterrupts } from "./{{{judgeFilename:string}}}";
import { writeFileSync } from "fs";

function buildResponse(handler) {
  if (handler.action === "approve") {
    return { type: "approve" };
  } else if (handler.action === "reject") {
    return { type: "reject" };
  } else if (handler.action === "modify") {
    return { type: "modify", newArguments: handler.modifiedArgs };
  } else {
    throw new Error("Unknown interrupt action: " + handler.action);
  }
}

async function runJudge() {
  const actualOutput = {{{actualOutput:string}}};
  const expectedOutput = {{{expectedOutput:string}}};
  const judgePrompt = {{{judgePrompt:string}}};

  let result = await judge(actualOutput, expectedOutput, judgePrompt);

  {{#hasInterruptHandlers}}
  const interruptHandlers = {{{interruptHandlersJSON?:string}}};
  let handlerIndex = 0;

  while (isInterruptBatch(result.data)) {
    const batch = result.data;
    const interrupts = batch.interrupts;

    if (handlerIndex + interrupts.length > interruptHandlers.length) {
      throw new Error("Unexpected interrupt(s) starting at #" + (handlerIndex + 1) + ". Not enough handlers provided.");
    }

    const responses = {};
    for (const intr of interrupts) {
      const handler = interruptHandlers[handlerIndex];

      // Validate expected message if provided
      if (handler.expectedMessage !== undefined && intr.data !== handler.expectedMessage) {
        throw new Error(
          "Interrupt #" + (handlerIndex + 1) + " message mismatch.\\n" +
          "  Expected: \\"" + handler.expectedMessage + "\\"\\n" +
          "  Actual: \\"" + intr.data + "\\""
        );
      }

      responses[intr.interrupt_id] = buildResponse(handler);
      handlerIndex++;
    }

    result = await respondToInterrupts(batch, responses);
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
    
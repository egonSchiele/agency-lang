// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/cli/evaluate.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import { {{{nodeName:string}}}, isInterrupt, isInterruptBatch, respondToInterrupts } from "./{{{filename:string}}}";
import { writeFileSync } from "fs";

function buildResponse(handler: any): any {
  if (handler.action === "approve") {
    return { type: "approve" };
  } else if (handler.action === "reject") {
    return { type: "reject" };
  } else if (handler.action === "modify") {
    return { type: "modify", newArguments: handler.modifiedArgs };
  } else if (handler.action === "resolve") {
    return { type: "resolve", value: handler.resolvedValue };
  } else {
    throw new Error("Unknown interrupt action: " + handler.action);
  }
}

export async function runEvaluation() {
  {{#hasArgs}}
  let result = await {{{nodeName:string}}}({{{args?:string}}});
  {{/hasArgs}}
  {{^hasArgs}}
  let result = await {{{nodeName:string}}}();
  {{/hasArgs}}

  {{#hasInterruptHandlers}}
  const interruptHandlers = {{{interruptHandlersJSON?:string}}};
  let handlerIndex = 0;

  while (isInterrupt(result.data) || isInterruptBatch(result.data)) {
    const batch = isInterruptBatch(result.data)
      ? result.data
      : { interrupts: [result.data], checkpoint: result.data.checkpoint };
    const interrupts = batch.interrupts;

    if (handlerIndex + interrupts.length > interruptHandlers.length) {
      throw new Error("Unexpected interrupt(s) starting at #" + (handlerIndex + 1) + ". Not enough handlers provided.");
    }

    const responses: Record<string, any> = {};
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

    result = await respondToInterrupts(batch.checkpoint, responses);
  }

  // Check if we provided more handlers than interrupts that occurred
  if (handlerIndex < interruptHandlers.length) {
    throw new Error(
      "Expected " + interruptHandlers.length + " interrupts but only " + handlerIndex + " occurred."
    );
  }
  {{/hasInterruptHandlers}}

  writeFileSync("__evaluate.json", JSON.stringify(result, null, 2));
  return result;
}

runEvaluation();
`;

export type TemplateType = {
  nodeName: string;
  filename: string;
  hasArgs: boolean;
  args?: string;
  hasInterruptHandlers: boolean;
  interruptHandlersJSON?: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    
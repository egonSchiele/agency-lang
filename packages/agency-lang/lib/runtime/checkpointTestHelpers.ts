import { Checkpoint } from "./state/checkpointStore.js";
import { GlobalStore } from "./state/globalStore.js";
import { StateStack } from "./state/stateStack.js";

export function makeCheckpoint(
  locals: Record<string, unknown> = {},
  args: Record<string, unknown> = {},
): Checkpoint {
  const stack = new StateStack();
  stack.nodesTraversed = ["main"];
  const frame = stack.getNewState();
  frame.locals = locals;
  frame.args = args;
  frame.scopeName = "main";
  frame.moduleId = "";

  return new Checkpoint({
    stack: stack.toJSON(),
    globals: new GlobalStore().toJSON(),
    nodeId: "main",
    moduleId: "",
    scopeName: "main",
    stepPath: "0",
  });
}

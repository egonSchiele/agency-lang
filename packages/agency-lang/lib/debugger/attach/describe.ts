// What a party answered, in a few words: the activity line every party
// sees (`cli: step`, `terminal: set x = 5`) and the `answered` message a
// late reply is sent. One function of the request's method and the
// reply's result, so the terminal pane and the CLI's `where` print the
// same thing.
import type { DebuggerCommand } from "../types.js";
import type { RequestMethod } from "./protocol.js";

const VALUE_LIMIT = 40;

function shortJson(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT - 1)}…` : text;
}

/** A debugger command as the activity line words it. A reply that is
 *  not a command at all (the run refuses it next) is shown as it came. */
export function describeCommand(command: DebuggerCommand): string {
  if (typeof command !== "object" || command === null || typeof command.type !== "string") {
    return shortJson(command);
  }
  switch (command.type) {
    case "step":
    case "next":
    case "continue":
    case "rewind":
    case "approve":
    case "quit":
      return command.type;
    case "stepIn":
      return "step in";
    case "stepOut":
      return "step out";
    case "stepBack":
      return "step back";
    case "showCheckpoints":
      return "checkpoints";
    case "checkpoint":
      return command.label === undefined ? "checkpoint" : `checkpoint ${command.label}`;
    case "set":
      return `set ${command.varName} = ${shortJson(command.value)}`;
    case "modify":
      return `set ${Object.keys(command.overrides).join(", ")}`;
    case "reject":
      return command.value === undefined ? "reject" : `reject ${shortJson(command.value)}`;
    case "resolve":
      return `resolve ${shortJson(command.value)}`;
    case "save":
      return `save ${command.path}`;
    case "load":
      return `load ${command.path}`;
    default:
      return shortJson(command);
  }
}

/** The reply to `method`, as the activity line words it. */
export function describeAnswer(method: RequestMethod, result: unknown): string {
  switch (method) {
    case "waitForCommand":
      return describeCommand(result as DebuggerCommand);
    case "render":
      return "saw the stop";
    case "showRewindSelector":
      return result === null ? "closed the rewind picker" : `rewind to #${String(result)}`;
    case "answerGuardTrip": {
      const response = result as { type: "approve" | "reject"; value?: unknown };
      if (response.type === "reject") {
        return "rejected the guard trip";
      }
      return `approved the guard trip ${shortJson(response.value ?? {})}`;
    }
    case "showCheckpointsPanel":
      return "closed the checkpoints panel";
    case "promptForNodeArgs":
      return "gave the node its arguments";
    case "promptForInput":
      return `answered ${shortJson(result)}`;
  }
}

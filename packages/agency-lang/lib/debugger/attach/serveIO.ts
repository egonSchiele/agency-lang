// The UI side of the channel: turns each request from the run into the
// matching call on a real `DebuggerIO`, the terminal UI or a scripted one
// in a test, and sends the reply. The three messages that are not
// methods go to the `events` callbacks.
import type { PendingPreview } from "../edits/rows.js";
import { functionRefReviver, nativeTypeReviver } from "../../runtime/revivers/index.js";
import { Checkpoint } from "../../runtime/state/checkpointStore.js";
import { isBusyEntry } from "../../runtime/waits.js";
import { RequestWithdrawn, type BusyEntry, type DebuggerIO } from "../types.js";
import type { Channel } from "./channel.js";
import { parseAttachMessage, type Hello } from "./protocol.js";

export type ServeEvents = {
  hello?: (hello: Hello) => void;
  /** The program ended, with `value`, or by throwing `error`. */
  finished?: (value: unknown, error?: string) => void;
  refused?: (reason: string) => void;
  /** A message that is not one of ours; the sender is a bug. */
  malformed?: (message: unknown) => void;
};

/** A checkpoint as the run sent it, rebuilt. A frame holds a function
 *  value whenever the program passed a block or kept a function in a
 *  variable, and reviving one needs a registry, which only a compiled
 *  module sets as it loads. The debugger's process loads no program, so
 *  an empty registry is set here: every function then revives to the
 *  stub a miss gives, which is all a UI that shows the state needs. */
export function checkpointFromWire(wire: unknown): Checkpoint | undefined {
  if (wire === undefined || wire === null) {
    return undefined;
  }
  functionRefReviver.registry ??= {};
  const revived = JSON.parse(JSON.stringify(wire), nativeTypeReviver);
  return Checkpoint.fromJSON(revived) ?? undefined;
}

function checkpointsFromWire(wire: unknown): Checkpoint[] {
  if (!Array.isArray(wire)) {
    return [];
  }
  return wire.map(checkpointFromWire).filter((cp): cp is Checkpoint => cp !== undefined);
}

/** Answer the run's requests with `io` until the channel closes. Returns
 *  the function that stops listening. */
export function serveDebuggerIO(channel: Channel, io: DebuggerIO, events: ServeEvents = {}) {
  // A terminal's connection is its session: the run sees it as one party
  // that stays until it closes.
  channel.send({ type: "client", kind: "terminal" });
  // The one message the UI sends unprompted: the person asked the
  // running program to stop at its next statement.
  io.onPause(() => channel.send({ type: "pause" }));
  const answer = async (id: number, method: string, args: unknown[]): Promise<unknown> => {
    switch (method) {
      case "render":
        return await io.render(checkpointFromWire(args[0]), args[1] as never, args[2] as never);
      case "waitForCommand":
        return await io.waitForCommand();
      case "showRewindSelector":
        return await io.showRewindSelector(checkpointsFromWire(args[0]));
      case "answerGuardTrip":
        return await io.answerGuardTrip(args[0] as never);
      case "showCheckpointsPanel":
        return await io.showCheckpointsPanel(checkpointsFromWire(args[0]));
      case "promptForNodeArgs":
        return await io.promptForNodeArgs(args[0] as never);
      case "promptForInput":
        return await io.promptForInput(args[0] as string);
      default:
        throw new Error(`unknown request ${method} (id ${id})`);
    }
  };
  // The requests being answered, by id, and the ones another party
  // answered first, whose reply is not sent.
  const inFlight: Record<number, true> = {};
  const withdrawn: Record<number, true> = {};
  const notice = (method: string, args: unknown[]): void => {
    switch (method) {
      case "log":
        io.log(args[0] as string);
        return;
      case "setMode":
        io.setMode(args[0] as never);
        return;
      case "setPending":
        io.setPending(args[0] as PendingPreview);
        return;
      case "setBusy": {
        // The sender is the other half of this package, so a bad entry
        // is a bug; it is dropped here rather than thrown on in the UI.
        const entries: BusyEntry[] = Array.isArray(args[0]) ? args[0].filter(isBusyEntry) : [];
        io.setBusy(entries);
        return;
      }
      case "appendStdout":
        io.appendStdout(args[0] as string);
        return;
      case "renderActivityOnly":
        io.renderActivityOnly();
        return;
      case "startSpinner":
        io.startSpinner();
        return;
      case "stopSpinner":
        io.stopSpinner();
        return;
    }
  };
  return channel.onMessage((raw) => {
    const message = parseAttachMessage(raw);
    if (message === null) {
      events.malformed?.(raw);
      return;
    }
    switch (message.type) {
      case "hello":
        events.hello?.(message);
        return;
      case "finished":
        events.finished?.(message.value, message.error);
        return;
      case "refused":
        events.refused?.(message.reason);
        return;
      case "notice":
        notice(message.method, message.args);
        return;
      case "request":
        inFlight[message.id] = true;
        void answer(message.id, message.method, message.args).then(
          (result) => {
            delete inFlight[message.id];
            if (withdrawn[message.id] === undefined) {
              channel.send({ type: "reply", id: message.id, result });
            }
          },
          (error: unknown) => {
            delete inFlight[message.id];
            if (withdrawn[message.id] !== undefined || error instanceof RequestWithdrawn) {
              return;
            }
            channel.send({
              type: "reply",
              id: message.id,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        );
        return;
      case "answered":
        // The activity line has already said who answered; what is left
        // is to stop the read this UI is inside for that request.
        if (inFlight[message.id] !== undefined) {
          withdrawn[message.id] = true;
          io.withdraw?.();
        }
        return;
      case "parties":
        io.setParties?.({ terminal: message.terminal, cli: message.cli });
        return;
      case "reply":
      case "pause":
      case "detach":
      case "client":
      case "status":
        return;
    }
  });
}

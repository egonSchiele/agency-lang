// The run side of `agency attach`: a client that watches a program and
// answers the questions it holds (docs/dev/runtime/spawn.md). A watching
// client is not a party to a debugger session, and serving one never
// installs a debugger, so the program does not stop for it.
import { answerHeld, heldQuestions, onHeldChange } from "../../runtime/heldQuestions.js";
import type { Channel } from "./channel.js";
import { parseAttachMessage } from "./protocol.js";

/** Serve one watching client on `channel`: tell it what is held now and
 *  each time that changes, and pass its answers to `answerHeld`. */
export function serveWatch(channel: Channel): void {
  channel.send({ type: "held", questions: heldQuestions() });
  const stopListening = onHeldChange((questions) => channel.send({ type: "held", questions }));
  channel.onClose(stopListening);
  channel.onMessage((raw) => {
    const message = parseAttachMessage(raw);
    if (message === null || message.type !== "answers") {
      return;
    }
    const refused = answerHeld(message.answers);
    if (refused !== null) {
      // The batch is still held, or another client answered it first.
      // Saying what is held now lets this client ask again or stand down.
      channel.send({ type: "answersRefused", reason: refused });
      channel.send({ type: "held", questions: heldQuestions() });
    }
  });
}

// The run side of `agency attach`, on an in-memory channel pair.
import { afterEach, describe, expect, it } from "vitest";
import { answerHeld, heldQuestions, holdForAnswers } from "../../runtime/heldQuestions.js";
import { approve, reject } from "../../runtime/interruptResponse.js";
import { interrupt } from "../../runtime/interrupts.js";
import type { Interrupt } from "../../runtime/interrupts.js";
import { memoryChannelPair, type Channel } from "./channel.js";
import type { AttachMessage } from "./protocol.js";
import { serveWatch } from "./watch.js";

function question(interruptId: string): Interrupt {
  return interrupt({
    effect: "test::ask",
    message: "May I?",
    data: { id: interruptId },
    origin: "test",
    runId: "run-1",
    interruptId,
  });
}

/** A watching client: the messages it was sent, in order. */
function client(): { channel: Channel; received: AttachMessage[] } {
  const [runSide, clientSide] = memoryChannelPair();
  const received: AttachMessage[] = [];
  clientSide.onMessage((message) => received.push(message as AttachMessage));
  serveWatch(runSide);
  return { channel: clientSide, received };
}

/** The memory channel delivers on a microtask. */
const delivered = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  const left = heldQuestions();
  if (left.length > 0) {
    answerHeld(left.map((held) => ({ interruptId: held.interruptId, response: reject() })));
  }
});

describe("serving a watching client", () => {
  it("says on connect that nothing is held", async () => {
    const { received } = client();
    await delivered();
    expect(received).toEqual([{ type: "held", questions: [] }]);
  });

  it("says what is held when a batch starts, and that nothing is when it is answered", async () => {
    const { channel, received } = client();
    const waiting = holdForAnswers([question("a")]);
    await delivered();
    expect(received[1]).toMatchObject({
      type: "held",
      questions: [{ interruptId: "a", effect: "test::ask", message: "May I?", data: { id: "a" } }],
    });

    channel.send({ type: "answers", answers: [{ interruptId: "a", response: approve("yes") }] });
    expect(await waiting).toEqual([approve("yes")]);
    await delivered();
    expect(received[2]).toEqual({ type: "held", questions: [] });
  });

  it("refuses bad answers with the reason, repeats what is held, and keeps holding", async () => {
    const { channel, received } = client();
    void holdForAnswers([question("a")]);
    await delivered();
    channel.send({ type: "answers", answers: [{ interruptId: "z", response: approve() }] });
    await delivered();
    expect(received[2]).toMatchObject({ type: "answersRefused", reason: expect.any(String) });
    expect(received[3]).toMatchObject({ type: "held", questions: [{ interruptId: "a" }] });
    expect(heldQuestions()).toHaveLength(1);
  });

  it("gives the batch to the first of two clients, and refuses the second", async () => {
    const first = client();
    const second = client();
    const waiting = holdForAnswers([question("a")]);
    await delivered();
    first.channel.send({ type: "answers", answers: [{ interruptId: "a", response: approve() }] });
    second.channel.send({ type: "answers", answers: [{ interruptId: "a", response: reject() }] });
    expect(await waiting).toEqual([approve()]);
    await delivered();
    expect(second.received).toContainEqual({ type: "answersRefused", reason: "nothing is held" });
    expect(second.received.at(-1)).toEqual({ type: "held", questions: [] });
  });

  it("stops telling a client that closed", async () => {
    const { channel, received } = client();
    await delivered();
    channel.close();
    const waiting = holdForAnswers([question("a")]);
    await delivered();
    expect(received).toHaveLength(1);
    answerHeld([{ interruptId: "a", response: approve() }]);
    await waiting;
  });
});

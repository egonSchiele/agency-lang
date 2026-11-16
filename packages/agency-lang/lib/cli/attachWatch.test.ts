// The client side of `agency attach`, against an in-memory channel whose
// other end plays the program.
import { describe, expect, it } from "vitest";
import { memoryChannelPair, type Channel } from "@/debugger/attach/channel.js";
import type { AttachMessage } from "@/debugger/attach/protocol.js";
import { approve, reject } from "@/runtime/interruptResponse.js";
import type { DecideFn } from "@/runtime/interruptResolution.js";
import type { SerializedInterrupt } from "@/runtime/ipcChild.js";
import { PromptClosed, watch } from "./attachWatch.js";

function question(interruptId: string, expectsValue = false): SerializedInterrupt {
  return {
    type: "interrupt",
    interruptId,
    runId: "run-1",
    effect: "test::ask",
    message: "May I?",
    data: {},
    origin: "test",
    ...(expectsValue ? { expectsValue: true } : {}),
  };
}

/** Start a watch and return the program's end of the channel, what the
 *  program was sent, and what the person was shown. */
function watching(decide: DecideFn): {
  program: Channel;
  sent: AttachMessage[];
  shown: string[];
  ended: Promise<void>;
} {
  const [program, client] = memoryChannelPair();
  const sent: AttachMessage[] = [];
  const shown: string[] = [];
  program.onMessage((message) => sent.push(message as AttachMessage));
  const ended = watch({ channel: client, out: (text) => shown.push(text), decide });
  return { program, sent, shown, ended };
}

const delivered = () => new Promise((resolve) => setImmediate(resolve));

describe("agency attach", () => {
  it("says it is a watching client, never a debugger", async () => {
    const { sent } = watching(async () => approve());
    await delivered();
    expect(sent).toEqual([{ type: "client", kind: "watch" }]);
  });

  it("answers a batch of two questions with one message, in order", async () => {
    const asked: string[] = [];
    const { program, sent } = watching(async (interrupt) => {
      asked.push(interrupt.interruptId);
      return interrupt.interruptId === "a" ? approve() : reject("not b");
    });
    program.send({ type: "held", questions: [question("a"), question("b")] });
    await delivered();
    await delivered();
    expect(asked).toEqual(["a", "b"]);
    expect(sent.slice(1)).toEqual([
      {
        type: "answers",
        answers: [
          { interruptId: "a", response: { type: "approve" } },
          { interruptId: "b", response: { type: "reject", value: "not b" } },
        ],
      },
    ]);
  });

  it("carries the value of an approval", async () => {
    const { program, sent } = watching(async (interrupt) =>
      interrupt.expectsValue ? approve("blue") : reject(),
    );
    program.send({ type: "held", questions: [question("a", true)] });
    await delivered();
    await delivered();
    expect(sent[1]).toEqual({
      type: "answers",
      answers: [{ interruptId: "a", response: { type: "approve", value: "blue" } }],
    });
  });

  it("sends nothing for an empty batch", async () => {
    const { program, sent } = watching(async () => approve());
    program.send({ type: "held", questions: [] });
    await delivered();
    await delivered();
    expect(sent).toHaveLength(1);
  });

  // Ctrl-C or Ctrl-D at a prompt. The program must get no answer at all:
  // a rejection the person never chose could not be undone.
  it("detaches, sending no answers, when a prompt closes without an answer", async () => {
    const { program, sent, shown, ended } = watching(async () => {
      throw new PromptClosed();
    });
    program.send({ type: "held", questions: [question("a"), question("b")] });
    await ended;
    await delivered();
    expect(sent).toEqual([{ type: "client", kind: "watch" }]);
    expect(shown).toEqual(["Detached without answering. The program is still waiting."]);
  });

  it("skips a batch another client answered while a prompt was open", async () => {
    const asked: string[] = [];
    let release: () => void = () => {};
    const { program, sent } = watching(async (interrupt) => {
      asked.push(interrupt.interruptId);
      if (interrupt.interruptId === "a") {
        await new Promise<void>((resolve) => (release = resolve));
      }
      return approve();
    });
    program.send({ type: "held", questions: [question("a")] });
    await delivered();
    // While "a" is being asked, another client answers it, the program
    // holds "b", another client answers that too, and it then holds "c".
    program.send({ type: "held", questions: [] });
    program.send({ type: "held", questions: [question("b")] });
    program.send({ type: "held", questions: [] });
    program.send({ type: "held", questions: [question("c")] });
    await delivered();
    release();
    await delivered();
    await delivered();
    expect(asked).toEqual(["a", "c"]);
    expect(sent.at(-1)).toMatchObject({ type: "answers", answers: [{ interruptId: "c" }] });
  });

  it("shows why the program refused the answers", async () => {
    const { program, shown } = watching(async () => approve());
    program.send({ type: "answersRefused", reason: "nothing is held" });
    await delivered();
    expect(shown).toEqual(["The program refused the answers: nothing is held"]);
  });

  it("ends when the connection closes", async () => {
    const { program, shown, ended } = watching(async () => approve());
    program.close();
    await ended;
    expect(shown).toEqual(["The program ended or closed the connection."]);
  });
});

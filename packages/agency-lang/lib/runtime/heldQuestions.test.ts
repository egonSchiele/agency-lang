import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answerHeld,
  heldQuestions,
  holdForAnswers,
  holdNotice,
  onHeldChange,
} from "./heldQuestions.js";
import { approve, reject } from "./interruptResponse.js";
import type { InterruptResponse } from "./interruptResponse.js";
import { interrupt } from "./interrupts.js";
import type { Interrupt } from "./interrupts.js";
import { withoutCheckpoint } from "./ipcChild.js";

function question(interruptId: string, expectsValue = false): Interrupt {
  return interrupt({
    effect: "test::ask",
    message: "May I?",
    data: { id: interruptId },
    origin: "test",
    runId: "run-1",
    interruptId,
    expectsValue,
  });
}

/** The held batch lives on `process`, so a test that leaves one held would
 *  leak it into the next. */
afterEach(() => {
  const left = heldQuestions();
  if (left.length > 0) {
    answerHeld(left.map((held) => ({ interruptId: held.interruptId, response: reject() })));
  }
});

/** Whether `promise` has settled by the time the pending microtasks ran. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

describe("holding a batch", () => {
  it("does not resolve until answerHeld accepts", async () => {
    const waiting = holdForAnswers([question("a")]);
    expect(await settled(waiting)).toBe(false);
    expect(answerHeld([{ interruptId: "a", response: approve() }])).toBeNull();
    expect(await waiting).toEqual([approve()]);
  });

  it("returns the batch as data while held, and an empty list after", async () => {
    const waiting = holdForAnswers([question("a"), question("b")]);
    expect(heldQuestions().map((held) => held.interruptId)).toEqual(["a", "b"]);
    expect(heldQuestions()[0]).toMatchObject({ effect: "test::ask", message: "May I?" });
    answerHeld([
      { interruptId: "a", response: approve() },
      { interruptId: "b", response: approve() },
    ]);
    await waiting;
    expect(heldQuestions()).toEqual([]);
  });

  it("refuses when nothing is held", () => {
    expect(answerHeld([{ interruptId: "a", response: approve() }])).toBe("nothing is held");
  });

  it("refuses a missing answer, an extra answer, and an unknown id, and stays held", async () => {
    const waiting = holdForAnswers([question("a"), question("b")]);
    const yes: InterruptResponse = approve();
    expect(answerHeld([{ interruptId: "a", response: yes }])).toContain("b has no answer");
    expect(
      answerHeld([
        { interruptId: "a", response: yes },
        { interruptId: "b", response: yes },
        { interruptId: "c", response: yes },
      ]),
    ).toContain("id c");
    expect(
      answerHeld([
        { interruptId: "a", response: yes },
        { interruptId: "a", response: yes },
        { interruptId: "b", response: yes },
      ]),
    ).toContain("more than once");
    expect(await settled(waiting)).toBe(false);
    expect(heldQuestions()).toHaveLength(2);
  });

  it("refuses a response that is neither an approval nor a rejection", async () => {
    const waiting = holdForAnswers([question("a")]);
    const bad = { type: "propagate" } as unknown as InterruptResponse;
    expect(answerHeld([{ interruptId: "a", response: bad }])).not.toBeNull();
    expect(await settled(waiting)).toBe(false);
  });

  it("puts the responses in the order of the questions", async () => {
    const waiting = holdForAnswers([question("a", true), question("b")]);
    answerHeld([
      { interruptId: "b", response: reject("not that one") },
      { interruptId: "a", response: approve("typed") },
    ]);
    expect(await waiting).toEqual([approve("typed"), reject("not that one")]);
  });

  it("refuses a second batch while one is held", () => {
    void holdForAnswers([question("a")]);
    expect(() => holdForAnswers([question("b")])).toThrow("already held");
    expect(heldQuestions().map((held) => held.interruptId)).toEqual(["a"]);
  });

  it("is still answered when a listener throws, and tells the listeners after it", async () => {
    const seen: number[] = [];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const removeBad = onHeldChange(() => {
      throw new Error("listener broke");
    });
    const removeGood = onHeldChange((questions) => seen.push(questions.length));
    try {
      const waiting = holdForAnswers([question("a")]);
      expect(answerHeld([{ interruptId: "a", response: approve() }])).toBeNull();
      expect(await waiting).toEqual([approve()]);
      expect(seen).toEqual([1, 0]);
    } finally {
      removeBad();
      removeGood();
      err.mockRestore();
    }
  });

  it("calls a listener when a batch starts and when it ends, until removed", async () => {
    const seen: number[] = [];
    const remove = onHeldChange((questions) => seen.push(questions.length));
    const waiting = holdForAnswers([question("a")]);
    answerHeld([{ interruptId: "a", response: approve() }]);
    await waiting;
    expect(seen).toEqual([1, 0]);
    remove();
    const again = holdForAnswers([question("b")]);
    answerHeld([{ interruptId: "b", response: approve() }]);
    await again;
    expect(seen).toEqual([1, 0]);
  });
});

describe("holdNotice", () => {
  const facts = { questionCount: 1, pid: 48213, canAttach: true, resumeCommand: null };
  const resumeCommand = "agency resume /h/held/t-1.json <program> --wait-for-response";

  it("names the attach command when the program can be attached to", () => {
    expect(holdNotice(facts)).toBe(
      "[agency] Waiting for an answer to 1 question. Run: agency attach 48213",
    );
    expect(holdNotice({ ...facts, questionCount: 2 })).toContain("2 questions");
  });

  it("says nothing can answer when nothing can attach and no checkpoint was saved", () => {
    expect(holdNotice({ ...facts, canAttach: false })).toBe(
      "[agency] Waiting for an answer to 1 question. Nothing can attach to this process, so nothing can answer. Stop it with: kill 48213",
    );
  });

  it("says to stop and resume when nothing can attach and a checkpoint was saved", () => {
    const text = holdNotice({ ...facts, canAttach: false, resumeCommand });
    expect(text.split("\n")).toEqual([
      "[agency] Waiting for an answer to 1 question. Nothing can attach to this process. Stop it with: kill 48213, then resume it.",
      "If this process stops, resume it with: agency resume /h/held/t-1.json <program> --wait-for-response",
    ]);
  });

  it("adds the resume line whenever a checkpoint was saved", () => {
    const text = holdNotice({ ...facts, resumeCommand });
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("agency attach 48213");
  });
});

describe("withoutCheckpoint", () => {
  it("drops the two checkpoint fields and keeps expectsValue", () => {
    const withFields = { ...question("a", true), checkpoint: { id: 1 }, checkpointId: 1 };
    const data = withoutCheckpoint(withFields);
    expect(data).not.toHaveProperty("checkpoint");
    expect(data).not.toHaveProperty("checkpointId");
    expect(data.expectsValue).toBe(true);
    expect(data.interruptId).toBe("a");
  });
});

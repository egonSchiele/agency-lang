// The batch of interrupts a program run with `--wait-for-response` is
// holding: questions nobody settled, kept until a client of the debug socket
// answers all of them (docs/dev/runtime/spawn.md). This file holds the
// batch and checks the answers. It writes nothing and decides nothing.

import { withoutCheckpoint, type SerializedInterrupt } from "./ipcChild.js";
import { validateResumeBatch, type Interrupt } from "./interrupts.js";
import type { InterruptResponse } from "./interruptResponse.js";
import { processSlot } from "./processSlot.js";

/** One answer to a held question. */
export type HeldAnswer = {
  interruptId: string;
  response: InterruptResponse;
};

type HeldListener = (questions: SerializedInterrupt[]) => void;

type HeldBatch = {
  interrupts: Interrupt[];
  answered: (responses: InterruptResponse[]) => void;
};

type HeldState = {
  batch: HeldBatch | null;
  listeners: HeldListener[];
};

/** How often the timer that keeps a holding process alive fires. The timer
 *  does nothing; it exists because a process waiting on a promise with no
 *  open handle exits, and the debug socket is `unref`ed. */
const HOLD_KEEP_ALIVE_MS = 60_000;

/** One per process, like the socket that answers it: the root endpoint of
 *  a command-line run is one per process, and every copy of the runtime in
 *  the process must see the same batch. */
const held = processSlot<HeldState>("agency.heldQuestions", () => ({
  batch: null,
  listeners: [],
}));

function announce(): void {
  const questions = heldQuestions();
  for (const listener of held.get().listeners) {
    // A listener that throws must not keep the batch from being held or
    // answered, or keep the listeners after it from hearing.
    try {
      listener(questions);
    } catch (error) {
      console.error(`[agency] a held-question listener failed: ${String(error)}`);
    }
  }
}

/** Hold `interrupts` until `answerHeld` is given a valid set of answers.
 *  Keeps the process alive while it waits. */
export function holdForAnswers(interrupts: Interrupt[]): Promise<InterruptResponse[]> {
  // A process has one root endpoint, so one batch at a time. A second
  // would replace the first, whose caller would then wait for ever.
  if (held.get().batch !== null) {
    throw new Error("a batch of questions is already held in this process");
  }
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, HOLD_KEEP_ALIVE_MS);
    held.get().batch = {
      interrupts,
      answered: (responses) => {
        clearInterval(keepAlive);
        resolve(responses);
      },
    };
    announce();
  });
}

/** The questions held right now, or an empty list. */
export function heldQuestions(): SerializedInterrupt[] {
  return (held.get().batch?.interrupts ?? []).map(withoutCheckpoint);
}

/** The reason `answers` is not exactly one answer per held interrupt, or
 *  null. */
function mismatch(interrupts: Interrupt[], answers: HeldAnswer[]): string | null {
  const heldIds = interrupts.map((interrupt) => interrupt.interruptId);
  const answeredIds = answers.map((answer) => answer.interruptId);
  const unknown = answeredIds.find((id) => !heldIds.includes(id));
  if (unknown !== undefined) {
    return `no held question has the id ${unknown}`;
  }
  const missing = heldIds.find((id) => !answeredIds.includes(id));
  if (missing !== undefined) {
    return `the question ${missing} has no answer`;
  }
  if (answeredIds.length !== heldIds.length) {
    return "a question was answered more than once";
  }
  return null;
}

/** Answer the held batch. Returns null when the answers were accepted, or
 *  the reason they were refused. A refusal leaves the batch held. */
export function answerHeld(answers: HeldAnswer[]): string | null {
  const state = held.get();
  const batch = state.batch;
  if (batch === null) {
    return "nothing is held";
  }
  const refused = mismatch(batch.interrupts, answers);
  if (refused !== null) {
    return refused;
  }
  const responses = batch.interrupts.map(
    (interrupt) => answers.find((answer) => answer.interruptId === interrupt.interruptId)!.response,
  );
  const invalid = validateResumeBatch(batch.interrupts, responses);
  if (invalid !== null) {
    return invalid;
  }
  state.batch = null;
  announce();
  batch.answered(responses);
  return null;
}

/** Calls `listener` each time a batch starts or stops being held.
 *  Returns a function that removes the listener. */
export function onHeldChange(listener: HeldListener): () => void {
  const state = held.get();
  state.listeners = [...state.listeners, listener];
  return () => {
    state.listeners = state.listeners.filter((other) => other !== listener);
  };
}

/** What `holdNotice` words its lines from. */
export type HoldFacts = {
  questionCount: number;
  pid: number;
  /** Whether the program registered for attach. */
  canAttach: boolean;
  /** The command that resumes from the batch's saved checkpoint, or null
   *  when none was saved. */
  resumeCommand: string | null;
};

/** How a person can answer, given whether anything can attach and whether
 *  a checkpoint was saved. */
function howToAnswer(facts: HoldFacts): string {
  if (facts.canAttach) {
    return `Run: agency attach ${facts.pid}`;
  }
  if (facts.resumeCommand !== null) {
    return `Nothing can attach to this process. Stop it with: kill ${facts.pid}, then resume it.`;
  }
  return `Nothing can attach to this process, so nothing can answer. Stop it with: kill ${facts.pid}`;
}

/** The lines a program writes when it starts to hold a batch. */
export function holdNotice(facts: HoldFacts): string {
  const noun = facts.questionCount === 1 ? "question" : "questions";
  const lines = [
    `[agency] Waiting for an answer to ${facts.questionCount} ${noun}. ${howToAnswer(facts)}`,
  ];
  if (facts.resumeCommand !== null) {
    lines.push(`If this process stops, resume it with: ${facts.resumeCommand}`);
  }
  return lines.join("\n");
}

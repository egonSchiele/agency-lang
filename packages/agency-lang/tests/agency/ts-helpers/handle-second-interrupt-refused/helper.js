import { agency } from "agency-lang/runtime";

const first = { effect: "test::first", message: "first", data: { asked: "first" } };
const second = { effect: "test::second", message: "second", data: { asked: "second" } };

// Raises twice through one handle, one after the other. Every raise through
// a handle is stored under one key, so on resume the second raise would get
// the first one's answer with nobody asked. The handle refuses it.
export async function askOneAfterTheOther() {
  const run = agency.current();
  const firstAnswer = await run.interrupt(first);
  let secondRaise = "raised";
  try {
    await run.interrupt(second);
  } catch (error) {
    secondRaise = String(error.message).includes("already raised an interrupt")
      ? "refused"
      : `another error: ${error.message}`;
  }
  return { firstAnswer: firstAnswer.type, secondRaise };
}

// Raises two interrupts at once. Neither has been answered when the other
// starts, so both are allowed.
export async function askBothAtOnce() {
  const run = agency.current();
  const answers = await Promise.all([run.interrupt(first), run.interrupt(second)]);
  return answers.map((answer) => answer.type);
}

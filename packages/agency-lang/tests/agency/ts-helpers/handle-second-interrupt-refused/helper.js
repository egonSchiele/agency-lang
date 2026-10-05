import { agency } from "agency-lang/runtime";

const first = { effect: "test::first", message: "first", data: { asked: "first" } };
const second = { effect: "test::second", message: "second", data: { asked: "second" } };

// What a refused raise reports, or the message of any other error.
function describeError(error) {
  return String(error.message).includes("already raised an interrupt")
    ? "refused"
    : `another error: ${error.message}`;
}

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
    secondRaise = describeError(error);
  }
  return { firstAnswer: firstAnswer.type, secondRaise };
}

// Raises two interrupts at the same time. They would share the one key too:
// if neither were answered by a handler, only the second would reach the
// user, and both raises would get its answer. The handle refuses the second.
export async function askBothAtOnce() {
  const run = agency.current();
  const [firstRaise, secondRaise] = await Promise.allSettled([
    run.interrupt(first),
    run.interrupt(second),
  ]);
  return {
    firstAnswer: firstRaise.status === "fulfilled" ? firstRaise.value.type : "not answered",
    secondRaise: secondRaise.status === "rejected" ? describeError(secondRaise.reason) : "raised",
  };
}

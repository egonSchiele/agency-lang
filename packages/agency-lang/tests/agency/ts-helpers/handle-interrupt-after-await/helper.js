import { agency } from "agency-lang/runtime";

// Takes the run on its first line, waits on a timer, and then raises an
// interrupt through the handle. `agency.interrupt()` would throw here,
// because it reads the current run and the wait has already happened.
export async function raiseLater(effect) {
  const run = agency.current();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const response = await run.interrupt({
    effect,
    message: "needs approval",
    data: { asked: "after the wait" },
  });
  return response;
}

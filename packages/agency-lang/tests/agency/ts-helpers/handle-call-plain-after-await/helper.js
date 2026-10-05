import { agency } from "agency-lang/runtime";

// After an await, `agency.*` has no current run to read. `run.call` calls a
// plain function with the run current again, so that function's own first
// line can use `agency.*`.
export async function messagesAfterWait() {
  const run = agency.current();
  await new Promise((resolve) => setTimeout(resolve, 5));

  let direct = "worked";
  try {
    agency.thread.user("pushed directly");
  } catch (error) {
    // Only the missing-run error counts. Any other error is a different bug.
    direct = String(error.message).includes("No run is current here")
      ? "threw"
      : `another error: ${error.message}`;
  }

  await run.call(() => agency.thread.user("pushed through the handle"));
  const count = await run.call(() => agency.thread.current().getMessages().length);
  return { direct, count };
}

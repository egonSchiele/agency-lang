import { currentRun, currentRunOrNone } from "./runtime/asyncContext.js";

const wait = () => new Promise((resolve) => setTimeout(resolve, 1));

export async function readOnFirstLine() {
  const run = currentRun();
  await wait();
  return run;
}

export async function optedOut() {
  await wait();
  // run-read-ok: with no run current, the default name is used.
  return currentRunOrNone()?.name ?? "none";
}

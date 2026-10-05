import { currentRun } from "./runtime/renamed.js";

export async function readAfterAwait() {
  await Promise.resolve();
  return currentRun();
}

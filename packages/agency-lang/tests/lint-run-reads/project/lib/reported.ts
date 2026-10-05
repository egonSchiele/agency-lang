import { currentRun } from "./runtime/asyncContext.js";

const wait = () => new Promise((resolve) => setTimeout(resolve, 1));

function readsOnEntry() {
  return currentRun();
}

const interrupt = () => currentRun();
const agency = { interrupt };

export async function readAfterAwait() {
  await wait();
  return currentRun(); // expect: reported
}

export async function callAfterAwait() {
  await wait();
  return readsOnEntry(); // expect: reported
}

export async function readInLoopThatAwaits(names: string[]) {
  for (const name of names) {
    currentRun(); // expect: reported
    await wait();
    console.log(name);
  }
}

export function readInTimer() {
  setTimeout(() => {
    currentRun(); // expect: reported
  }, 1);
}

export async function callThroughNamespaceAfterAwait() {
  await wait();
  return agency.interrupt(); // expect: reported
}

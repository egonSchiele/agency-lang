let safeCallCount = 0;

export function lookupItem(id) {
  safeCallCount++;
  if (safeCallCount % 2 === 1) {
    throw new Error(`Temporary server error, please try again`);
  }
  return { id, name: "Widget" };
}

export function saveItem(item) {
  return { saved: true, item };
}

let flakyWriteCount = 0;

export function flakyWrite(id) {
  flakyWriteCount++;
  if (flakyWriteCount % 2 === 1) {
    throw new Error(`Temporary write error, please try again`);
  }
  return { id, written: true };
}

export function resetCounters() {
  safeCallCount = 0;
  flakyWriteCount = 0;
}

export function throwError() {
  throw new Error(`This tool always fails`);
}
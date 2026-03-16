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

export function resetCounters() {
  safeCallCount = 0;
}

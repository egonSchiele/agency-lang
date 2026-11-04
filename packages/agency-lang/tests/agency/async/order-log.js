// A shared log for the async fixtures. Each fixture records events into it
// from the side call and from the main arm, then reads the order back to
// check what ran beside what. Module state survives an interrupt resume,
// because the test runner resumes in the same process.
let log = [];

export function reset() {
  log = [];
}

export function record(event) {
  log.push(event);
}

export function logText() {
  return log.join(", ");
}

// True when event `first` was recorded before event `second`. False when
// either is missing.
export function before(first, second) {
  const a = log.indexOf(first);
  const b = log.indexOf(second);
  return a !== -1 && b !== -1 && a < b;
}

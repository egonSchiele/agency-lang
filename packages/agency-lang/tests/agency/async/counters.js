// Helpers for the async fixtures in this folder. Each test case runs in its
// own process, so these counters start at zero for every case, and they
// live outside Agency's state, so neither a resume nor a restore() puts
// them back. That is what lets a fixture tell how many times a call ran.
const counts = {};

export function bump(name) {
  counts[name] = (counts[name] ?? 0) + 1;
  return counts[name];
}

export function countOf(name) {
  return counts[name] ?? 0;
}

// Waits a moment, so the main arm is already paused on its interrupt, and
// then throws a plain JavaScript error.
export async function explodeLater() {
  await new Promise((resolve) => setTimeout(resolve, 100));
  throw new Error("side helper blew up");
}

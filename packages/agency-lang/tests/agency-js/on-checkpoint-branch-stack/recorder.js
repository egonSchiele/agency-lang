// Shared between test.js and the agent: the agent calls mark() from inside
// and outside a fork, and the test reads how many checkpoints had been
// reported at each mark.
let count = () => 0;
const marks = [];
export function bindCount(fn) {
  count = fn;
}
export function mark(label) {
  marks.push({ label, count: count() });
}
export function marksSeen() {
  return marks;
}

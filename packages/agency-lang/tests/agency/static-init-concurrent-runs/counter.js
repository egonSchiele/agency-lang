// JS-side counter for the concurrent-runs test. The Agency module's
// static const is computed from this counter. Concurrent `main()`
// calls (and repeated sequential calls in the same process) must
// see the counter at exactly 1, since `__initVar`'s memoization
// caches the in-flight promise across all callers.
let __count = 0;
export function bump() {
  __count++;
  return __count;
}
export function read() {
  return __count;
}
export function reset() {
  __count = 0;
}

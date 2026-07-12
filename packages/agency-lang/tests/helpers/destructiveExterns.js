// Throwing JS externs for the destructive-tracking try-site test. A raw
// JS throw (not a returned failure) is caught by __tryCall; the failure it
// builds must carry destructiveRan when the callee is imported destructive.

export function boomDestructive() {
  throw new Error("destructive extern blew up");
}

export function boomPlain() {
  throw new Error("plain extern blew up");
}

// A benign extern that returns normally — used by the `safe` migration test
// to prove a `safe def` calling an extern still produces destructiveRan false
// (i.e. `safe` is fully inert, exactly like an unmarked def).
export function benign() {
  return "ok";
}

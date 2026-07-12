// Throwing JS externs for the destructive-tracking try-site test. A raw
// JS throw (not a returned failure) is caught by __tryCall; the failure it
// builds must carry destructiveRan when the callee is imported destructive.

export function boomDestructive() {
  throw new Error("destructive extern blew up");
}

export function boomPlain() {
  throw new Error("plain extern blew up");
}

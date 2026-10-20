// The helper behind awaits-helper.agency (waiter.js, named apart from the
// fixture so the compiled awaits-helper.ts beside it is never mistaken for it): `waitForTest` blocks the program
// until the test calls `releaseWaiter`, and `untilWaiting` tells the test
// when the program is blocked.
let release = null;
let notifyWaiting = null;

export function waitForTest() {
  return new Promise((resolve) => {
    release = resolve;
    if (notifyWaiting) notifyWaiting();
  });
}

export function untilWaiting() {
  return new Promise((resolve) => {
    if (release) {
      resolve();
    } else {
      notifyWaiting = resolve;
    }
  });
}

export function releaseWaiter() {
  const pending = release;
  release = null;
  notifyWaiting = null;
  if (pending) pending();
}

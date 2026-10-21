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

// For nested-run.agency: the test sets the module whose `inner` node the
// program's `outer` node runs through this helper.
let innerModule = null;

export function setInnerModule(mod) {
  innerModule = mod;
}

export async function runInner() {
  const result = await innerModule.inner();
  return result.data;
}

// For agent-end-callback.agency: who fired onAgentEnd, in order.
let agentEnds = [];

export function noteAgentEnd(who) {
  agentEnds.push(who);
}

export function agentEndNotes() {
  return agentEnds;
}

export function clearAgentEndNotes() {
  agentEnds = [];
}


// Tools for the tool-tiers behavioral test (new destructive/idempotent
// retry model). `flaky` throws on the first call and succeeds after, so a
// tool wrapping it must STAY callable for the model to retry and win.

let flakyCount = 0;

export function flaky(id) {
  flakyCount++;
  if (flakyCount === 1) {
    throw new Error("temporary error, please retry");
  }
  return { id, ok: true };
}

export function boom() {
  throw new Error("destructive op blew up mid-flight");
}

export function resetCounters() {
  flakyCount = 0;
}

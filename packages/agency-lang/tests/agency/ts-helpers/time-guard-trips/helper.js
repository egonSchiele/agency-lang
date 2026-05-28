import { agency, isGuardExceededError } from "agency-lang/runtime";

// Mirror of cost-guard-trips, for TimeGuard. `agency.withTimeGuard`
// installs a TimeGuard whose AbortController fires after `maxMs`.
// The trip stays latent until a sync point calls `enforceGuards()` —
// `agency.addCost(0)` is the cheapest such sync point, mirroring the
// codegen `prompt.ts` post-call check that drives the trip in
// production paths.
//
// Asserts only `tripped`/`type`/`limit` (not `spent`) — wall-clock
// jitter would flake an exact `spent` assertion.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run() {
  try {
    return await agency.withTimeGuard(10, async () => {
      await sleep(50);
      agency.addCost(0); // sync point to surface the trip
      return { tripped: false };
    });
  } catch (e) {
    if (isGuardExceededError(e)) {
      return { tripped: true, type: e.type, limit: e.limit };
    }
    throw e;
  }
}

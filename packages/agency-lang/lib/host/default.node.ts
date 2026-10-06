// The host a RuntimeContext gets when its caller passed none, on Node.
//
// The runtime imports this file as "#default-host", an entry in the
// "imports" field of package.json that resolves here by default and to
// default.browser.ts when a bundler builds for the browser. It is the one
// place that reads the environment variables the test runner uses to ask
// for a double of part of the host.

import { FakeClock } from "../runtime/clock.js";
import { nodeHost } from "./nodeHost.js";
import type { Host } from "./host.js";

export function defaultHost(): Host {
  // Require exactly "1", not any truthy string. AGENCY_FAKE_CLOCK=0 must
  // disable, not enable — a non-empty "0" is truthy and would surprise. The
  // test runner sets the variable per test case (see lib/cli/util.ts).
  const fakeClock = process.env.AGENCY_FAKE_CLOCK === "1";
  return nodeHost(fakeClock ? { clock: new FakeClock() } : {});
}

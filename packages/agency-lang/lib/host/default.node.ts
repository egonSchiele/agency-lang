// The host a RuntimeContext gets when its caller passed none, on Node.
//
// The runtime imports this file as "#default-host", an entry in the
// "imports" field of package.json that resolves here by default and to
// default.browser.ts when a bundler builds for the browser. It is the one
// place that reads the environment variables the test runner uses to ask
// for a double of part of the host.

import { readFileSync } from "fs";
import { FakeClock } from "../runtime/clock.js";
import { installFetchMock } from "../runtime/fetchMock.js";
import { nodeHost } from "./nodeHost.js";
import type { Host } from "./host.js";

let fetchMocksInstalled = false;

/** Install the fetch mocks when AGENCY_FETCH_MOCKS_FILE names a file, once
 *  per process. The runner writes the resolved mocks (returnFile bodies
 *  already inlined) to a temp file and passes its path — a file, not an
 *  inline env value, so a large response body cannot blow the exec arg/env
 *  size limit (ARG_MAX). Independent of AGENCY_LLM_MOCKS — a test may mock
 *  the network while using a real LLM, or vice versa. This runs when the
 *  first context is built, before any node runs, ahead of any http.ts /
 *  stdlib / interop fetch, by replacing the global `fetch`. */
function installFetchMocksOnce(): void {
  if (fetchMocksInstalled) {
    return;
  }
  fetchMocksInstalled = true;
  const mocksFile = process.env.AGENCY_FETCH_MOCKS_FILE;
  if (mocksFile) {
    installFetchMock(JSON.parse(readFileSync(mocksFile, "utf-8")));
  }
}

export function defaultHost(): Host {
  installFetchMocksOnce();
  // Require exactly "1", not any truthy string. AGENCY_FAKE_CLOCK=0 must
  // disable, not enable — a non-empty "0" is truthy and would surprise. The
  // test runner sets the variable per test case (see lib/cli/util.ts).
  const fakeClock = process.env.AGENCY_FAKE_CLOCK === "1";
  return nodeHost(fakeClock ? { clock: new FakeClock() } : {});
}

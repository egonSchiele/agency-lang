// The host a RuntimeContext gets when its caller passed none, on Node.
//
// The runtime imports this file as "#default-host", an entry in the
// "imports" field of package.json that resolves here by default and to
// default.browser.ts when a bundler builds for the browser. It is the one
// place that reads the environment variables the test runner uses to ask
// for a double of part of the host.

import { readFileSync } from "fs";
import { FakeClock } from "../../runtime/clock.js";
import { fetchMock } from "../../runtime/fetchMock.js";
import { nodeHost, type NodeHostOptions } from "./nodeHost.js";
import type { Host, HostNetwork } from "../host.js";

let mockNetwork: HostNetwork | null | undefined;

/** The network part that answers from the fetch mocks when
 *  AGENCY_FETCH_MOCKS_FILE names a file, read once per process, or null
 *  when it does not. The runner writes the resolved mocks (returnFile
 *  bodies already inlined) to a temp file and passes its path — a file,
 *  not an inline env value, so a large response body cannot blow the exec
 *  arg/env size limit (ARG_MAX). Independent of AGENCY_LLM_MOCKS — a test
 *  may mock the network while using a real LLM, or vice versa. */
function fetchMockNetwork(): HostNetwork | null {
  if (mockNetwork === undefined) {
    const mocksFile = process.env.AGENCY_FETCH_MOCKS_FILE;
    mockNetwork = mocksFile
      ? { fetch: fetchMock(JSON.parse(readFileSync(mocksFile, "utf-8"))) }
      : null;
  }
  return mockNetwork;
}

export function defaultHost(): Host {
  const options: NodeHostOptions = {};
  // Require exactly "1", not any truthy string. AGENCY_FAKE_CLOCK=0 must
  // disable, not enable — a non-empty "0" is truthy and would surprise. The
  // test runner sets the variable per test case (see lib/cli/util.ts).
  if (process.env.AGENCY_FAKE_CLOCK === "1") {
    options.clock = new FakeClock();
  }
  const network = fetchMockNetwork();
  if (network !== null) {
    options.network = network;
  }
  return nodeHost(options);
}

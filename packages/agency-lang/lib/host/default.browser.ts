// The host a RuntimeContext gets when its caller passed none, in a browser.
//
// The runtime imports this file as "#default-host", an entry in the
// "imports" field of package.json that resolves here under the "browser"
// condition and to node/default.node.ts otherwise. An app that wants the
// program to see its own variables, terminal, or fetch passes a host of its
// own through InvocationOptions instead.

import { browserHost } from "./browserHost.js";
import type { Host } from "./host.js";

export function defaultHost(): Host {
  return browserHost();
}

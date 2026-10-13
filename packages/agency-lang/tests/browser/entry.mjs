// What the browser smoke bundle is built from: the compiled program and the
// browser host beside it, so the page can build a host the program's own
// runtime recognizes and hand it to main.
export * from "./hello.js";
export { browserHost } from "agency-lang/host-lib/browserHost.js";

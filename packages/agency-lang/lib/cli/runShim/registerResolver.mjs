// Registers resolver.mjs with Node's module loader, so `agency-lang` resolves
// for a module outside any `node_modules` tree. register.mjs calls this for
// `node --import`, and grading's fallback calls it in the CLI process.
import * as nodeModule from "node:module";
import { resolve } from "./resolver.mjs";

export function registerAgencyLangResolver() {
  if (typeof nodeModule.registerHooks === "function") {
    nodeModule.registerHooks({ resolve });
  } else {
    // Node 22.13 and 22.14 predate registerHooks and are still supported.
    nodeModule.register("./resolver.mjs", import.meta.url);
  }
}

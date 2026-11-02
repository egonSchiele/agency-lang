// Tiny entry that registers the resolver hook with Node's module loader.
// Spawned via `node --import=<file-url-to-this-file>`.
import * as nodeModule from "node:module";
import { resolve } from "./resolver.mjs";

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({ resolve });
} else {
  // Node 22.13 and 22.14 predate registerHooks and are still supported.
  nodeModule.register("./resolver.mjs", import.meta.url);
}

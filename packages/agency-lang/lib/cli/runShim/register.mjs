// Tiny entry that registers the resolver hook with Node's module loader.
// Spawned via `node --import=<file-url-to-this-file>`.
import { register } from "node:module";

register("./resolver.mjs", import.meta.url);

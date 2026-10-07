// Types for the "#..." names in the "imports" field of package.json.
//
// Node and esbuild resolve those names through package.json, to a file per
// platform under dist/. TypeScript cannot, on a fresh checkout, because dist/
// does not exist yet. So each name is declared here, and hash.test.ts checks
// that both files behind it match the declaration (default-host.test.ts does the
// same for "#default-host"). Do not add these names to "paths" in tsconfig.json: the
// build runs tsc-alias, which rewrites every "paths" entry into a relative
// import and would undo the per-platform choice.
//
// Keep this file, the "imports" field, and vitest.aliases.ts in step.

declare module "#sha256" {
  /** The SHA-256 digest of `data`, as 32 bytes. */
  export function sha256Bytes(data: Uint8Array): Uint8Array;
  /** HMAC-SHA256 of `data` under `key`, as 32 bytes. */
  export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
}

declare module "#path" {
  import nodePath from "path";
  /** The path module: Node's own on Node (the platform's rules), and
   *  Node's POSIX `path.js` in a browser bundle. The functions both have;
   *  `matchesGlob` and `toNamespacedPath` are Node's alone. A caller gives
   *  `resolve` an absolute first argument, the working directory from
   *  `host.system.cwd()`, so the module never reads `process.cwd()`. */
  const portablePath: Pick<
    typeof nodePath,
    | "basename"
    | "dirname"
    | "extname"
    | "format"
    | "isAbsolute"
    | "join"
    | "normalize"
    | "parse"
    | "relative"
    | "resolve"
  > & { sep: string; delimiter: string };
  export default portablePath;
}

declare module "#default-host" {
  // Not a relative path: inside an ambient module declaration TypeScript
  // ignores one, and this import would silently become `any`.
  import type { Host } from "@/host/host.js";
  /** The host a RuntimeContext uses when its caller passed none: a
   *  `nodeHost` on Node, a `browserHost` in a browser bundle. */
  export function defaultHost(): Host;
}

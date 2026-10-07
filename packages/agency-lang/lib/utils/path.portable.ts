import posix from "path-browserify";

// `path-browserify` is Node's POSIX `path.js` on its own, so a browser
// bundle gets the same answers Node gives on macOS and Linux. Its `resolve`
// reads `process.cwd()` only when no argument is absolute; every caller
// passes the working directory from `host.system.cwd()` first, so it never
// does. See docs/dev/runtime/running-without-node.md.
export default posix;

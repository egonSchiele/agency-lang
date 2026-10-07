import path from "path";

// Node's own `path`, with the platform's rules: POSIX on macOS and Linux,
// Windows on Windows. `#path` resolves here on Node and to path.portable.ts
// in a browser bundle. See docs/dev/runtime/running-without-node.md.
export default path;

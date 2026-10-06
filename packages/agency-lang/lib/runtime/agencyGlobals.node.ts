// The free names Agency code may use that come from the platform: `path`
// and `os`, as in `path.join(dir, name)` and `os.homedir()`. The generated
// header imports them from "agency-lang/runtime". On Node they are Node's
// own modules; the browser entry point exports a portable `path` and a
// host-backed `os` in their place. Node-only.
export { default as path } from "path";
export { default as os } from "os";

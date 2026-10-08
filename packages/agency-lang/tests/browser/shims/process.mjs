// A `process` with an empty environment, for the browser bundle check.
// Two dependencies reach for one at load: tarsec imports Node's `process`
// for its tracing (the current version checks `process.versions.node`
// before using it; the older copy a dependency pins reads
// `process.env.DEBUG` outright), and typestache reads the global
// `process.env.TYPESTACHE_DEBUG`. esbuild's --alias points the import
// here and --inject makes the named export the global. Both take their
// browser path with an empty env.
export const process = { env: {} };
export default process;

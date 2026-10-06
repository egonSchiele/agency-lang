// The contained file operations moved to lib/host/nodeFiles.ts, the file
// part of nodeHost. This re-export keeps the 33 importers unchanged until
// each moves to `run.ctx.host.files`, which is async. New code imports the
// host, not this file.
export * from "../host/nodeFiles.js";

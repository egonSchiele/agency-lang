// Moved to lib/utils/canonicalize.ts, which is neutral about who uses it: the
// label store hashes durable rows with the same function, and two canonical
// JSON implementations would eventually disagree about something that matters.
// Re-exported here so existing trace callers keep working.
export { canonicalize, type JsonValue } from "@/utils/canonicalize.js";

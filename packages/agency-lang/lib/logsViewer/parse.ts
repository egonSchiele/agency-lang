// Moved to lib/statelog/parse.ts so the eval module (a peer of this
// viewer, not a dependent) can parse statelogs without pulling in viewer
// internals — the same move lib/statelog/wireTypes.ts made. Re-exported
// here to keep existing imports working.
export { parseStatelogJsonl, type ParseError, type ParseResult } from "../statelog/parse.js";

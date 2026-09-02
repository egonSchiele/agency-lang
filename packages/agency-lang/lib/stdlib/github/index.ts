// The only surface stdlib/github.agency imports. credential.ts and request.ts
// are deliberately absent: no .agency file can reach the token or send a raw
// request, so "the token never becomes an Agency value" holds structurally.
export { _ghResolveRepo } from "./repo.js";
export * from "./prs.js";
export * from "./issues.js";

// Re-export zod so downstream Agency packages and generated code can import
// it via `agency-lang/zod` rather than installing zod directly. This avoids the
// multi-instance hazard where two copies of zod fail each other's
// `instanceof ZodType` checks.
export * from "zod";
export { z } from "zod";

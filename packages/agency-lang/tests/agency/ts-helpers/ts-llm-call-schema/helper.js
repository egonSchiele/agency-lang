import { z } from "zod";
import { agency } from "agency-lang/runtime";

// Pins the structured-output overload of `agency.llm`: when called
// with `{ schema }`, the runtime JSON-parses the LLM's response and
// returns the zod-validated object — not the raw string. Mirrors
// `ts-llm-call` for the schema-bearing path.
//
// Mock returns the OBJECT `{value: 42}`; the deterministic client
// JSON.stringifies it, runPrompt JSON.parses the content, and
// `extractResponse` runs the schema's safeParse — returning the
// typed object to the caller.
export async function run() {
  const schema = z.object({ value: z.number() });
  return agency.llm("compute the answer", { schema });
}

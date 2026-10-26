import { schemaProblems } from "../runtime/invalidArgument.js";

/** What inside `value` did not fit, from a checked cast's failure message,
 *  or null when the message names nothing inside it. */
export function _schemaProblems(message: string, value: unknown): string | null {
  return schemaProblems(message, value);
}

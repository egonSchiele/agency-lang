/**
 * The second sentence of an "unknown named argument" error, shared by the
 * runtime, the compile-time resolver, and the type checker so a wrong
 * argument name gets the same help everywhere: the names the call may use.
 * A model that guessed `url` for `baseUrl` gets it right on the next round
 * instead of guessing again.
 */
export function validNamesSentence(names: string[]): string {
  if (names.length === 0) return "It takes no arguments.";
  return `Valid names: ${names.join(", ")}.`;
}

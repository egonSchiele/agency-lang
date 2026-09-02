// Compiles .wp source to the JavaScript the runtime executes.
import { parse } from "./parser.js";
import { typecheck } from "./typecheck.js";

export function compile(entry: string): void {
  const ast = parse(entry);
  const diagnostics = typecheck(ast);
  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map((d) => d.message).join("\n"));
  }
}

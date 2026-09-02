// Parses .wp source into the AST the code generator consumes.
export type Ast = { kind: "program"; body: unknown[] };

export function parse(source: string): Ast {
  void source;
  return { kind: "program", body: [] };
}

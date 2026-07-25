export type SourceLocation = {
  line: number;
  col: number;
  start: number;
  end: number;
  /** Set when a node was grafted in rather than written by hand, so an
   *  error in generated code can name who is responsible. For a template
   *  fill, `name` is the hole the content came through; for a compile-time
   *  splice, it is the generator that produced it. */
  origin?: { kind: "template" | "filler" | "splice"; name: string };
};

export type BaseNode = {
  loc?: SourceLocation;
};

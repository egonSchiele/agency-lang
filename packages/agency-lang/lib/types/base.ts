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

/** A `//` comment. Declared here rather than reused from `../types.js`,
 *  because that aggregate module imports BaseNode. */
export type LineComment = {
  type: "comment";
  content: string;
  loc?: SourceLocation;
};

export type BaseNode = {
  loc?: SourceLocation;
  /** A same-line `//` comment attached for Agency source formatting.
   *  Never part of the owner's `loc`. */
  trailingComment?: LineComment;
};

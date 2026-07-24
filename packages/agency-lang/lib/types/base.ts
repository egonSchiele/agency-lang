export type SourceLocation = {
  line: number;
  col: number;
  start: number;
  end: number;
  /** Set by template filling so an error in generated code can name
   *  whether the template author or a filler is responsible. `name` is
   *  the hole the content came through. */
  origin?: { kind: "template" | "filler"; name: string };
};

export type BaseNode = {
  loc?: SourceLocation;
};

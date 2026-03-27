export type SourceLocation = {
  line: number;
  col: number;
  start: number;
  end: number;
};

export type BaseNode = {
  loc?: SourceLocation;
};

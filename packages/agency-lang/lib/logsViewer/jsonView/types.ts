// Tree shape for the bottom JSON-payload pane. One JsonNode per JSON
// value in the payload; objects/arrays are containers, primitives and
// `longString` are leaves. Insertion-order matters and is preserved
// across builds — the on-wire field order is meaningful here.
export type JsonNode =
  | {
      kind: "primitive";
      path: string;
      valueType: "string" | "number" | "boolean" | "null";
      // The exact text we want to render (e.g. `"foo"`, `42`, `null`).
      raw: string;
    }
  | {
      kind: "object";
      path: string;
      entries: { key: string; child: JsonNode }[];
    }
  | {
      kind: "array";
      path: string;
      items: JsonNode[];
    }
  | {
      // Strings that contain a newline OR exceed 80 characters. The
      // renderer collapses these by default and gives the user `l` to
      // see the full content.
      kind: "longString";
      path: string;
      raw: string;
    };

// Default-open heuristic. The renderer respects an external "open"
// set; this constant lives in build.ts and is referenced in tests.
export const LONG_STRING_THRESHOLD = 80;

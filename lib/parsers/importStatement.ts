import {
  DefaultImport,
  ImportNameType,
  ImportNodeStatement,
  ImportStatement,
  ImportToolStatement,
  NamedImport,
  NamespaceImport,
} from "../types/importStatement.js";
import {
  alphanum,
  between,
  capture,
  captureCaptures,
  char,
  many1Till,
  many1WithJoin,
  map,
  newline,
  oneOf,
  optional,
  or,
  parseError,
  Parser,
  sepBy,
  sepBy1,
  seqC,
  set,
  spaces,
  str,
  trace,
} from "tarsec";
import { optionalSemicolon } from "./parserUtils.js";
import { comma, optionalSpaces } from "./utils.js";

// Helper parser for quoted file paths - supports both single and double quotes
const doubleQuotedPath: Parser<{ path: string }> = seqC(
  char('"'),
  capture(many1Till(char('"')), "path"),
  char('"'),
);

const singleQuotedPath: Parser<{ path: string }> = seqC(
  char("'"),
  capture(many1Till(char("'")), "path"),
  char("'"),
);

const quotedPath: Parser<string> = map(
  or(doubleQuotedPath, singleQuotedPath),
  (res) => res.path,
);

export const importNodeStatmentParser: Parser<ImportNodeStatement> = trace(
  "importNodeStatement",
  seqC(
    set("type", "importNodeStatement"),
    str("import"),
    spaces,
    or(str("nodes"), str("node")),
    captureCaptures(
      parseError(
        "expected a statement of the form `import nodes { x, y } from 'filename.agency'`",
        spaces,
        char("{"),
        optionalSpaces,
        capture(sepBy1(comma, many1WithJoin(alphanum)), "importedNodes"),
        optionalSpaces,
        char("}"),
        spaces,
        str("from"),
        spaces,
        capture(quotedPath, "agencyFile"),
        optionalSemicolon,
        optional(newline),
      ),
    ),
  ),
);
export const importToolStatmentParser: Parser<ImportToolStatement> = trace(
  "importToolStatement",
  seqC(
    set("type", "importToolStatement"),
    str("import"),
    spaces,
    or(str("tools"), str("tool")),
    captureCaptures(
      parseError(
        "expected a statement of the form `import tools { x, y } from 'filename.agency'`",
        spaces,
        char("{"),
        optionalSpaces,
        capture(sepBy1(comma, many1WithJoin(alphanum)), "importedTools"),
        optionalSpaces,
        char("}"),
        spaces,
        str("from"),
        spaces,
        capture(quotedPath, "agencyFile"),
        optionalSemicolon,
        optional(newline),
      ),
    ),
  ),
);

const safeNameItem = or(
  map(seqC(str("safe "), capture(many1WithJoin(alphanum), "name")), (r) => ({
    name: r.name,
    isSafe: true,
  })),
  map(seqC(capture(many1WithJoin(alphanum), "name")), (r) => ({
    name: r.name,
    isSafe: false,
  })),
);

const namedImportParser: Parser<NamedImport> = trace(
  "namedImportParser",
  map(
    seqC(
      char("{"),
      optionalSpaces,
      capture(sepBy1(comma, safeNameItem), "items"),
      optionalSpaces,
      char("}"),
    ),
    (result) => {
      const importedNames: string[] = [];
      const safeNames: string[] = [];
      for (const item of result.items) {
        importedNames.push(item.name);
        if (item.isSafe) {
          safeNames.push(item.name);
        }
      }
      return { type: "namedImport" as const, importedNames, safeNames };
    },
  ),
);

const namespaceImportParser: Parser<NamespaceImport> = trace(
  "namespaceImportParser",
  seqC(
    many1Till(spaces),
    spaces,
    str("as"),
    spaces,
    capture(many1WithJoin(alphanum), "importedNames"),
    set("type", "namespaceImport"),
  ),
);

const defaultImportParser: Parser<DefaultImport> = trace(
  "defaultImportParser",
  seqC(
    capture(many1WithJoin(alphanum), "importedNames"),
    set("type", "defaultImport"),
  ),
);

const importNameTypeParser: Parser<ImportNameType[]> = sepBy(
  comma,
  or(namedImportParser, namespaceImportParser, defaultImportParser),
);

export const importStatmentParser: Parser<ImportStatement> = trace(
  "importStatement",
  seqC(
    set("type", "importStatement"),
    str("import"),
    captureCaptures(
      parseError(
        "expected a statement of the form `import { x, y } from 'filename'`",
        spaces,
        capture(importNameTypeParser, "importedNames"),
        spaces,
        str("from"),
        spaces,
        oneOf(`'"`),
        capture(many1Till(oneOf(`'"`)), "modulePath"),
        oneOf(`'"`),
        optionalSemicolon,
        optional(newline),
      ),
    ),
  ),
);

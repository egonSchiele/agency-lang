# Doc Comments Design Spec

## Summary

Add support for `/** ... */` doc comment syntax. Doc comments are documentation-only metadata that appear in generated docs (via the `doc` command) but not in generated TypeScript. They can be attached to functions, nodes, type aliases, or the file itself (file-level doc comment).

Also add docstring support to nodes, which currently lack it.

## Syntax

Doc comments use the existing multi-line comment syntax with a leading `*`:

```ts
/** This is a doc comment */

/**
This is a multi-line
doc comment
*/
```

### File-level doc comment

A doc comment that appears at the top of the file, before any imports or declarations, is the file-level doc comment. Regular comments and blank lines may precede it.

```ts
// regular comment is fine above
/** This file implements email categorization. */

import { foo } from "./bar.agency"
```

### Attached to declarations

A doc comment immediately before a function, node, or type alias is attached to that declaration.

```ts
/** Categorizes user messages. */
node categorize(message: string) {
  """docstring for LLM tool description"""
  const category: Category = llm("...")
  return category
}

/** Adds two numbers. */
def add(a: number, b: number): number {
  """Returns the sum of a and b."""
  return a + b
}

/** Possible message categories. */
type Category = "reminder" | "todo"
```

### Doc comments vs docstrings

- **Docstrings** (`"""..."""`) are sent to the LLM as tool descriptions AND appear in generated docs.
- **Doc comments** (`/** ... */`) appear ONLY in generated docs, not in generated TypeScript or LLM calls.
- Both can coexist on the same declaration.

## AST Changes

### Modify `AgencyMultiLineComment`

Add an `isDoc` boolean field:

```ts
// lib/types.ts
export type AgencyMultiLineComment = BaseNode & {
  type: "multiLineComment";
  content: string;
  isDoc: boolean;
};
```

When the comment starts with `/**`, `isDoc` is `true`. Regular `/* ... */` comments have `isDoc: false`.

### Add `docComment` field to declarations

```ts
// lib/types/graphNode.ts
export type GraphNodeDefinition = BaseNode & {
  type: "graphNode";
  nodeName: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  visibility?: Visibility;
  tags?: Tag[];
  docComment?: AgencyMultiLineComment;  // NEW
  docString?: DocString;                // NEW
};
```

```ts
// lib/types/function.ts
export type FunctionDefinition = BaseNode & {
  type: "function";
  functionName: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  docString?: DocString;
  docComment?: AgencyMultiLineComment;  // NEW
  async?: boolean;
  safe?: boolean;
  exported?: boolean;
  callback?: boolean;
  tags?: Tag[];
};
```

```ts
// lib/types/typeHints.ts
export type TypeAlias = BaseNode & {
  type: "typeAlias";
  aliasName: string;
  aliasedType: VariableType;
  exported?: boolean;
  docComment?: AgencyMultiLineComment;  // NEW
};
```

### Add `docComment` field to `AgencyProgram`

```ts
// lib/types.ts
export type AgencyProgram = {
  type: "agencyProgram";
  nodes: AgencyNode[];
  docComment?: AgencyMultiLineComment;  // NEW
};
```

## Parser Changes

### Multi-line comment parser

Extend the existing multi-line comment parser in `lib/parsers/parsers.ts` to detect `/**` and set `isDoc: true`. The parser already matches `/* ... */` — it needs to check if the opening is `/**` and set the flag accordingly. Existing `/* ... */` comments get `isDoc: false`.

### Node body parser

Extend the node body parser to optionally parse a docstring at the start of the body, the same way the function body parser already does. This gives nodes their new `docString` field.

## Preprocessor Changes

Add a new pass in the TypeScript preprocessor (`lib/preprocessors/typescriptPreprocessor.ts`) that handles doc comment attachment:

1. **File-level doc comment:** Walk the top-level statements in order. Skip single-line comments, non-doc multi-line comments (`isDoc: false`), and newlines. If the first remaining statement is a `multiLineComment` with `isDoc: true`, AND it appears before any import or declaration, attach it to `AgencyProgram.docComment` and remove it from the statement list. If there are multiple doc comments before the first import/declaration, only the first one becomes the file-level doc comment; the rest follow rule 2 or 3.

2. **Declaration-level doc comments:** Walk the remaining top-level statements. If a `multiLineComment` with `isDoc: true` is followed by a function, node, or type alias (with only newlines between them — intervening regular comments break attachment), attach it to that declaration's `docComment` field and remove it from the statement list. A doc comment before an import or variable declaration does not attach; it follows rule 3.

3. **Unattached doc comments:** A doc comment that doesn't match either case above stays in the statement list as a regular multi-line comment. No error, no special treatment.

This pass should run early in the preprocessor, before scope resolution and async marking, since it only restructures metadata and does not affect control flow or variable resolution.

## Builder Changes (`lib/backends/typescriptBuilder.ts`)

- Doc comments attached to declarations are already removed from the statement list by the preprocessor, so no extra skip logic needed in the builder.
- Unattached doc comments in the statement list are emitted as regular `/* ... */` comments (existing behavior).
- **Node docstrings:** Use `node.docString?.value` for the node description in `setupNode`, the same way function docstrings are used for tool descriptions.

## Agency Generator Changes (`lib/backends/agencyGenerator.ts`)

Update `processMultiLineComment` to preserve the `/**` syntax when `isDoc` is true:

```ts
protected processMultiLineComment(node: AgencyMultiLineComment): string {
  if (node.isDoc) {
    return this.indentStr(`/**${node.content}*/`);
  }
  return this.indentStr(`/*${node.content}*/`);
}
```

Also, when generating code for functions, nodes, and type aliases that have a `docComment` field, emit the doc comment immediately before the declaration. Specifically, `processFunction`, `processGraphNode`, and the type alias processing need to check for `node.docComment` and emit it. Similarly, the generator must emit `AgencyProgram.docComment` at the top of the file when present.

## Doc Generator Changes (`lib/cli/doc.ts`)

### File-level doc comment

If `AgencyProgram.docComment` is present, render its content immediately after the title heading, before the Types/Functions/Nodes sections.

### Functions and nodes

Render **docstring first**, then **doc comment second**. Both are optional. Note that node docstring rendering is new — nodes currently have no docstring output in the doc generator.

Example output for a node with both:

```md
### categorize

\`\`\`
categorize(message: string)
\`\`\`

docstring for func, used in docs, also sent to llm

Here's some extra context that gets added to the docs,
but doesn't get sent to the llm

**Parameters:**
...
```

### Type aliases

Render doc comment above the type definition code block.

## Testing

### Parser tests
- Multi-line comment with `/**` sets `isDoc: true`
- Multi-line comment with `/*` sets `isDoc: false`
- `/** */` with various whitespace patterns

### Preprocessor tests
- Doc comment before a function attaches to `docComment` field
- Doc comment before a node attaches to `docComment` field
- Doc comment before a type alias attaches to `docComment` field
- File-level doc comment (before any imports/declarations) attaches to `AgencyProgram.docComment`
- Regular comments before the file-level doc comment are fine
- Doc comment not followed by a declaration stays in statement list
- Multiple doc comments: each attaches to the next declaration

### Node docstring tests
- Node with a docstring parses correctly
- Node docstring value is accessible on `GraphNodeDefinition.docString`

### Doc generator tests
- File-level doc comment renders after title
- Function with doc comment and docstring: docstring first, doc comment second
- Node with doc comment and docstring: docstring first, doc comment second
- Type alias with doc comment renders above type definition
- Missing doc comment/docstring renders cleanly (no empty sections)

### Agency generator tests
- Round-trip: doc comments survive formatting as `/** ... */`
- Regular multi-line comments still format as `/* ... */`
- Declarations with attached doc comments: doc comment emitted before the declaration

### Builder tests
- Node with docstring: docstring value appears in generated `setupNode` description
- Integration test fixture for node docstrings in generated TypeScript

### Integration test fixtures
- New `.agency` and `.mts` files in `tests/typescriptGenerator/` confirming doc comments do not appear in generated TypeScript

## Non-changes

- **Type checker:** No changes needed. The type checker does not inspect doc comments or docstrings.
- **Content trimming:** Doc comment `content` is stored as-is from the parser (the existing multi-line comment parser captures raw content between `/*` and `*/`). The doc generator renders this content directly. No additional trimming or normalization is applied — this matches how regular multi-line comments already work.

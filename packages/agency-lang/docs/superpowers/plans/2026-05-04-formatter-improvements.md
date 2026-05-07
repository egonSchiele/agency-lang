# Formatter Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add line-length wrapping, import sorting, trailing newline, and trailing whitespace removal to the Agency formatter.

**Architecture:** All changes are in `lib/backends/agencyGenerator.ts` (the renderer) and `lib/formatter.test.ts` (tests). A single `wrapList` helper handles all wrapping decisions — params, args, and imports — measuring the full rendered line (including indentation, prefix, suffix) against the 80-char limit. Import sorting collects raw AST nodes, groups and sorts them, then renders. Trailing newline and whitespace cleanup are applied in `generateAgency`.

**Tech Stack:** TypeScript, vitest

**Spec:** `docs/superpowers/specs/2026-05-04-formatter-improvements-design.md`

---

### Task 1: Trailing newline and trailing whitespace removal

**Files:**
- Modify: `lib/backends/agencyGenerator.ts:1092-1094`
- Test: `lib/formatter.test.ts`

The simplest changes — do these first as they affect all subsequent test expectations.

- [ ] **Step 1: Write the failing tests**

Add to `lib/formatter.test.ts`:

```ts
it("output ends with exactly one trailing newline", () => {
  const input = 'node main() {\n  print("a")\n}\n';
  const formatted = formatSource(input);
  expect(formatted).toMatch(/[^\n]\n$/);
});

it("removes trailing whitespace from lines", () => {
  const input = 'node main() {\n  print("a")\n}\n';
  const formatted = formatSource(input);
  const lines = formatted!.split("\n");
  for (const line of lines) {
    expect(line).toBe(line.trimEnd());
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/formatter.test.ts 2>&1 | tee $TMPDIR/t1s2.log`

- [ ] **Step 3: Implement**

In `lib/backends/agencyGenerator.ts`, change `generateAgency` (~line 1092):

```ts
export function generateAgency(program: AgencyProgram): string {
  const generator = new AgencyGenerator();
  return generator.generate(program).output
    .trim()
    .replace(/[ \t]+$/gm, "")
    + "\n";
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test:run lib/formatter.test.ts 2>&1 | tee $TMPDIR/t1s4.log`
Expected: PASS

- [ ] **Step 5: Update roundtrip fixture**

The roundtrip fixture at `tests/formatter/roundtrip.agency` must end with a trailing newline. Verify by running:

Run: `pnpm test:run lib/formatter.test.ts 2>&1 | tee $TMPDIR/t1s5.log`

If the round-trip test fails, update the fixture so it ends with exactly one `\n` and has no trailing whitespace on any line. Then re-run.

- [ ] **Step 6: Commit**

```
git add lib/backends/agencyGenerator.ts lib/formatter.test.ts tests/formatter/roundtrip.agency
git commit -m "feat(formatter): add trailing newline and remove trailing whitespace"
```

---

### Task 2: Add the `wrapList` helper and refactor existing wrapping

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`

This task introduces the core wrapping helper that all subsequent wrapping features use. It also refactors the existing array wrapping to use it.

- [ ] **Step 1: Add the `wrapList` helper**

Add to the `AgencyGenerator` class:

```ts
/**
 * Render a list of items inline or wrapped to multi-line.
 * Measures the full rendered line (indentation + prefix + items + suffix) against 80 chars.
 *
 * @param items - The rendered string for each item
 * @param prefix - Text before the open bracket (e.g., "def foo")
 * @param open - Opening bracket (e.g., "(")
 * @param close - Closing bracket (e.g., ")")
 * @param suffix - Text after the close bracket (e.g., " {" or ' from "./foo.js"')
 */
private wrapList(
  items: string[],
  prefix: string,
  open: string,
  close: string,
  suffix: string = "",
): string {
  const inline = `${prefix}${open}${items.join(", ")}${close}${suffix}`;
  if (this.indentStr(inline).length <= 80) return inline;
  this.increaseIndent();
  const lines = items.map((item) => this.indentStr(`${item},`));
  this.decreaseIndent();
  return `${prefix}${open}\n${lines.join("\n")}\n${this.indent()}${close}${suffix}`;
}
```

- [ ] **Step 2: Add a `renderParams` helper**

Both `processFunctionDefinition` and `processGraphNode` render parameters the same way. Extract a shared helper:

```ts
private renderParams(parameters: FunctionParameter[]): string[] {
  return parameters.map((p) => {
    const prefix = p.variadic ? "..." : "";
    const defaultSuffix = p.defaultValue
      ? ` = ${this.processNode(p.defaultValue).trim()}`
      : "";
    if (p.typeHint) {
      const typeStr = variableTypeToString(p.typeHint, this.typeAliases);
      const bang = p.validated ? "!" : "";
      return `${prefix}${p.name}: ${typeStr}${bang}${defaultSuffix}`;
    } else {
      return `${prefix}${p.name}${defaultSuffix}`;
    }
  });
}
```

- [ ] **Step 3: Run full test suite to verify no regressions**

Run: `pnpm test:run 2>&1 | tee $TMPDIR/t2s3.log`
Expected: PASS (helpers added but not yet called)

- [ ] **Step 4: Commit**

```
git add lib/backends/agencyGenerator.ts
git commit -m "feat(formatter): add wrapList and renderParams helpers"
```

---

### Task 3: Line-length wrapping for function/node signatures

**Files:**
- Modify: `lib/backends/agencyGenerator.ts` — `processFunctionDefinition` (~line 485), `processGraphNode` (~line 839)
- Test: `lib/formatter.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `lib/formatter.test.ts`:

```ts
it("keeps short function signatures on one line", () => {
  const input = 'def add(a: number, b: number): number {\n  return a + b\n}\n';
  const formatted = formatSource(input);
  expect(formatted).toContain("def add(a: number, b: number): number {");
});

it("wraps long function signatures to multi-line", () => {
  const input = 'def processData(inputFile: string, outputFile: string, format: string, verbose: boolean) {\n  return 1\n}\n';
  const formatted = formatSource(input);
  expect(formatted).toContain("def processData(\n");
  expect(formatted).toContain("  inputFile: string,\n");
  expect(formatted).toContain("  verbose: boolean,\n");
  expect(formatted).toContain(") {");
});

it("wraps long node signatures to multi-line", () => {
  const input = 'node handleRequest(message: string, context: string, options: string, verbose: boolean) {\n  return 1\n}\n';
  const formatted = formatSource(input);
  expect(formatted).toContain("node handleRequest(\n");
  expect(formatted).toContain(") {");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/formatter.test.ts 2>&1 | tee $TMPDIR/t3s2.log`

- [ ] **Step 3: Update `processFunctionDefinition` to use `wrapList`**

Replace the params rendering in `processFunctionDefinition` (~line 489-517):

```ts
protected processFunctionDefinition(node: FunctionDefinition): string {
  const tags = this.formatAttachedTags(node);
  const { functionName, body, parameters } = node;

  const returnTypeBang = node.returnTypeValidated ? "!" : "";
  const returnTypeStr = node.returnType
    ? ": " + variableTypeToString(node.returnType, this.typeAliases) + returnTypeBang
    : "";

  const prefixes: string[] = [];
  if (node.exported) prefixes.push("export");
  if (node.safe) prefixes.push("safe");
  node.callback ? prefixes.push("callback") : prefixes.push("def");

  const prefix = `${prefixes.join(" ")} ${functionName}`;
  const renderedParams = this.renderParams(parameters);
  const signature = this.wrapList(renderedParams, prefix, "(", ")", `${returnTypeStr} {`);

  let result = this.indentStr(`${signature}\n`);

  this.increaseIndent();

  if (node.docString) {
    const lines = node.docString.value.split("\n").map(l => l.trim());
    const docLines = [`"""`, ...lines, `"""`];
    const docStr = docLines.map((line) => this.indentStr(line)).join("\n");
    result += `${docStr}\n`;
  }

  const bodyStr = this.renderBody(body);
  if (bodyStr.trim() !== "") {
    result += bodyStr;
  }

  this.decreaseIndent();

  result += this.indentStr(`}`);

  return this.formatDocComment(node) + tags + result;
}
```

- [ ] **Step 4: Update `processGraphNode` to use `wrapList`**

Same pattern for `processGraphNode` (~line 839):

```ts
protected processGraphNode(node: GraphNodeDefinition): string {
  const tags = this.formatAttachedTags(node);
  const { nodeName, body, parameters } = node;
  const returnTypeBang = node.returnTypeValidated ? "!" : "";
  const returnTypeStr = node.returnType
    ? ": " + variableTypeToString(node.returnType, this.typeAliases) + returnTypeBang
    : "";
  const visibilityStr = this.visibilityToString(node.visibility);
  const prefix = `${visibilityStr}node ${nodeName}`;
  const renderedParams = this.renderParams(parameters);
  const signature = this.wrapList(renderedParams, prefix, "(", ")", `${returnTypeStr} {`);

  let result = this.indentStr(`${signature}\n`);

  this.increaseIndent();

  if (node.docString) {
    const docLines = [`"""`, ...node.docString.value.split("\n"), `"""`];
    const docStr = docLines.join("\n");
    result += `${docStr}\n`;
  }

  result += this.renderBody(body);

  this.decreaseIndent();

  result += this.indentStr(`}`);
  return this.formatDocComment(node) + tags + result;
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm test:run lib/formatter.test.ts 2>&1 | tee $TMPDIR/t3s5.log`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `pnpm test:run 2>&1 | tee $TMPDIR/t3s6.log`
Expected: PASS. If any existing tests fail due to new wrapping, update expectations.

- [ ] **Step 7: Commit**

```
git add lib/backends/agencyGenerator.ts lib/formatter.test.ts
git commit -m "feat(formatter): wrap long function/node signatures to multi-line"
```

---

### Task 4: Line-length wrapping for function call arguments

**Files:**
- Modify: `lib/backends/agencyGenerator.ts` — `renderArgList` (~line 548)
- Test: `lib/formatter.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `lib/formatter.test.ts`:

```ts
it("keeps short function calls on one line", () => {
  const input = 'node main() {\n  print("hello")\n}\n';
  const formatted = formatSource(input);
  expect(formatted).toContain('print("hello")');
});

it("wraps long function call arguments to multi-line", () => {
  const input = 'node main() {\n  someFunction("a very long argument", "another long argument", "yet another", "and more")\n}\n';
  const formatted = formatSource(input);
  expect(formatted).toContain("someFunction(\n");
  expect(formatted).toContain('    "a very long argument",\n');
  expect(formatted).toContain("  )");
});

it("wraps long call arguments with trailing as block", () => {
  const input = 'node main() {\n  const result = longFunctionName("very long first argument string here", "second argument") as item {\n    return item\n  }\n}\n';
  const formatted = formatSource(input);
  expect(formatted).toContain("longFunctionName(\n");
  expect(formatted).toContain(") as item {");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/formatter.test.ts 2>&1 | tee $TMPDIR/t4s2.log`

- [ ] **Step 3: Implement multi-line `renderArgList` using `wrapList`**

Modify `renderArgList` (~line 548). The function name acts as the prefix. Since `renderArgList` doesn't know the function name (it only receives args), we need to refactor slightly. The cleanest approach: `renderArgList` returns the rendered items as an array, and the caller (`generateFunctionCallExpression`) assembles the full expression using `wrapList`.

First, split `renderArgList` into two parts — one that renders the items, one that formats them:

```ts
// Render each argument to a string
protected renderArgs(args: FunctionCall["arguments"], block?: BlockArgument): string[] {
  const rendered = args.map((arg) => {
    if (arg.type === "namedArgument") {
      return `${arg.name}: ${this.processNode(arg.value).trim()}`;
    }
    if (arg.type === "splat") {
      return `...${this.processNode(arg.value).trim()}`;
    }
    return this.processNode(arg).trim();
  });
  if (block?.inline) {
    const returnStmt = block.body[0] as ReturnStatement;
    const exprStr = this.processNode(returnStmt.value!).trim();
    let params = "";
    if (block.params.length === 1) {
      params = block.params[0].name;
    } else if (block.params.length > 1) {
      params = `(${block.params.map((p) => p.name).join(", ")})`;
    }
    rendered.push(`\\${params} -> ${exprStr}`);
  }
  return rendered;
}

// Format args as parenthesized list (inline or wrapped)
protected renderArgList(args: FunctionCall["arguments"], block?: BlockArgument): string {
  const rendered = this.renderArgs(args, block);
  return `(${rendered.join(", ")})`;
}
```

Then update `generateFunctionCallExpression` (~line 572) to use `wrapList` for the full expression:

```ts
protected generateFunctionCallExpression(
  node: FunctionCall,
  context: "valueAccess" | "functionArg" | "topLevelStatement",
): string {
  let asyncPrefix = "";
  if (node.async === true) {
    asyncPrefix = "async ";
  } else if (node.async === false) {
    asyncPrefix = "await ";
  }

  const block = node.block;
  const inlineBlock = block?.inline ? block : undefined;
  const rendered = this.renderArgs(node.arguments, inlineBlock);
  let result = this.wrapList(rendered, `${asyncPrefix}${node.functionName}`, "(", ")", "");

  if (block && !block.inline) {
    let asClause = "as ";
    if (block.params.length === 1) {
      asClause = `as ${block.params[0].name} `;
    } else if (block.params.length > 1) {
      asClause = `as (${block.params.map((p) => p.name).join(", ")}) `;
    }

    this.increaseIndent();
    const bodyStr = this.renderBody(block.body);
    this.decreaseIndent();

    result += ` ${asClause}{\n${bodyStr}${this.indentStr("}")}`;
  }

  return result;
}
```

Note: `renderArgList` is still kept for callers that just need the simple inline form (e.g., `processAccessChainElement` for `call` elements). It does NOT wrap — only `generateFunctionCallExpression` wraps via `wrapList`.

- [ ] **Step 4: Run tests**

Run: `pnpm test:run lib/formatter.test.ts 2>&1 | tee $TMPDIR/t4s4.log`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `pnpm test:run 2>&1 | tee $TMPDIR/t4s5.log`
Expected: PASS

- [ ] **Step 6: Commit**

```
git add lib/backends/agencyGenerator.ts lib/formatter.test.ts
git commit -m "feat(formatter): wrap long function call arguments to multi-line"
```

---

### Task 5: Line-length wrapping for import statements

**Files:**
- Modify: `lib/backends/agencyGenerator.ts` — `processImportStatement` (~line 793)
- Test: `lib/formatter.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `lib/formatter.test.ts`:

```ts
it("keeps short imports on one line", () => {
  const input = 'import { foo, bar } from "./utils.agency"\nnode main() {\n  print(1)\n}\n';
  const formatted = formatSource(input);
  expect(formatted).toContain('import { foo, bar } from "./utils.agency"');
});

it("wraps long named imports to multi-line", () => {
  const input = 'import { alpha, bravo, charlie, delta, echo, foxtrot, golf } from "./utils.agency"\nnode main() {\n  print(1)\n}\n';
  const formatted = formatSource(input);
  expect(formatted).toContain("import {\n");
  expect(formatted).toContain("  alpha,\n");
  expect(formatted).toContain('} from "./utils.agency"');
});

it("preserves safe and alias in wrapped imports", () => {
  const input = 'import { safe alpha, bravo as b, charlie, delta, echo, foxtrot } from "./utils.agency"\nnode main() {\n  print(1)\n}\n';
  const formatted = formatSource(input);
  expect(formatted).toContain("  safe alpha,");
  expect(formatted).toContain("  bravo as b,");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/formatter.test.ts 2>&1 | tee $TMPDIR/t5s2.log`

- [ ] **Step 3: Implement using `wrapList`**

Modify `processImportStatement` (~line 793) to use `wrapList`. The `processImportNameType` method stays unchanged — it always returns the inline form. The wrapping decision lives in the caller:

```ts
protected processImportStatement(node: ImportStatement): string {
  const modulePath = node.modulePath.startsWith("std::")
    ? node.modulePath.replace(/\.agency$/, "")
    : node.modulePath;
  const suffix = ` from "${modulePath}"`;

  // For named imports, use wrapList
  if (node.importedNames.length === 1 && node.importedNames[0].type === "namedImport") {
    const namedImport = node.importedNames[0];
    const names = namedImport.importedNames.map((name) => {
      const alias = namedImport.aliases[name];
      const base = alias ? `${name} as ${alias}` : name;
      return namedImport.safeNames?.includes(name) ? `safe ${base}` : base;
    });
    return this.indentStr(this.wrapList(names, "import ", "{ ", " }", suffix));
  }

  // Default/namespace imports — always inline
  const importedNames = node.importedNames.map((name) =>
    this.processImportNameType(name),
  );
  return this.indentStr(`import ${importedNames.join(", ")}${suffix}`);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test:run lib/formatter.test.ts 2>&1 | tee $TMPDIR/t5s4.log`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `pnpm test:run 2>&1 | tee $TMPDIR/t5s5.log`
Expected: PASS

- [ ] **Step 6: Commit**

```
git add lib/backends/agencyGenerator.ts lib/formatter.test.ts
git commit -m "feat(formatter): wrap long import statements to multi-line"
```

---

### Task 6: Import sorting

**Files:**
- Modify: `lib/backends/agencyGenerator.ts` — `generate` method (~line 86), add new fields/methods
- Test: `lib/formatter.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `lib/formatter.test.ts`:

```ts
it("sorts imports into groups: stdlib, packages, relative", () => {
  const input = [
    'import { bar } from "./bar.agency"',
    'import { bash } from "std::shell"',
    'import { foo } from "./foo.js"',
    'import { mcp } from "pkg::@agency-lang/mcp"',
    'node main() {',
    '  print(1)',
    '}',
  ].join("\n") + "\n";
  const formatted = formatSource(input);
  const lines = formatted!.split("\n");
  // stdlib first
  expect(lines[0]).toBe('import { bash } from "std::shell"');
  // blank line
  expect(lines[1]).toBe('');
  // packages
  expect(lines[2]).toBe('import { mcp } from "pkg::@agency-lang/mcp"');
  // blank line
  expect(lines[3]).toBe('');
  // relative (alphabetized)
  expect(lines[4]).toBe('import { bar } from "./bar.agency"');
  expect(lines[5]).toBe('import { foo } from "./foo.js"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/formatter.test.ts 2>&1 | tee $TMPDIR/t6s2.log`

- [ ] **Step 3: Implement import sorting**

Instead of collecting rendered import strings during node processing, collect the raw AST nodes and sort/render them together at the end. This avoids the fragile regex-extraction approach.

Add a new field to `AgencyGenerator`:

```ts
protected importNodes: ImportStatement[] = [];
```

In `processNode`, change the `importStatement` case to collect the AST node instead of rendering immediately:

```ts
case "importStatement":
  this.importNodes.push(node);
  return "";
```

Remove the old `this.importStatements.push(this.processImportStatement(node))` line.

Add a `sortAndRenderImports` method:

```ts
private sortAndRenderImports(): string {
  type ImportEntry = { node: ImportStatement | ImportNodeStatement; modulePath: string; kind: "node" | "regular" };

  const stdlib: ImportEntry[] = [];
  const packages: ImportEntry[] = [];
  const relative: ImportEntry[] = [];

  for (const node of this.importNodes) {
    const entry: ImportEntry = { node, modulePath: node.modulePath, kind: "regular" };
    if (node.modulePath.startsWith("std::")) {
      stdlib.push(entry);
    } else if (node.modulePath.startsWith("pkg::")) {
      packages.push(entry);
    } else {
      relative.push(entry);
    }
  }

  for (const node of this.importedNodes) {
    relative.push({ node, modulePath: node.agencyFile, kind: "node" });
  }

  const sort = (arr: ImportEntry[]) =>
    arr.sort((a, b) => a.modulePath.localeCompare(b.modulePath));
  sort(stdlib);
  sort(packages);
  sort(relative);

  const render = (entry: ImportEntry) =>
    entry.kind === "node"
      ? this.processImportNodeStatement(entry.node as ImportNodeStatement)
      : this.processImportStatement(entry.node as ImportStatement);

  const groups = [stdlib, packages, relative]
    .filter((g) => g.length > 0)
    .map((g) => g.map(render).join("\n"));
  return groups.join("\n\n");
}
```

In the `generate` method (~line 154), replace:

```ts
this.addIfNonEmpty(this.importStatements.join("\n"), output);
```

With:

```ts
this.addIfNonEmpty(this.sortAndRenderImports(), output);
```

Remove `this.importStatements` from the class fields since it's no longer used (or keep it if the TypeScript builder subclass still needs it — check first).

- [ ] **Step 4: Run tests**

Run: `pnpm test:run lib/formatter.test.ts 2>&1 | tee $TMPDIR/t6s4.log`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `pnpm test:run 2>&1 | tee $TMPDIR/t6s5.log`
Expected: PASS

- [ ] **Step 6: Commit**

```
git add lib/backends/agencyGenerator.ts lib/formatter.test.ts
git commit -m "feat(formatter): sort imports into stdlib/packages/relative groups"
```

---

### Task 7: Update roundtrip fixture and final verification

**Files:**
- Modify: `tests/formatter/roundtrip.agency`
- Test: `lib/formatter.test.ts`

- [ ] **Step 1: Add wrapping and sorting examples to the roundtrip fixture**

Update `tests/formatter/roundtrip.agency` to include:
- A function with a long signature that wraps
- A function call with long arguments that wraps
- A long import that wraps
- Imports in the correct sorted order

Run the formatter on the fixture: `pnpm run fmt tests/formatter/roundtrip.agency 2>/dev/null`

Copy the formatted output back as the new fixture content. The round-trip test asserts that formatting a correctly-formatted file produces identical output.

- [ ] **Step 2: Run all formatter tests**

Run: `pnpm test:run lib/formatter.test.ts 2>&1 | tee $TMPDIR/t7s2.log`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `pnpm test:run 2>&1 | tee $TMPDIR/t7s3.log`
Expected: All 2344+ tests PASS

- [ ] **Step 4: Commit**

```
git add tests/formatter/roundtrip.agency lib/formatter.test.ts
git commit -m "feat(formatter): update roundtrip fixture with wrapping examples"
```

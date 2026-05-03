import path from "path";
import fs from "fs";
import { CompletionItem, CompletionItemKind, InsertTextFormat } from "vscode-languageserver-protocol";
import { CompilationUnit, GLOBAL_SCOPE_KEY } from "../compilationUnit.js";
import { formatTypeHint } from "../cli/util.js";
import { resolveType } from "../typeChecker/assignability.js";
import type { AgencyProgram, FunctionParameter, VariableType } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import { resolveTypeAtPosition } from "./typeResolution.js";
import { findContainingScope } from "./scopeResolution.js";
import { offsetOfLine } from "./util.js";
import { getStdlibFiles } from "../importPaths.js";

function formatParams(params: FunctionParameter[]): string {
  return params
    .map((p) => `${p.name}${p.typeHint ? `: ${formatTypeHint(p.typeHint)}` : ""}`)
    .join(", ");
}

function formatDetail(params: FunctionParameter[], returnType: VariableType | null | undefined): string {
  const ret = returnType ? `: ${formatTypeHint(returnType)}` : "";
  return `(${formatParams(params)})${ret}`;
}

export type CompletionContext = {
  source: string;
  line: number;
  character: number;
  scopes: ScopeInfo[];
  program: AgencyProgram;
  fsPath: string;
};

export function getCompletions(info: CompilationUnit, context?: CompletionContext): CompletionItem[] {
  if (context) {
    const importItems = getImportPathCompletions(context);
    if (importItems) return importItems;

    const dotItems = getDotCompletions(context, info);
    if (dotItems) return dotItems;
  }

  const seen = new Set<string>();
  const items: CompletionItem[] = [];

  function add(label: string, kind: CompletionItemKind, detail?: string, documentation?: string) {
    if (!seen.has(label)) {
      seen.add(label);
      const item: CompletionItem = { label, kind };
      if (detail) item.detail = detail;
      if (documentation) item.documentation = documentation;
      items.push(item);
    }
  }

  for (const [name, def] of Object.entries(info.functionDefinitions)) {
    const detail = formatDetail(def.parameters, def.returnType);
    const doc = def.docString?.value;
    add(name, CompletionItemKind.Function, detail, doc);
  }

  for (const node of info.graphNodes) {
    const detail = formatDetail(node.parameters, node.returnType);
    add(node.nodeName, CompletionItemKind.Module, detail);
  }

  const globalAliases = info.typeAliases.get(GLOBAL_SCOPE_KEY);
  if (globalAliases) {
    for (const [name, vt] of Object.entries(globalAliases)) {
      add(name, CompletionItemKind.TypeParameter, `= ${formatTypeHint(vt)}`);
    }
  }

  for (const name of Object.keys(info.classDefinitions)) {
    add(name, CompletionItemKind.Class);
  }

  for (const [name, sig] of Object.entries(info.importedFunctions)) {
    const detail = formatDetail(sig.parameters, sig.returnType);
    add(name, CompletionItemKind.Function, detail);
  }

  // Snippet templates
  for (const snippet of SNIPPETS) {
    items.push(snippet);
  }

  return items;
}

const SNIPPETS: CompletionItem[] = [
  {
    label: "def",
    kind: CompletionItemKind.Snippet,
    insertText: "def ${1:name}(${2:params}) {\n  $0\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Function definition",
  },
  {
    label: "export def",
    kind: CompletionItemKind.Snippet,
    insertText: "export def ${1:name}(${2:params}) {\n  $0\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Exported function definition",
  },
  {
    label: "node",
    kind: CompletionItemKind.Snippet,
    insertText: "node ${1:name}(${2:params}) {\n  $0\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Graph node definition",
  },
  {
    label: "export node",
    kind: CompletionItemKind.Snippet,
    insertText: "export node ${1:name}(${2:params}) {\n  $0\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Exported graph node",
  },
  {
    label: "type",
    kind: CompletionItemKind.Snippet,
    insertText: "type ${1:Name} = {\n  ${2:field}: ${3:string}\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Type alias",
  },
  {
    label: "class",
    kind: CompletionItemKind.Snippet,
    insertText: "class ${1:Name} {\n  ${2:field}: ${3:string}\n\n  def ${4:method}() {\n    $0\n  }\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Class definition",
  },
  {
    label: "if",
    kind: CompletionItemKind.Snippet,
    insertText: "if (${1:condition}) {\n  $0\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "If statement",
  },
  {
    label: "for",
    kind: CompletionItemKind.Snippet,
    insertText: "for (${1:item} in ${2:items}) {\n  $0\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "For loop",
  },
  {
    label: "while",
    kind: CompletionItemKind.Snippet,
    insertText: "while (${1:condition}) {\n  $0\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "While loop",
  },
  {
    label: "match",
    kind: CompletionItemKind.Snippet,
    insertText: "match(${1:value}) {\n  \"${2:case1}\" => $3\n  _ => $0\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Pattern matching",
  },
  {
    label: "thread",
    kind: CompletionItemKind.Snippet,
    insertText: "thread {\n  ${1:name}: ${2:Type} = llm(\"${3:prompt}\")\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Message thread with LLM call",
  },
  {
    label: "fork",
    kind: CompletionItemKind.Snippet,
    insertText: "fork(${1:items}) as ${2:item} {\n  $0\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Parallel fork over items",
  },
  {
    label: "map",
    kind: CompletionItemKind.Snippet,
    insertText: "map(${1:items}) as ${2:item} {\n  $0\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Map with block argument",
  },
  {
    label: "handle",
    kind: CompletionItemKind.Snippet,
    insertText: "handle {\n  $1\n} with (${2:data}) {\n  $0\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Handler block for interrupts",
  },
  {
    label: "parallel",
    kind: CompletionItemKind.Snippet,
    insertText: "parallel {\n  $0\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Run statements in parallel",
  },
  {
    label: "seq",
    kind: CompletionItemKind.Snippet,
    insertText: "seq {\n  $0\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Run statements sequentially",
  },
  {
    label: "import",
    kind: CompletionItemKind.Snippet,
    insertText: "import { ${1:name} } from \"${2:module}\"",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Import statement",
  },
  {
    label: "llm",
    kind: CompletionItemKind.Snippet,
    insertText: "${1:name}: ${2:Type} = llm(\"${3:prompt}\")",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "LLM call with typed result",
  },
  {
    label: "interrupt",
    kind: CompletionItemKind.Snippet,
    insertText: "interrupt(\"${1:message}\")",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Pause execution for approval",
  },
];

// Lazily cached stdlib module names
let stdlibModules: string[] | null = null;

function getStdlibModules(): string[] {
  if (stdlibModules) return stdlibModules;
  stdlibModules = getStdlibFiles().map((f) => "std::" + path.basename(f, ".agency"));
  return stdlibModules;
}

function getImportPathCompletions(context: CompletionContext): CompletionItem[] | null {
  const { source, line, character, fsPath } = context;
  const currentLine = source.split("\n")[line] ?? "";

  // Detect if cursor is inside an import path string: from "...|"
  const beforeCursor = currentLine.slice(0, character);
  const importMatch = beforeCursor.match(/from\s+["']([^"']*)$/);
  if (!importMatch) return null;

  const partial = importMatch[1];
  const items: CompletionItem[] = [];

  // Range to replace: from the start of the partial to the cursor
  const replaceStart = character - partial.length;
  const range = {
    start: { line, character: replaceStart },
    end: { line, character },
  };

  // Suggest std:: modules (only after the user starts typing)
  if (partial.length > 0 && "std::".startsWith(partial.slice(0, 5))) {
    for (const mod of getStdlibModules()) {
      if (mod.startsWith(partial)) {
        items.push({
          label: mod,
          kind: CompletionItemKind.Module,
          detail: "Standard library",
          textEdit: { range, newText: mod },
        });
      }
    }
  }

  // Suggest relative .agency files (after typing "." or "./")
  if (partial.startsWith(".")) {
    const dir = path.dirname(fsPath);
    const relPrefix = partial || "./";
    const resolvedDir = path.resolve(dir, relPrefix.endsWith("/") ? relPrefix : path.dirname(relPrefix));

    try {
      const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;

        if (entry.isDirectory()) {
          const relPath = "./" + path.relative(dir, path.join(resolvedDir, entry.name)).split(path.sep).join("/") + "/";
          items.push({
            label: relPath,
            kind: CompletionItemKind.Folder,
            textEdit: { range, newText: relPath },
          });
        } else if (entry.name.endsWith(".agency") && path.join(resolvedDir, entry.name) !== fsPath) {
          const relPath = "./" + path.relative(dir, path.join(resolvedDir, entry.name)).split(path.sep).join("/");
          items.push({
            label: relPath,
            kind: CompletionItemKind.File,
            detail: "Agency file",
            textEdit: { range, newText: relPath },
          });
        }
      }
    } catch {
      // Directory doesn't exist or not readable
    }
  }

  return items.length > 0 ? items : null;
}

function getDotCompletions(context: CompletionContext, info: CompilationUnit): CompletionItem[] | null {
  const { source, line, character, scopes, program } = context;
  const lines = source.split("\n");
  const currentLine = lines[line] ?? "";

  // Check if cursor is right after "variable."
  const beforeCursor = currentLine.slice(0, character);
  const dotMatch = beforeCursor.match(/([a-zA-Z_][a-zA-Z0-9_]*)\.$/);
  if (!dotMatch) return null;

  const varName = dotMatch[1];
  const varCol = dotMatch.index!;

  const varType = resolveTypeAtPosition(source, line, varCol, program, scopes);
  if (!varType) return null;

  const offset = offsetOfLine(source, line) + character;
  const containingScope = findContainingScope(offset, scopes, program);
  const scopeKey = containingScope?.scopeKey ?? GLOBAL_SCOPE_KEY;
  const aliases = info.typeAliases.visibleIn(scopeKey);
  const resolved = resolveType(varType, aliases);
  if (resolved.type !== "objectType") return null;

  return resolved.properties.map((prop) => ({
    label: prop.key,
    kind: CompletionItemKind.Field,
    detail: formatTypeHint(prop.value),
  }));
}


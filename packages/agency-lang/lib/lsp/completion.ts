import { CompletionItem, CompletionItemKind, InsertTextFormat } from "vscode-languageserver-protocol";
import { CompilationUnit, GLOBAL_SCOPE_KEY } from "../compilationUnit.js";
import { formatTypeHint } from "../cli/util.js";
import { resolveType } from "../typeChecker/assignability.js";
import type { AgencyProgram, FunctionParameter, VariableType } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import { resolveTypeAtPosition } from "./typeResolution.js";
import { findContainingScope } from "./scopeResolution.js";
import { offsetOfLine } from "./util.js";

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
};

export function getCompletions(info: CompilationUnit, context?: CompletionContext): CompletionItem[] {
  if (context) {
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
    label: "node",
    kind: CompletionItemKind.Snippet,
    insertText: "node ${1:name}(${2:params}) {\n  $0\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Graph node definition",
  },
  {
    label: "type",
    kind: CompletionItemKind.Snippet,
    insertText: "type ${1:Name} = {\n  ${2:field}: ${3:string}\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Type alias",
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
    label: "thread",
    kind: CompletionItemKind.Snippet,
    insertText: "thread {\n  ${1:name}: ${2:Type} = llm(\"${3:prompt}\")\n}",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Message thread with LLM call",
  },
  {
    label: "import",
    kind: CompletionItemKind.Snippet,
    insertText: "import { ${1:name} } from \"${2:module}\"",
    insertTextFormat: InsertTextFormat.Snippet,
    detail: "Import statement",
  },
];

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


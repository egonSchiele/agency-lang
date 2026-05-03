import { CompletionItem, CompletionItemKind } from "vscode-languageserver-protocol";
import { CompilationUnit, GLOBAL_SCOPE_KEY } from "../compilationUnit.js";
import { formatTypeHint } from "../cli/util.js";
import { resolveType } from "../typeChecker/assignability.js";
import type { AgencyProgram, FunctionParameter, VariableType } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import { resolveTypeAtPosition } from "./typeResolution.js";
import { findContainingScope } from "./scopeResolution.js";

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

  return items;
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

  // Use scoped aliases (visible from the cursor's containing scope)
  const offset = source.split("\n").slice(0, line).reduce((acc, l) => acc + l.length + 1, 0) + character;
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


import { CompletionItem, CompletionItemKind } from "vscode-languageserver-protocol";
import { ProgramInfo, GLOBAL_SCOPE_KEY } from "../programInfo.js";

export function getCompletions(info: ProgramInfo): CompletionItem[] {
  const seen = new Set<string>();
  const items: CompletionItem[] = [];

  function add(label: string, kind: CompletionItemKind) {
    if (!seen.has(label)) {
      seen.add(label);
      items.push({ label, kind });
    }
  }

  for (const name of Object.keys(info.functionDefinitions)) {
    add(name, CompletionItemKind.Function);
  }

  for (const node of info.graphNodes) {
    add(node.nodeName, CompletionItemKind.Module);
  }

  const globalAliases = info.typeAliases[GLOBAL_SCOPE_KEY];
  if (globalAliases) {
    for (const name of Object.keys(globalAliases)) {
      add(name, CompletionItemKind.TypeParameter);
    }
  }

  for (const name of Object.keys(info.classDefinitions)) {
    add(name, CompletionItemKind.Class);
  }

  for (const name of Object.keys(info.importedFunctions)) {
    add(name, CompletionItemKind.Function);
  }

  return items;
}

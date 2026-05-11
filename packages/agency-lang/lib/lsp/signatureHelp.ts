import {
  SignatureHelp,
  SignatureHelpParams,
  SignatureInformation,
  ParameterInformation,
} from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { SemanticIndex } from "./semantics.js";
import { formatTypeHint } from "../utils/formatType.js";

export function handleSignatureHelp(
  params: SignatureHelpParams,
  doc: TextDocument,
  semanticIndex: SemanticIndex,
): SignatureHelp | null {
  const offset = doc.offsetAt(params.position);
  const text = doc.getText().slice(0, offset);

  const ctx = findCallContext(text);
  if (!ctx) return null;

  const symbol = semanticIndex[ctx.functionName];
  if (!symbol || !symbol.parameters) return null;

  const paramInfos: ParameterInformation[] = symbol.parameters.map((p) => ({
    label: p.name + (p.typeHint ? `: ${formatTypeHint(p.typeHint)}` : ""),
  }));

  const paramStr = paramInfos.map((p) => p.label).join(", ");
  const ret = symbol.returnType ? `: ${formatTypeHint(symbol.returnType)}` : "";
  const label = `${ctx.functionName}(${paramStr})${ret}`;

  const sig: SignatureInformation = {
    label,
    parameters: paramInfos,
  };

  return {
    signatures: [sig],
    activeSignature: 0,
    activeParameter: ctx.argIndex,
  };
}

type CallContext = {
  functionName: string;
  argIndex: number;
};

function findCallContext(textBeforeCursor: string): CallContext | null {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let commaCount = 0;

  for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
    const ch = textBeforeCursor[i];
    if (ch === ")") parenDepth++;
    else if (ch === "]") bracketDepth++;
    else if (ch === "}") braceDepth++;
    else if (ch === "[") bracketDepth--;
    else if (ch === "{") braceDepth--;
    else if (ch === "(") {
      if (parenDepth > 0) {
        parenDepth--;
      } else {
        const before = textBeforeCursor.slice(0, i).trimEnd();
        const match = before.match(/([a-zA-Z_][a-zA-Z0-9_]*)$/);
        if (!match) return null;
        return { functionName: match[1], argIndex: commaCount };
      }
    } else if (ch === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      commaCount++;
    }
  }

  return null;
}

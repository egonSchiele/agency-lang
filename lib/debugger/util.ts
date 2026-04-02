import type { FunctionParameter } from "../types.js";
import type { DebuggerCommand } from "./types.js";

export function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") {
    try {
      const s = JSON.stringify(value);
      if (s.length > 60) return s.slice(0, 57) + "...";
      return s;
    } catch {
      return "[object]";
    }
  }
  return String(value);
}

export function getPrimitiveType(param: FunctionParameter): string | null {
  if (!param.typeHint) return null;
  if (param.typeHint.type === "primitiveType") return param.typeHint.value;
  return null;
}

export function coerceArg(raw: string, param: FunctionParameter): unknown {
  const prim = getPrimitiveType(param);
  if (prim === "number") {
    const num = Number(raw);
    if (!isNaN(num)) return num;
  }
  if (prim === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
  }
  // Try JSON parse for objects/arrays
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function parseCommandInput(input: string): DebuggerCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // set x = 42
  const setMatch = trimmed.match(/^set\s+(\w+)\s*=\s*(.+)$/);
  if (setMatch) {
    const varName = setMatch[1];
    let value: unknown;
    try {
      value = JSON.parse(setMatch[2]);
    } catch {
      value = setMatch[2]; // Treat as string if not valid JSON
    }
    return { type: "set", varName, value };
  }

  // checkpoint "label"
  const cpMatch = trimmed.match(/^checkpoint(?:\s+"([^"]*)")?$/);
  if (cpMatch) {
    return { type: "checkpoint", label: cpMatch[1] || undefined };
  }

  // print varname
  const printMatch = trimmed.match(/^print\s+(\w+)$/);
  if (printMatch) {
    return { type: "print", varName: printMatch[1] };
  }

  // reject [value]
  const rejectMatch = trimmed.match(/^reject(?:\s+(.+))?$/);
  if (rejectMatch) {
    let value: unknown;
    if (rejectMatch[1]) {
      try {
        value = JSON.parse(rejectMatch[1]);
      } catch {
        value = rejectMatch[1];
      }
    }
    return { type: "reject", value };
  }

  // resolve <value>
  const resolveMatch = trimmed.match(/^resolve\s+(.+)$/);
  if (resolveMatch) {
    let value: unknown;
    try {
      value = JSON.parse(resolveMatch[1]);
    } catch {
      value = resolveMatch[1];
    }
    return { type: "resolve", value };
  }

  // modify key=value [key=value ...]
  const modifyMatch = trimmed.match(/^modify\s+(.+)$/);
  if (modifyMatch) {
    const overrides: Record<string, unknown> = {};
    const pairs = modifyMatch[1].split(/\s+/);
    for (const pair of pairs) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx > 0) {
        const key = pair.slice(0, eqIdx);
        const raw = pair.slice(eqIdx + 1);
        try {
          overrides[key] = JSON.parse(raw);
        } catch {
          overrides[key] = raw;
        }
      }
    }
    return { type: "modify", overrides };
  }

  // save <path>
  const saveMatch = trimmed.match(/^save\s+(.+)$/);
  if (saveMatch) {
    return { type: "save", path: saveMatch[1].trim() };
  }

  // load <path>
  const loadMatch = trimmed.match(/^load\s+(.+)$/);
  if (loadMatch) {
    return { type: "load", path: loadMatch[1].trim() };
  }

  return null;
}

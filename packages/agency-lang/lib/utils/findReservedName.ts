import { isReservedInternalName } from "../reservedNames.js";
import { getImportedNames, type NamedImport } from "../types/importStatement.js";

/**
 * String fields that hold data, where a `__` spelling is legal. Keyed by the
 * record's `type`, or its `kind`, or for a record with neither, the owner's
 * tag and field (`agencyObject.entries`).
 *
 * Every other string field in the tree is treated as a name. A new node kind
 * is therefore checked without anyone adding it here. If it holds data, the
 * walk refuses a legal program, which is a visible failure. The opposite
 * default would let a reserved name through without any sign.
 */
const DATA_FIELDS: Record<string, readonly string[]> = {
  text: ["value"],
  comment: ["content"],
  multiLineComment: ["content"],
  regex: ["pattern"],
  stringLiteralType: ["value"],
  importStatement: ["modulePath"],
  hole: ["name"],
  tag: ["name"],
  namedArgument: ["name"],
  property: ["name"],
  objectPatternProperty: ["key"],
  "agencyObject.entries": ["key"],
  "objectType.properties": ["key"],
  effectDeclaration: ["effect"],
  interruptStatement: ["effect"],
};

type TreeRecord = Record<string, unknown>;

function tagOf(record: TreeRecord, ownerSlot: string): string {
  if (typeof record.type === "string") {
    return record.type;
  }
  if (typeof record.kind === "string") {
    return record.kind;
  }
  return ownerSlot;
}

function isDataField(record: TreeRecord, tag: string, field: string, ownerTag: string): boolean {
  if (DATA_FIELDS[tag]?.includes(field)) {
    return true;
  }
  // A destructuring declaration holds a placeholder here; its binders are in `pattern`.
  if (tag === "assignment" && field === "variableName" && record.pattern !== undefined) {
    return true;
  }
  // `o.__toJSON()` stores the method name as the callee of an ordinary call.
  return tag === "functionCall" && field === "functionName" && ownerTag === "methodCall";
}

function findIn(value: unknown, ownerTag: string, ownerSlot: string): string | null {
  // A string reached here sits in an array, such as an import's list of names.
  if (typeof value === "string") {
    return reservedOrNull(value);
  }
  if (value === null || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    return firstNonNull(value.map((item) => findIn(item, ownerTag, ownerSlot)));
  }
  const record = value as TreeRecord;
  const tag = tagOf(record, ownerSlot);
  if (tag === "namedImport") {
    // `import { __malloc as alloc }` binds only `alloc`. The other fields
    // repeat the exported names.
    return firstNonNull(getImportedNames(record as NamedImport).map(reservedOrNull));
  }
  const fields = Object.entries(record).filter(([field]) => field !== "loc");
  return firstNonNull(
    fields.map(([field, child]) => {
      if (typeof child !== "string") {
        return findIn(child, tag, `${tag}.${field}`);
      }
      return isDataField(record, tag, field, ownerTag) ? null : reservedOrNull(child);
    }),
  );
}

function reservedOrNull(name: string): string | null {
  return isReservedInternalName(name) ? name : null;
}

function firstNonNull(found: (string | null)[]): string | null {
  return found.find((name) => name !== null) ?? null;
}

/**
 * The first name reserved for the compiler anywhere in a syntax tree, or null.
 * For trees the parser never saw, such as a `Code` value built by hand.
 */
export function findReservedName(nodes: unknown): string | null {
  return findIn(nodes, "", "");
}

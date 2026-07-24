/**
 * Semantic tokens — highlighting that needs a typecheck.
 *
 * A TextMate grammar can see `helper(...)` and guess "function". It
 * cannot see that `const f = helper` makes a later bare `f` a function
 * too, because that needs type inference. That case is the reason this
 * file exists.
 *
 * The shape is deliberately a pipeline: walk the AST, ask
 * `identifierSlots` where the names are, resolve each one, sort, encode.
 * No AST knowledge lives here — "where is a name" is owned entirely by
 * `lib/utils/identifierSlots.ts`, so a new node kind is registered in one
 * place rather than being hunted through a switch here.
 */
import { SemanticTokensBuilder } from "vscode-languageserver/node.js";
import type { SemanticTokens } from "vscode-languageserver/node.js";
import type { SymbolKind } from "../symbolTable.js";
import { BUILTIN_FUNCTION_TYPES } from "../typeChecker/builtins.js";
import { PRELUDE_NAMES } from "../prelude.js";
import { walkNodes } from "../utils/node.js";
import { identifierSlots } from "../utils/identifierSlots.js";
import type { IdentifierSlot } from "../utils/identifierSlots.js";
import { findContainingScope } from "./scopeResolution.js";
import type { DocumentState } from "./documentState.js";

/**
 * The wire legend. Indices sent on the wire are positions in these
 * arrays, so the ORDER is part of the protocol contract — an already-open
 * editor holds the legend it was given at initialize time and will
 * re-colour every token if these are reordered. Both the capability
 * announcement and the encoder read these same arrays so no index is
 * ever hand-written. `semanticTokens.test.ts` pins the order.
 */
export const TOKEN_TYPES = ["function"] as const;
export const TOKEN_MODIFIERS = ["defaultLibrary"] as const;

export type TokenType = (typeof TOKEN_TYPES)[number];

export const SEMANTIC_TOKENS_LEGEND = {
  tokenTypes: [...TOKEN_TYPES],
  tokenModifiers: [...TOKEN_MODIFIERS],
};

const FUNCTION_TYPE_INDEX = TOKEN_TYPES.indexOf("function");
const DEFAULT_LIBRARY_BIT = 1 << TOKEN_MODIFIERS.indexOf("defaultLibrary");

/**
 * Which symbol kinds get a function token. `node` shares it because a
 * node call parses as an ordinary `functionCall` — colouring nodes
 * differently would encode a distinction the AST does not make.
 *
 * `type` and `constant` are null: this first version emits function
 * tokens only. Every identifier left uncoloured is one the TextMate
 * grammar still handles, so a narrow table means no visible gaps.
 */
const TOKEN_TYPE_BY_SYMBOL_KIND: Record<SymbolKind, TokenType | null> = {
  function: "function",
  node: "function",
  type: null,
  constant: null,
};

type Token = {
  line: number;
  col: number;
  length: number;
  typeIndex: number;
  modifiers: number;
};

/**
 * Is this name part of the language rather than the user's code? Two
 * registries, because Agency has two kinds of given-to-you function and
 * a theme dimming "library code" wants both: language primitives like
 * `llm` and `success`, and the standard-library prelude auto-imported
 * into every file — `print`, `map`, `filter`.
 *
 * Both are existing single sources of truth, so this reads them rather
 * than restating either. A user who defines their own `print` shadows
 * the prelude one, so a locally declared name is never marked.
 */
function isStandardLibrary(name: string, state: DocumentState): boolean {
  if (state.semanticIndex[name]?.source === "local") return false;
  return (
    Object.prototype.hasOwnProperty.call(BUILTIN_FUNCTION_TYPES, name) ||
    PRELUDE_NAMES.includes(name)
  );
}

/**
 * Does this name refer to a function here? Three sources, in the order
 * that respects shadowing:
 *
 * 1. The enclosing scope's inferred type. A local bound to a function
 *    infers to `functionRefType`, and a local shadowing a top-level
 *    function wins because scope lookup starts innermost.
 * 2. The declaration index, for top-level and imported symbols.
 * 3. The call syntax itself. `name(...)` is a call whatever we know
 *    about `name`, which covers builtins and unresolved imports.
 */
function isFunctionReference(slot: IdentifierSlot, state: DocumentState): boolean {
  const containingScope = findContainingScope(
    slot.scopeOffset,
    state.scopes,
    state.program,
  );
  const inferred = containingScope?.scope.lookup(slot.name);
  if (inferred && (inferred as { type?: string }).type === "functionRefType") {
    return true;
  }

  const declared = state.semanticIndex[slot.name];
  if (declared && TOKEN_TYPE_BY_SYMBOL_KIND[declared.kind] === "function") {
    return true;
  }

  return slot.isCall;
}

function toToken(slot: IdentifierSlot, state: DocumentState): Token | null {
  if (!isFunctionReference(slot, state)) return null;
  return {
    line: slot.line,
    col: slot.col,
    // The identifier's own length. A node's loc spans the whole node, so
    // `end - start` would paint a call's arguments too.
    length: slot.name.length,
    typeIndex: FUNCTION_TYPE_INDEX,
    modifiers: isStandardLibrary(slot.name, state) ? DEFAULT_LIBRARY_BIT : 0,
  };
}

/**
 * Source order. This is load-bearing, not tidiness: `SemanticTokensBuilder`
 * subtracts from whatever was pushed last and never sorts, so an
 * out-of-order push produces negative deltas and silently garbled colour.
 * `walkNodes` genuinely yields out of source order — an assignment yields
 * its value before the target's access chain, so `obj[i] = f()` walks `f`
 * before `i`.
 */
function byPosition(a: Token, b: Token): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.col - b.col;
}

export function getSemanticTokens(state: DocumentState): SemanticTokens {
  const slots = [...walkNodes(state.program.nodes)].flatMap(({ node }) =>
    identifierSlots(node),
  );

  const tokens = slots
    .map((slot) => toToken(slot, state))
    .filter((token): token is Token => token !== null)
    .sort(byPosition);

  const builder = new SemanticTokensBuilder();
  for (const token of tokens) {
    builder.push(
      token.line,
      token.col,
      token.length,
      token.typeIndex,
      token.modifiers,
    );
  }
  return builder.build();
}

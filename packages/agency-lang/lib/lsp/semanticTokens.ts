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
import { makeScopeFinder } from "./scopeResolution.js";
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

/** Resolves an offset to its innermost scope. Built once per document —
 *  building it per identifier is what made this quadratic. */
type ScopeFinder = ReturnType<typeof makeScopeFinder>;

/** What the scope says this name is bound to here, if anything. A name
 *  bound to a function infers to `functionRefType`, whose own `name` is
 *  the function it refers to — `const f = helper` resolves to
 *  `functionRefType{ name: "helper" }`. */
function resolveFunctionRef(
  slot: IdentifierSlot,
  findScope: ScopeFinder,
): { name: string } | null {
  const inferred = findScope(slot.scopeOffset)?.scope.lookup(slot.name);
  if (inferred && (inferred as { type?: string }).type === "functionRefType") {
    return inferred as unknown as { name: string };
  }
  return null;
}

/** Does the file declare or import this name itself? `Object.hasOwn`
 *  rather than a lookup, because the index is a plain object and a
 *  name like `constructor` would otherwise read off the prototype. */
function isDeclaredInFile(name: string, state: DocumentState): boolean {
  return Object.hasOwn(state.semanticIndex, name);
}

/**
 * Is this name part of the language rather than the user's code? Two
 * registries, because Agency has two kinds of given-to-you function and
 * a theme dimming "library code" wants both: language primitives like
 * `llm` and `success`, and the standard-library prelude auto-imported
 * into every file — `print`, `map`, `filter`.
 *
 * Both are existing single sources of truth, so this reads them rather
 * than restating either.
 *
 * Two ways a user can hold a stdlib NAME without meaning the stdlib
 * function, and each is handled by asking a different question:
 *
 *   const print = helper   // an alias — the binding resolves to `helper`
 *   def print(...)         // their own function — the file declares it
 *   import { print } from …
 *
 * The first is why the check runs on the RESOLVED name: a scope lookup
 * on that `print` yields `functionRefType{ name: "helper" }`, and a real
 * prelude call resolves to nothing at all, since the prelude is ambient
 * rather than a scope binding. The second is why any name the file
 * declares or imports is excluded outright. Erring toward "not stdlib"
 * is deliberate: failing to dim library code is a smaller wrong than
 * dimming the user's own.
 */
function isStandardLibrary(name: string, state: DocumentState): boolean {
  if (isDeclaredInFile(name, state)) return false;
  return (
    Object.hasOwn(BUILTIN_FUNCTION_TYPES, name) || PRELUDE_NAMES.includes(name)
  );
}

/**
 * Does this name refer to a function here? Three sources, in the order
 * that respects shadowing:
 *
 * 1. The enclosing scope's inferred type, so a local bound to a function
 *    — and a local shadowing a top-level function — wins, because scope
 *    lookup starts innermost.
 * 2. The declaration index, for top-level and imported symbols.
 * 3. The call syntax itself. `name(...)` is a call whatever we know
 *    about `name`, which covers builtins and unresolved imports.
 */
function isFunctionReference(
  slot: IdentifierSlot,
  state: DocumentState,
  resolved: { name: string } | null,
): boolean {
  if (resolved) return true;

  const declared = state.semanticIndex[slot.name];
  if (declared && TOKEN_TYPE_BY_SYMBOL_KIND[declared.kind] === "function") {
    return true;
  }

  return slot.isCall;
}

function toToken(
  slot: IdentifierSlot,
  state: DocumentState,
  findScope: ScopeFinder,
): Token | null {
  const resolved = resolveFunctionRef(slot, findScope);
  if (!isFunctionReference(slot, state, resolved)) return null;

  // The stdlib question is asked of what the name RESOLVES to, not of
  // what was typed — see isStandardLibrary.
  const effectiveName = resolved?.name ?? slot.name;

  return {
    line: slot.line,
    col: slot.col,
    // The identifier's own length. A node's loc spans the whole node, so
    // `end - start` would paint a call's arguments too.
    length: slot.name.length,
    typeIndex: FUNCTION_TYPE_INDEX,
    modifiers: isStandardLibrary(effectiveName, state) ? DEFAULT_LIBRARY_BIT : 0,
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

  const findScope = makeScopeFinder(state.scopes, state.program);
  const tokens = slots
    .map((slot) => toToken(slot, state, findScope))
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

/**
 * identifierSlots — the single source of truth for "which positions of a
 * node hold an identifier REFERENCE, and where in the user's file that
 * identifier sits". The third member of the slot-table family, after
 * `bodySlots` (statement bodies) and `expressionSlots` (expression
 * positions).
 *
 * Why it exists: the same reason as its two siblings. `expressionSlots`
 * records that hand-written expression-position lists drifted and three
 * holes appeared in one week; `bodySlots` records the identical history
 * for statement bodies. Semantic-token highlighting asks the same
 * question one level over — "where are the names?" — and a per-node-kind
 * switch buried in the LSP handler would drift the same way, except the
 * symptom is a missing color, which nobody files a bug about.
 *
 * Consumers:
 *   - `getSemanticTokens` (lib/lsp/semanticTokens.ts)
 *
 * This table answers WHERE a name is, never WHAT it means. Resolving a
 * name to a symbol needs scopes and belongs to the consumer.
 *
 * Two rules the whole table obeys, so no consumer can get them wrong:
 *
 * 1. Positions come from `loc.line` / `loc.col`, which are 0-indexed in
 *    the USER'S file whichever parse mode ran. `loc.start` / `loc.end`
 *    are offsets into whatever the parser actually saw, which differs
 *    between the two modes. See docs/dev/locations.md — and note it says
 *    the LSP's choice of mode is historical and could change, which is
 *    exactly why nothing here may depend on it. `scopeOffset` is safe
 *    because it is only ever compared with offsets from the same parse.
 * 2. A slot's length is the identifier's own length, taken by the
 *    consumer from `name`. A node's `loc` spans the WHOLE node — a
 *    functionCall's loc covers `helper(y)`, not `helper` — so
 *    `end - start` would paint the arguments.
 *
 * Completeness is enforced by the compiler, not by review: the registry
 * below is a `Record<AgencyNode["type"], …>`, so adding a node kind to
 * the language fails to compile until it is registered here. That is
 * strictly stronger than the runtime lists `expressionSlots` uses, and
 * it fails by name in the same way.
 */
import type { AgencyNode } from "../types.js";
import { isNullLiteral } from "./node.js";

export type IdentifierSlot = {
  /** The identifier text as written. Also the token's length. */
  name: string;
  /** 0-based line in the user's file. */
  line: number;
  /** 0-based column of the identifier's first character. */
  col: number;
  /** Offset for `findContainingScope`. Only comparable against other
   *  offsets from the SAME parse — see the parse-mode note in
   *  docs on Background A. */
  scopeOffset: number;
  /** True when the source wrote this as a call, `name(...)`. Lets a
   *  consumer distinguish a call site from a bare reference without
   *  re-inspecting the AST. */
  isCall: boolean;
};

/** Extracts the identifier references a node contributes itself. Child
 *  nodes are NOT visited here — `walkNodes` reaches them and asks this
 *  table about each one in turn. */
type SlotExtractor = (node: any) => IdentifierSlot[];

/**
 * Nodes reached through a `valueAccess` — its base and the calls in its
 * chain — carry no `loc` from the parser. `obj.a` and
 * `helper(1).invoke()` produce a single located `valueAccess` node whose
 * children have no position at all.
 *
 * That gap is handled by the `loc` guards below rather than by a special
 * case: `walkNodes` DOES descend into those children, so they arrive
 * here as ordinary `variableName` / `functionCall` nodes, and the guard
 * drops them for want of a position. When the parser starts carrying
 * `loc` on them, they will begin producing slots with no change to this
 * file. `semanticTokens.test.ts` has a tripwire test that fails at that
 * moment.
 */
const located = (node: { loc?: { line: number; col: number; start: number } }) =>
  node.loc !== undefined;

const variableNameSlots: SlotExtractor = (node) => {
  // The parser has no `null` literal node — it represents `null` as a
  // variableName (see isNullLiteral in node.ts). It is a keyword, not a
  // reference to anything.
  if (isNullLiteral(node)) return [];
  if (!located(node)) return [];
  return [
    {
      name: node.value,
      line: node.loc.line,
      col: node.loc.col,
      scopeOffset: node.loc.start,
      isCall: false,
    },
  ];
};

const functionCallSlots: SlotExtractor = (node) => {
  // In templates `functionName` can be an identifier hole rather than a
  // string. A hole stands for a name it does not yet have.
  if (typeof node.functionName !== "string") return [];
  if (!located(node)) return [];
  // A functionCall's loc.col points at the first character of the
  // callee, which is what we want; its loc.end points past the closing
  // paren, which is why length comes from the name instead.
  return [
    {
      name: node.functionName,
      line: node.loc.line,
      col: node.loc.col,
      scopeOffset: node.loc.start,
      isCall: true,
    },
  ];
};

const none: SlotExtractor = () => [];

/**
 * Every `AgencyNode` kind, mapped to what identifier references it
 * contributes. `none` means "this kind holds no identifier reference of
 * its own" — which is the answer for the large majority, because their
 * names are either declarations (see below) or live in child nodes that
 * `walkNodes` visits separately.
 *
 * DECLARATION sites are deliberately absent. `def helper` and
 * `node main` are purely syntactic: a TextMate grammar colors them
 * correctly without a typecheck, and their `loc.col` points at the
 * keyword rather than the name, so emitting them would mean re-deriving
 * the name offset from keyword length. Semantic tokens exist here to
 * cover what the grammar CANNOT know, and declarations are not that.
 */
const REGISTRY: Record<AgencyNode["type"], SlotExtractor> = {
  variableName: variableNameSlots,
  functionCall: functionCallSlots,

  // Declarations — see the note above.
  function: none,
  graphNode: none,
  typeAlias: none,
  effectDeclaration: none,

  // Container nodes: their identifiers live in children that walkNodes
  // descends into, so each child arrives here on its own.
  assignment: none,
  valueAccess: none,
  binOpExpression: none,
  agencyArray: none,
  agencyObject: none,
  string: none,
  multiLineString: none,
  returnStatement: none,
  matchYield: none,
  matchBlock: none,
  gotoStatement: none,
  ifElse: none,
  whileLoop: none,
  forLoop: none,
  comprehension: none,
  messageThread: none,
  parallelBlock: none,
  seqBlock: none,
  handleBlock: none,
  finalizeBlock: none,
  guardBlock: none,
  withModifier: none,
  staticStatement: none,
  blockArgument: none,
  tryExpression: none,
  newExpression: none,
  interruptStatement: none,
  isExpression: none,
  typeTestExpression: none,

  // Import statements name symbols, but as strings with no per-name
  // loc — there is no position to emit.
  importStatement: none,
  importNodeStatement: none,
  exportFromStatement: none,

  // Leaves and non-code nodes.
  number: none,
  unitLiteral: none,
  boolean: none,
  null: none,
  regex: none,
  schemaExpression: none,
  comment: none,
  multiLineComment: none,
  newLine: none,
  rawCode: none,
  skill: none,
  keyword: none,
  tag: none,
  debuggerStatement: none,
  awaitPending: none,
  markDestructiveRan: none,
  hole: none,

  // Patterns bind names, they do not reference them.
  objectPattern: none,
  arrayPattern: none,
  restPattern: none,
  wildcardPattern: none,
  resultPattern: none,
  typePattern: none,
};

/** The identifier references this node contributes itself. */
export function identifierSlots(node: AgencyNode): IdentifierSlot[] {
  const extractor = REGISTRY[node.type];
  // Unreachable while the Record above type-checks; a runtime guard for
  // AST nodes synthesized outside the union (templates, tests).
  if (!extractor) return [];
  return extractor(node);
}

/** Exported for the completeness test. */
export const REGISTERED_IDENTIFIER_KINDS = Object.keys(REGISTRY);

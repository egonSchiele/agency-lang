import type { AgencyNode, StaticStatement } from "../types.js";

/**
 * May this node sit at the top level of a file?
 *
 * Top-level code is initialization, not execution: it runs in the init
 * phases, which have no step machinery. So a node may ESTABLISH something —
 * bind a name, call for effect — but may not CONTROL anything.
 *
 * The `Record<AgencyNode["type"], …>` is the point: a new node kind fails to
 * compile until someone decides. The bug this exists to stop is a statement
 * form nobody considered reaching the backend and crashing it.
 *
 * Answers legality only. Where a node is EMITTED is a different question,
 * owned by `TOP_LEVEL_DECLARATION_TYPES` in the builder.
 */
const LEGAL_AT_TOP_LEVEL: Record<AgencyNode["type"], boolean> = {
  // Declarations.
  graphNode: true,
  function: true,
  typeAlias: true,
  effectDeclaration: true,
  importStatement: true,
  importNodeStatement: true,
  exportFromStatement: true,
  skill: true,
  tag: true,

  // Bindings and expression statements.
  assignment: true,
  functionCall: true,
  valueAccess: true,
  binOpExpression: true,
  keyword: true,
  // `foo() with approve` at module scope. This hit the same crash and was
  // made to WORK rather than refused — partitionProgram special-cases it
  // (issue #229), which is the other way to answer this question.
  withModifier: true,

  // `static <inner>` — judged by its inner statement, see below.
  staticStatement: true,

  // Trivia.
  comment: true,
  multiLineComment: true,
  newLine: true,

  // Literal forms, which the top-level grammar accepts unevenly. These
  // follow what compiles today; refusing more would be a breaking change
  // nobody asked for.
  variableName: true, // bare `debugger` is one of these
  boolean: true,
  null: true,
  number: false, // parse error at top level
  string: false,
  multiLineString: false,
  unitLiteral: false,
  regex: false,

  // `debugger(...)` — the parenthesized form. Crashes today, unlike the
  // bare word above, which is a `variableName`.
  debuggerStatement: false,

  // Control flow: the init phases cannot branch, loop, or wait.
  ifElse: false,
  whileLoop: false,
  forLoop: false,
  matchBlock: false,
  matchYield: false,
  messageThread: false,
  handleBlock: false,
  finalizeBlock: false,
  guardBlock: false,
  parallelBlock: false,
  seqBlock: false,
  tryExpression: false,

  // Node-relative: there is no enclosing node at file scope.
  returnStatement: false,
  gotoStatement: false,

  // Interrupts need a running node. Both spellings compile today and then
  // crash with `__self is not defined`; refusing is the better error.
  interruptStatement: false,

  // Sub-expressions and patterns, which are not statements at all.
  agencyObject: false,
  agencyArray: false,
  comprehension: false,
  newExpression: false,
  schemaExpression: false,
  isExpression: false,
  typeTestExpression: false,
  blockArgument: false,
  awaitPending: false,
  markDestructiveRan: false,
  rawCode: false,
  objectPattern: false,
  arrayPattern: false,
  restPattern: false,
  wildcardPattern: false,
  resultPattern: false,
  typePattern: false,

  // Templates. A hole is refused earlier (AG8001); a code literal is a
  // value, and a splice is replaced before this check runs.
  hole: false,
  codeLiteral: false,
  splice: false,
};

export function isLegalAtTopLevel(node: AgencyNode): boolean {
  // `static print(1)` is legal and `static interrupt(...)` is not, so the
  // wrapper defers to what it wraps.
  if (node.type === "staticStatement") {
    return isLegalAtTopLevel((node as StaticStatement).statement);
  }
  return LEGAL_AT_TOP_LEVEL[node.type];
}

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
  // crash with `__self is not defined`; refusing is the better error. The
  // parser advertises them (staticStatementParser's inner list) and the
  // backend never implemented them — #728.
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

  // Templates. Both ARE legal top-level Agency, and both are handled by a
  // better mechanism than this rule: a program with holes is refused by
  // AG8001, which says so; a splice is replaced by expansion, and one that
  // reaches codegen means a compile path skipped `expandSplices` — a
  // maintainer bug that must not be reported as user error. Saying `false`
  // here shadowed both with advice to "move it inside a node".
  hole: true,
  splice: true,
  // A value, so it never appears as a top-level statement.
  codeLiteral: false,
};

/**
 * How a node reads in a message: `ifElse` means nothing to a user.
 *
 * Lives here so the type checker and the splice checker describe the same
 * node the same way. Lowercase, for use mid-sentence. Unmapped types fall
 * back to their own name, so this fails ugly rather than wrong.
 */
export function describeNodeKind(type: AgencyNode["type"]): string {
  // Null-prototype: keyed by node type strings (house pattern).
  const names: Record<string, string> = Object.assign(Object.create(null), {
    ifElse: "an `if` statement",
    whileLoop: "a `while` loop",
    forLoop: "a `for` loop",
    matchBlock: "a `match` block",
    messageThread: "a `thread` block",
    guardBlock: "a `guard` block",
    finalizeBlock: "a `finalize` block",
    handleBlock: "a handler",
    returnStatement: "a `return`",
    gotoStatement: "a `goto`",
    interruptStatement: "an interrupt",
    debuggerStatement: "a `debugger(...)` statement",
  });
  return Object.hasOwn(names, type) ? names[type] : `a \`${type}\``;
}

export function isLegalAtTopLevel(node: AgencyNode): boolean {
  // `static print(1)` is legal and `static interrupt(...)` is not, so the
  // wrapper defers to what it wraps.
  if (node.type === "staticStatement") {
    return isLegalAtTopLevel((node as StaticStatement).statement);
  }
  return LEGAL_AT_TOP_LEVEL[node.type];
}

import type { AgencyNode, AgencyProgram, Expression, SourceLocation } from "@/types.js";
import type { AgencyObject, AgencyObjectKV } from "@/types/dataStructures.js";
import type {
  DecoratorOrigin,
  FunctionCall,
  FunctionDefinition,
  FunctionParameter,
} from "@/types/function.js";
import type { ReturnStatement } from "@/types/returnStatement.js";
import type { Tag } from "@/types/tag.js";
import { isDecoratorTag } from "@/types/tag.js";
import { declaredName } from "@/types/hole.js";
import { tagsAbove } from "@/utils/tagsAbove.js";
import type { ImportedFunctionSignature } from "@/compilationUnit.js";

/**
 * Lower a decorator tag on a def into a call with the def's body as the
 * block argument (docs/dev/language/decorators.md).
 *
 *     @budgeted(cost: maxCost)
 *     def research(task: string, maxCost: number): Result<string> { BODY }
 *
 * becomes
 *
 *     def research(task: string, maxCost: number): Result<string> {
 *       return budgeted({ name: "research", args: { task: task, maxCost: maxCost } }, cost: maxCost) {
 *         BODY
 *       }
 *     }
 *
 * The `call` record is passed only when the decorator's first parameter is
 * named `call`. Stacked tags nest, outermost first: `@a @b def f` becomes
 * `a(...) { return b(...) { BODY } }`.
 *
 * MUTATES IN PLACE, for the reason guardDesugar.ts gives: the compilation
 * unit built before the TypeChecker constructor runs already holds the def
 * objects, so a copying rewrite would leave it pointing at undecorated
 * bodies. The innermost block reuses the def's own body array, so no
 * reference into the body goes stale either. Idempotent: the tags move from
 * `def.tags` and the top-level list onto `def.decorators`, and a second run
 * finds nothing above or on the def.
 *
 * The pass resolves nothing. `decoratorProblems` is the pure check that
 * says what is wrong with a program's decorators; prepareProgram reports
 * its answer. The desugar lowers the tag whatever the name resolves to.
 */

/** What the lowering needs to know about a decorator: its parameters (to
 *  see whether the first is `call`) and whether it is imported (so the call
 *  carries the scope the resolver expects). */
export type DecoratorSignature = { parameters: FunctionParameter[]; imported: boolean };
export type DecoratorLookup = (name: string) => DecoratorSignature | undefined;

/** The one lookup both callers use, built from the two tables every caller
 *  already has. */
export function decoratorLookup(
  functionDefinitions: Record<string, FunctionDefinition>,
  importedFunctions: Record<string, ImportedFunctionSignature>,
): DecoratorLookup {
  return (name) => {
    const local = functionDefinitions[name];
    if (local) {
      return { parameters: local.parameters, imported: false };
    }
    const imported = importedFunctions[name];
    if (imported) {
      return { parameters: imported.parameters, imported: true };
    }
    return undefined;
  };
}

export type DecoratedDef = { def: FunctionDefinition; tags: Tag[] };

/** Every top-level def with the decorator tags written above it, outermost
 *  first, whether the tags are still standalone nodes or `collectTags` has
 *  already attached them to `def.tags`. A def whose decorators were already
 *  lowered has none above it and is left out. */
export function decoratorsAbove(nodes: AgencyNode[]): DecoratedDef[] {
  return tagsAbove(nodes)
    .filter(
      (entry): entry is { node: FunctionDefinition; tags: Tag[] } =>
        entry.node?.type === "function" && nodes.includes(entry.node),
    )
    .map((entry) => ({
      def: entry.node,
      tags: [...entry.tags, ...(entry.node.tags ?? [])].filter(isDecoratorTag),
    }))
    .filter((entry) => entry.tags.length > 0);
}

/** The body a decorated def gets: one `return` of the outermost decorator
 *  call, each call holding the next as the only statement of its block, and
 *  the def's original body array as the innermost block. Pure: the def is
 *  read, never written. */
export function loweredBody(
  def: FunctionDefinition,
  tags: Tag[],
  lookup: DecoratorLookup,
): AgencyNode[] {
  const target = declaredName(def.functionName);
  const innermostFirst = [...tags].reverse();
  const outermost = innermostFirst.reduce<AgencyNode[]>(
    (body, tag) => [returning(decoratorCall(tag, target, def.parameters, body, lookup), tag.loc)],
    def.body,
  );
  return outermost;
}

function returning(value: Expression, loc: SourceLocation | undefined): ReturnStatement {
  return { type: "returnStatement", value, loc };
}

function decoratorCall(
  tag: Tag,
  target: string,
  parameters: FunctionParameter[],
  body: AgencyNode[],
  lookup: DecoratorLookup,
): FunctionCall {
  const signature = lookup(tag.name);
  const takesCallRecord = signature?.parameters[0]?.name === "call";
  const origin: DecoratorOrigin = { name: tag.name, tagLoc: tag.loc, target };
  const call: FunctionCall = {
    type: "functionCall",
    functionName: tag.name,
    arguments: [
      ...(takesCallRecord ? [callRecord(target, parameters, tag.loc)] : []),
      ...tag.arguments,
    ],
    block: { type: "blockArgument", inline: false, params: [], body },
    loc: tag.loc,
    decorator: origin,
  };
  if (signature?.imported) {
    call.scope = "imported";
  }
  return call;
}

/** `{ name: "<def>", args: { a: a, b: b } }` over the def's parameters,
 *  block-typed ones left out: a block cannot be stored in a record. */
function callRecord(
  target: string,
  parameters: FunctionParameter[],
  loc: SourceLocation | undefined,
): AgencyObject {
  const named = parameters.filter((parameter) => parameter.typeHint?.type !== "blockType");
  const args: AgencyObject = {
    type: "agencyObject",
    entries: named.map((parameter): AgencyObjectKV => ({
      key: parameter.name,
      value: { type: "variableName", value: parameter.name, loc },
    })),
    loc,
  };
  return {
    type: "agencyObject",
    entries: [
      { key: "name", value: { type: "string", segments: [{ type: "text", value: target }], loc } },
      { key: "args", value: args },
    ],
    loc,
  };
}

/** The one function that writes. */
export function desugarDecorators(program: AgencyProgram, lookup: DecoratorLookup): AgencyProgram {
  const decorated = decoratorsAbove(program.nodes);
  for (const { def, tags } of decorated) {
    def.body = loweredBody(def, tags, lookup);
    def.decorators = tags;
    def.tags = (def.tags ?? []).filter((tag) => !tags.includes(tag));
    if (def.tags.length === 0) {
      delete def.tags;
    }
  }
  const lowered = decorated.flatMap((entry) => entry.tags);
  program.nodes = program.nodes.filter((node) => node.type !== "tag" || !lowered.includes(node));
  return program;
}

export type DecoratorProblem = { message: string; loc: SourceLocation | undefined };

/** What the tag was written on, for the misplaced-decorator message. */
const PLACE_PHRASES: Record<string, (node: AgencyNode) => string> = {
  graphNode: (node) => `node '${declaredName((node as { nodeName: string }).nodeName)}'`,
  typeAlias: (node) => `type '${(node as { aliasName: string }).aliasName}'`,
  effectDeclaration: (node) => `effect '${(node as { effect: string }).effect}'`,
};

function placePhrase(node: AgencyNode | null): string {
  if (node === null) {
    return "nothing";
  }
  const phrase = PLACE_PHRASES[node.type];
  return phrase ? phrase(node) : "a statement";
}

/** The tables a program's decorator names resolve against. */
export type DecoratorScope = {
  functionDefinitions: Record<string, FunctionDefinition>;
  importedFunctions: Record<string, ImportedFunctionSignature>;
};

/**
 * Everything wrong with a program's decorators, before or after the
 * lowering: a decorator written on anything but a top-level def, a def that
 * decorates itself, and a decorator name that is neither declared nor
 * imported. Pure; prepareProgram turns the list into diagnostics.
 */
export function decoratorProblems(
  program: AgencyProgram,
  scope: DecoratorScope,
): DecoratorProblem[] {
  const misplaced = tagsAbove(program.nodes)
    .filter((entry) => entry.node?.type !== "function" || !program.nodes.includes(entry.node))
    .flatMap((entry) =>
      entry.tags.filter(isDecoratorTag).map((tag) => ({
        message: `'@${tag.name}' is written on ${placePhrase(entry.node)}, but a decorator goes on a def.`,
        loc: tag.loc,
      })),
    );
  const onDefs = decoratorTagsOnDefs(program.nodes);
  const selfDecorated = onDefs
    .filter(({ def, tag }) => declaredName(def.functionName) === tag.name)
    .map(({ tag }) => ({ message: `'${tag.name}' cannot decorate itself.`, loc: tag.loc }));
  const unknown = onDefs
    .filter(({ tag }) => !isKnownDecorator(tag.name, scope))
    .map(({ def, tag }) => ({
      message: `Unknown decorator '${tag.name}' on '${declaredName(def.functionName)}'. A decorator is a def whose last parameter is a block; declare or import '${tag.name}'.`,
      loc: tag.loc,
    }));
  return [...misplaced, ...selfDecorated, ...unknown];
}

function isKnownDecorator(name: string, scope: DecoratorScope): boolean {
  return (
    Object.hasOwn(scope.functionDefinitions, name) || Object.hasOwn(scope.importedFunctions, name)
  );
}

type TagOnDef = { def: FunctionDefinition; tag: Tag };

/** Every decorator tag paired with its def, wherever the tag is at the
 *  moment: still standalone above the def, attached to `def.tags`, or
 *  already lowered onto `def.decorators`. */
function decoratorTagsOnDefs(nodes: AgencyNode[]): TagOnDef[] {
  const notYetLowered = decoratorsAbove(nodes).flatMap(({ def, tags }) =>
    tags.map((tag) => ({ def, tag })),
  );
  const lowered = nodes
    .filter((node): node is FunctionDefinition => node.type === "function")
    .flatMap((def) => (def.decorators ?? []).map((tag) => ({ def, tag })));
  return [...notYetLowered, ...lowered];
}

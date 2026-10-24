import type { AgencyNode, AgencyProgram, Assignment, Expression, SourceLocation } from "@/types.js";
import type { AgencyObject, AgencyObjectKV, NamedArgument } from "@/types/dataStructures.js";
import type {
  DecoratorOrigin,
  FunctionCall,
  FunctionDefinition,
  FunctionParameter,
} from "@/types/function.js";
import {
  decoratorShapeProblem,
  isBlockParameter,
  isDecoratorDef,
  recordSlotName,
  withDecoratorTypes,
} from "@/types/function.js";
import { diagnostic } from "@/typeChecker/diagnostics.js";
import type { RebindParameters } from "@/types/rebindParameters.js";
import { getImportedNames } from "@/types/importStatement.js";
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
 *       const __call_0 = { name: "research", args: { task: task, maxCost: maxCost } }
 *       return budgeted(cost: maxCost, call: __call_0) {
 *         <rebindParameters>
 *         BODY
 *       }
 *     }
 *
 * The tag's own arguments come first, as written; the `call` record is
 * passed by name after them, so it never competes with a positional tag
 * argument for a slot. The record is built in its own statement, so it is
 * its own step: a resume re-runs the step that calls the decorator, and
 * rebuilding the record there would read parameters the decorator has
 * since rebound. The block takes one parameter, `__args`, the record a
 * decorator may call it with, and starts with a `rebindParameters`
 * statement that stores the def's parameters from it (lib/runtime/rebind.ts).
 * Stacked tags nest, outermost first: `@a @b def f` becomes
 * `const __call_0 = ...; return a(...) { rebind; const __call_1 = ...; return b(...) { rebind; BODY } }`.
 *
 * MUTATES IN PLACE, for the reason guardDesugar.ts gives: the compilation
 * unit built before the TypeChecker constructor runs already holds the def
 * objects, so a copying rewrite would leave it pointing at undecorated
 * bodies. The innermost block holds the def's own statement objects, so no
 * reference into the body goes stale either. Idempotent: the tags move from
 * `def.tags` and the top-level list onto `def.decorators`, and a second run
 * finds nothing above or on the def.
 *
 * The pass resolves nothing. `decoratorProblems` is the pure check that
 * says what is wrong with a program's decorators; prepareProgram reports
 * its answer. The desugar lowers the tag whatever the name resolves to.
 */

/** What the lowering and the checks need to know about a decorator: its
 *  parameters (for the shape check), whether it is imported (so the call
 *  carries the scope the resolver expects), and whether it is declared
 *  `decorator def` at all. */
export type DecoratorSignature = {
  parameters: FunctionParameter[];
  imported: boolean;
  decorator: boolean;
};
export type DecoratorLookup = (name: string) => DecoratorSignature | undefined;

/** The one lookup both callers use, built from the two tables every caller
 *  already has. */
export function decoratorLookup(
  functionDefinitions: Record<string, FunctionDefinition>,
  importedFunctions: Record<string, ImportedFunctionSignature>,
): DecoratorLookup {
  return (name) => {
    if (Object.hasOwn(functionDefinitions, name)) {
      const def = functionDefinitions[name];
      return { parameters: def.parameters, imported: false, decorator: isDecoratorDef(def) };
    }
    if (Object.hasOwn(importedFunctions, name)) {
      const signature = importedFunctions[name];
      return {
        parameters: signature.parameters,
        imported: true,
        decorator: isDecoratorDef(signature),
      };
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

/** The body a decorated def gets: the outermost decorator's record and one
 *  `return` of its call; each block starting with the rebind, then the next
 *  decorator's record and call; and the def's original statements after
 *  the rebind in the innermost block. Pure: the def is read, never written. */
export function loweredBody(
  def: FunctionDefinition,
  tags: Tag[],
  lookup: DecoratorLookup,
): AgencyNode[] {
  const target = declaredName(def.functionName);
  const innermostFirst = [...tags].reverse();
  const outermost = innermostFirst.reduce<AgencyNode[]>((body, tag, index) => {
    const depth = innermostFirst.length - 1 - index;
    const recordName = `${RECORD_LOCAL}${depth}`;
    return [
      recordDeclaration(recordName, target, def.parameters, tag.loc),
      returning(decoratorCall(tag, target, depth, def.parameters, body, lookup), tag.loc),
    ];
  }, def.body);
  return outermost;
}

function returning(value: Expression, loc: SourceLocation | undefined): ReturnStatement {
  return { type: "returnStatement", value, loc };
}

/** `const __call_N = { name: "<def>", args: { ... } }`, the record the
 *  decorator at depth N receives, built once in its own step. */
function recordDeclaration(
  name: string,
  target: string,
  parameters: FunctionParameter[],
  loc: SourceLocation | undefined,
): Assignment {
  return {
    type: "assignment",
    declKind: "const",
    variableName: name,
    value: callRecord(target, parameters, loc),
    loc,
  };
}

function decoratorCall(
  tag: Tag,
  target: string,
  depth: number,
  parameters: FunctionParameter[],
  body: AgencyNode[],
  lookup: DecoratorLookup,
): FunctionCall {
  const recordName = `${RECORD_LOCAL}${depth}`;
  const signature = lookup(tag.name);
  const origin: DecoratorOrigin = { name: tag.name, tagLoc: tag.loc, target };
  const record: NamedArgument = {
    type: "namedArgument",
    name: recordSlotName(signature?.parameters ?? []),
    value: { type: "variableName", value: recordName, loc: tag.loc },
  };
  const call: FunctionCall = {
    type: "functionCall",
    functionName: tag.name,
    arguments: [...tag.arguments, record],
    block: {
      type: "blockArgument",
      inline: false,
      params: [{ type: "functionParameter", name: RECORD_PARAMETER }],
      body: [rebindStatement(target, parameters, depth, tag.loc), ...body],
    },
    loc: tag.loc,
    decorator: origin,
  };
  if (signature?.imported) {
    call.scope = "imported";
  }
  return call;
}

/** The block parameter that holds the record a decorator calls the block
 *  with. The `__` check is in the parser and sees only user text, so a name
 *  the lowering adds is allowed (docs/dev/language/reserved-names.md). */
const RECORD_PARAMETER = "__args";

/** The local that holds a decorator's `call` record, suffixed with the
 *  decorator's depth in the stack: `__call_0` for the outermost. */
const RECORD_LOCAL = "__call_";

/** The block's first statement: store the def's parameters from the record
 *  (docs/dev/language/decorators.md, "The block takes the arguments"). */
function rebindStatement(
  target: string,
  parameters: FunctionParameter[],
  depth: number,
  loc: SourceLocation | undefined,
): RebindParameters {
  return {
    type: "rebindParameters",
    functionName: target,
    depth,
    parameters: parameters.filter((parameter) => !isBlockParameter(parameter)),
    blockParameters: parameters.filter(isBlockParameter).map((parameter) => parameter.name),
    record: RECORD_PARAMETER,
    loc,
  };
}

/** `{ name: "<def>", args: { a: a, b: b } }` over the def's parameters,
 *  block-typed ones left out: a block cannot be stored in a record. */
function callRecord(
  target: string,
  parameters: FunctionParameter[],
  loc: SourceLocation | undefined,
): AgencyObject {
  const named = parameters.filter((parameter) => !isBlockParameter(parameter));
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

/** The one function that writes. Every decorator def gets its slots typed
 *  first (`withDecoratorTypes`), then each decorated def gets its lowered
 *  body. The order matters: a decorated decorator's own call record leaves
 *  block-typed parameters out, so its block slot must be typed before the
 *  record is built. */
export function desugarDecorators(program: AgencyProgram, lookup: DecoratorLookup): AgencyProgram {
  for (const node of program.nodes) {
    if (node.type === "function") {
      node.parameters = withDecoratorTypes(node);
    }
  }
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
 * lowering:
 *
 * - a decorator written on anything but a top-level def,
 * - a def that decorates itself,
 * - defs that decorate each other in a loop (`@b def a` and `@a def b`),
 * - a decorator imported from JavaScript, which cannot take a block,
 * - a decorator name that is neither declared nor imported,
 * - a tag naming a def that is not declared `decorator def`,
 * - a `decorator def` in the wrong shape (`decoratorShapeProblem`): a
 *   local one at the def, an imported one at the tag.
 *
 * The last two render through the diagnostic registry (`decoratorShape`,
 * `notADecorator`), so the checker's copies say the same thing. Pure;
 * prepareProgram and the CLI build turn the list into errors.
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
  const lookup = decoratorLookup(scope.functionDefinitions, scope.importedFunctions);
  const fromJavaScript = javaScriptImportNames(program.nodes);
  const problems = onDefs.flatMap(({ def, tag }) => {
    const problem = problemWithTag(declaredName(def.functionName), tag.name, {
      lookup,
      fromJavaScript,
      onDefs,
    });
    return problem === null ? [] : [{ message: problem, loc: tag.loc }];
  });
  const badDefs = decoratorDefProblems(program.nodes).map(({ name, problem, loc }) => ({
    message: diagnostic("decoratorShape", { name, problem }, loc ?? null).message,
    loc,
  }));
  return [...misplaced, ...badDefs, ...problems];
}

/** A `decorator def` whose parameters are not a decorator's. */
export type DecoratorDefProblem = {
  name: string;
  problem: string;
  loc: SourceLocation | undefined;
};

/** Every `decorator def` among `nodes` in the wrong shape, as data: the
 *  decorator stage and the checker each render it through the
 *  `decoratorShape` entry. */
export function decoratorDefProblems(nodes: AgencyNode[]): DecoratorDefProblem[] {
  return nodes.flatMap((node) => {
    if (node.type !== "function" || !isDecoratorDef(node)) {
      return [];
    }
    const problem = decoratorShapeProblem(node.parameters);
    return problem === null
      ? []
      : [{ name: declaredName(node.functionName), problem, loc: node.loc }];
  });
}

/** What is wrong with a tag that resolved to `signature`, as data: the def
 *  is not a decorator, or it is an imported decorator in the wrong shape.
 *  A local decorator's shape is reported at the def by
 *  `decoratorDefProblems`, so a tag on it is not reported again. */
export type TagProblem = { kind: "notADecorator" } | { kind: "shape"; problem: string };

export function tagProblem(signature: DecoratorSignature): TagProblem | null {
  if (!signature.decorator) {
    return { kind: "notADecorator" };
  }
  const problem = signature.imported ? decoratorShapeProblem(signature.parameters) : null;
  return problem === null ? null : { kind: "shape", problem };
}

type TagContext = {
  lookup: DecoratorLookup;
  fromJavaScript: string[];
  onDefs: TagOnDef[];
};

/** What is wrong with `@decorator` written on the def named `target`, or
 *  null when nothing is. */
function problemWithTag(target: string, decorator: string, context: TagContext): string | null {
  if (target === decorator) {
    return `'${decorator}' cannot decorate itself.`;
  }
  const loop = decoratorLoop(target, decorator, context.onDefs);
  if (loop !== null) {
    return `Decorators call each other in a loop: ${loop.join(" → ")}. Calling any of these functions would never return.`;
  }
  const signature = context.lookup(decorator);
  if (signature === undefined && context.fromJavaScript.includes(decorator)) {
    return `'${decorator}' is imported from JavaScript, so it cannot decorate '${target}'. A decorator receives the body as a block, and only an Agency def can take a block.`;
  }
  if (signature === undefined) {
    return `Unknown decorator '${decorator}' on '${target}'. A decorator is a \`decorator def\` whose last two parameters are the call record and a block; declare or import '${decorator}'.`;
  }
  const found = tagProblem(signature);
  if (found === null) {
    return null;
  }
  if (found.kind === "notADecorator") {
    return diagnostic("notADecorator", { name: decorator, target }, null).message;
  }
  return diagnostic("decoratorShape", { name: decorator, problem: found.problem }, null).message;
}

/** The names a program imports from JavaScript or TypeScript files. */
function javaScriptImportNames(nodes: AgencyNode[]): string[] {
  return nodes.flatMap((node) =>
    node.type === "importStatement" && !node.isAgencyImport
      ? node.importedNames.flatMap(getImportedNames)
      : [],
  );
}

/** The loop `@decorator` on `target` closes, as the def names in call
 *  order starting and ending at `target`, or null when there is none.
 *  `@b def a` means `a` calls `b`, so the edges run from a def to each of
 *  its decorators. Only this file's defs are followed: a loop through
 *  another file still ends at the runtime's call-depth limit. */
function decoratorLoop(target: string, decorator: string, onDefs: TagOnDef[]): string[] | null {
  const decoratorsOf = (name: string): string[] =>
    onDefs.filter(({ def }) => declaredName(def.functionName) === name).map(({ tag }) => tag.name);
  const visit = (path: string[]): string[] | null => {
    const current = path[path.length - 1];
    if (current === target) {
      return path;
    }
    const next = decoratorsOf(current).filter((name) => !path.includes(name) || name === target);
    for (const name of next) {
      const found = visit([...path, name]);
      if (found !== null) {
        return found;
      }
    }
    return null;
  };
  return visit([target, decorator]);
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

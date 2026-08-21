import { z } from "zod";
import { stripBoundParams } from "./stripBoundParams.js";
import { approve, pass } from "./interrupts.js";
import { agencyStore, withPushedHandler } from "./asyncContext.js";
import { withCallDepth } from "./callDepth.js";
import { checkFailureArgs } from "./failurePropagation.js";
import { formatRequiredUnboundRuntimeError } from "./toolBlockDiagnostics.js";

export const UNSET: unique symbol = Symbol("UNSET");

export type FuncParam = {
  name: string;
  hasDefault: boolean;
  defaultValue: unknown;
  variadic: boolean;
  /**
   * True when the parameter's declared type is (or contains) a function type
   * — e.g. `block: () => void`, a union with a function arm, or a variadic
   * whose element type is a function. Set by the codegen from the static
   * `isFunctionTyped` predicate; consumed by `validateToolForLLM`.
   *
   * Defaults to false on legacy/handcrafted FuncParam values so the runtime
   * backstop fails open (i.e. doesn't block valid tools).
   */
  isFunctionTyped?: boolean;
  /**
   * False when the parameter's declared type does NOT accept Result values —
   * i.e. it is not `Result`/`Result<...>`, not explicit `any`, and not a
   * union containing either. Set by codegen from the static
   * `paramAcceptsFailure` predicate (lib/typeChecker/utils.ts); consumed by
   * the failure-propagation check in invoke().
   *
   * Absent on legacy/handcrafted FuncParam values, and absence fails OPEN
   * (the param accepts failures) — same convention as `isFunctionTyped`.
   */
  acceptsResult?: boolean;
  boundValue?: unknown;
  isBound?: boolean;
};

export type CallType =
  | { type: "positional"; args: unknown[] }
  | {
      type: "named";
      positionalArgs: unknown[];
      namedArgs: Record<string, unknown>;
      /** Trailing-block argument from `f(name: val) as { ... }` syntax.
       *
       *  In the positional case the block is simply appended to `args`
       *  (it's always the next positional slot), so no separate field
       *  is needed. In the named case earlier params may be filled by
       *  name and intermediate params may need UNSET padding, so the
       *  block must be bound by NAME to the last non-variadic
       *  parameter — appending it as positional[N] would mis-fill
       *  parameter N. resolveNamed synthesizes it into namedArgs under
       *  the last param's name so the rest of fill logic treats it
       *  uniformly. Without this, `f(name: val) as { ... }` silently
       *  dropped the block. */
      blockArg?: unknown;
    };

export type ToolDefinition = {
  name: string;
  description: string;
  schema: unknown;
};

/** Retry-safety markers carried on a registered tool. Inline shape so the
 *  runtime stays decoupled from the compiler's AST types. */
export type ToolMarkers = {
  destructive?: boolean;
  idempotent?: boolean;
};

export type AgencyFunctionOpts = {
  name: string;
  module: string;
  fn: (...args: any[]) => any;
  params: FuncParam[];
  toolDefinition: ToolDefinition | null;
  exported?: boolean;
  markers?: ToolMarkers;
  isPreapproved?: boolean;
  registeredName?: string;
};

export class AgencyFunction {
  readonly __agencyFunction = true;
  readonly name: string;
  readonly module: string;
  readonly params: FuncParam[];
  readonly toolDefinition: ToolDefinition | null;
  private readonly _fn: (...args: any[]) => any;
  private readonly _unboundParams: FuncParam[];
  private readonly _nonVariadicUnbound: FuncParam[];
  private readonly _hasVariadic: boolean;
  private readonly _isBound: boolean;
  private readonly _checksFailures: boolean;
  readonly exported: boolean;
  readonly markers: ToolMarkers;
  private readonly _isPreapproved: boolean;
  /** The key this function's registered ancestor is stored under in the
   *  function registry. `.rename()` changes `name` but not this, and the
   *  other derivations carry it forward — `.partial()` and `.preapprove()`
   *  directly, `.describe()` via `withToolDefinition()` — so a serialized
   *  ref to any derived copy can find its registry entry again. Equal to
   *  `name` for functions never renamed. */
  readonly registeredName: string;

  constructor(opts: AgencyFunctionOpts) {
    this.name = opts.name;
    this.module = opts.module;
    this.registeredName = opts.registeredName ?? opts.name;
    this._fn = opts.fn;
    this.params = opts.params;
    this.toolDefinition = opts.toolDefinition;
    this.exported = opts.exported ?? false;
    this.markers = opts.markers ?? {};
    this._isPreapproved = opts.isPreapproved ?? false;
    this._unboundParams = opts.params.filter((p) => !p.isBound);
    this._nonVariadicUnbound = this._unboundParams.filter((p) => !p.variadic);
    this._hasVariadic =
      this._unboundParams.length > 0 &&
      this._unboundParams[this._unboundParams.length - 1].variadic;
    this._isBound = opts.params.some((p) => p.isBound);
    this._checksFailures = opts.params.some((p) => p.acceptsResult === false);
  }

  get isPreapproved(): boolean {
    return this._isPreapproved;
  }

  get description(): string {
    return this.toolDefinition?.description ?? "";
  }

  get boundArgs(): { indices: number[]; values: unknown[]; originalParams: FuncParam[] } | null {
    if (!this._isBound) return null;
    const indices: number[] = [];
    const values: unknown[] = [];
    for (let i = 0; i < this.params.length; i++) {
      if (this.params[i].isBound) {
        indices.push(i);
        values.push(this.params[i].boundValue);
      }
    }
    return { indices, values, originalParams: this.params };
  }

  withToolDefinition(toolDefinition: ToolDefinition | null): AgencyFunction {
    return new AgencyFunction({
      name: this.name,
      module: this.module,
      fn: this._fn,
      params: this.params,
      toolDefinition,
      exported: this.exported,
      markers: this.markers,
      isPreapproved: this._isPreapproved,
      registeredName: this.registeredName,
    });
  }

  getOriginalParams(): FuncParam[] {
    return this.params;
  }

  getUnboundParams(): FuncParam[] {
    return this._unboundParams;
  }

  async invoke(descriptor: CallType): Promise<unknown> {
    // Guard every Agency call against runaway recursion. `invoke()` is the
    // single chokepoint all calls pass through, so counting logical nesting
    // here catches the async-recursion case that never trips V8's stack but
    // grows the promise chain until the process OOMs. The limit (config-
    // overridable `maxCallDepth`) is resolved from the active execution context
    // inside `withCallDepth`, once per lineage. See lib/runtime/callDepth.ts.
    return withCallDepth(this.name, () => {
      let args: unknown[];
      try {
        args = this._isBound
          ? this.mergeWithBound(this.resolveArgs(descriptor))
          : this.resolveArgs(descriptor);
      } catch (err) {
        // Argument binding failed — the function body never began. Tag the
        // error so the tool loop maps it to the "nothing was executed"
        // tier (its sole source of neverStarted: true).
        if (err && typeof err === "object") {
          (err as { preExecution?: boolean }).preExecution = true;
        }
        throw err;
      }
      // Failure propagation: a failure landing on a param that does not
      // accept Results skips the body and returns the original failure
      // (spec: docs/superpowers/specs/2026-07-08-failure-propagation-design.md).
      // `args` is aligned with `this.params` in both branches: mergeWithBound
      // rebuilds the full list, and in the unbound case params ARE the
      // unbound list (variadic slot = gathered array). Skipping the body
      // also skips its pushHandler calls — safe for the same reason pipe
      // short-circuiting is safe: the call never begins, so no partial run
      // can raise an effect past an unregistered handler.
      if (this._checksFailures) {
        const propagated = checkFailureArgs(this.name, this.params, args);
        if (propagated !== null) {
          return propagated;
        }
      }
      return this._fn(...args);
    });
  }

  partial(bindings: Record<string, unknown>): AgencyFunction {
    if (Object.keys(bindings).length === 0) return this;

    // Single pass: validate bindings against full param list. Variadic
    // binding via the named-array form (`.partial(rest: [1,2])`) is allowed;
    // the supplied value must be an array. Runtime backstop only — the
    // type checker rejects shape mismatches earlier.
    for (const name of Object.keys(bindings)) {
      const param = this.params.find((p) => p.name === name);
      if (!param) {
        throw new Error(`Unknown parameter '${name}' in .partial() call`);
      }
      if (param.isBound) {
        throw new Error(`Parameter '${name}' is already bound`);
      }
      if (param.variadic && !Array.isArray(bindings[name])) {
        throw new Error(
          `Variadic parameter '${name}' must be bound to an array in .partial(); got ${typeof bindings[name]}`,
        );
      }
    }

    // Build new params with bound values set
    const newParams = this.params.map((p) => {
      if (p.name in bindings) {
        return { ...p, isBound: true, boundValue: bindings[p.name] };
      }
      return p;
    });

    const unboundParams = newParams.filter((p) => !p.isBound);

    // Build reduced tool definition if one exists
    const boundNames = Object.keys(bindings);
    const newToolDef = this.toolDefinition
      ? {
          ...this.toolDefinition,
          description: stripBoundParams(this.toolDefinition.description, boundNames),
          schema: buildReducedSchema(this.toolDefinition.schema, unboundParams),
        }
      : null;

    return new AgencyFunction({
      name: this.name,
      module: this.module,
      fn: this._fn,
      params: newParams,
      toolDefinition: newToolDef,
      exported: this.exported,
      markers: this.markers,
      isPreapproved: this._isPreapproved,
      registeredName: this.registeredName,
    });
  }

  preapprove(): AgencyFunction {
    if (this._isPreapproved) return this;
    // Wrap `_fn` in a `withPushedHandler` that installs an
    // auto-approve handler for the duration of every call. The handler
    // intercepts any `request_approval` interrupt the body raises so
    // preapproved tools never bubble approval prompts up to the user.
    // Doing the wrap here — rather than branching inside `invoke()` —
    // keeps the per-call hot path branch-free.
    const original = this._fn;
    // The auto-approve must PASS on std::guard interrupts (guard trips,
    // once guards raise them): approving work is meaningful, but a bare
    // approve on a trip is approve({}) — no budget granted — which the
    // trip machinery treats as a runtime error. Budget questions are for
    // outer handlers or the user, never a tool's auto-approve wrapper.
    //
    // TODO(owner, resumable-guards PR 2): revisit this branch once the
    // trip approve semantics land — the owner flagged it as possibly
    // temporary. The case to re-check before removing it: a lone
    // approve({}) (nobody else granting) must not turn a trip into the
    // useless-approval runtime error where a pass would have let it
    // propagate to someone who can actually grant budget.
    const autoApprove = async (intr: { effect: string }) =>
      intr.effect === "std::guard" ? pass() : approve();
    const wrapped = (...args: any[]) => {
      const ctx = agencyStore.getStore()?.ctx;
      if (!ctx) return original(...args);
      // liveGuardIds: [] is an explicit decision, not a default — this
      // handler conceptually registers above any guard (its body never
      // spends, so the hide-everything reading is also harmless).
      return withPushedHandler(ctx, autoApprove, () => Promise.resolve(original(...args)), []);
    };
    return new AgencyFunction({
      name: this.name,
      module: this.module,
      fn: wrapped,
      params: this.params,
      toolDefinition: this.toolDefinition,
      exported: this.exported,
      markers: this.markers,
      isPreapproved: true,
      registeredName: this.registeredName,
    });
  }

  describe(description: string): AgencyFunction {
    const newToolDef = this.toolDefinition
      ? { ...this.toolDefinition, description }
      : { name: this.name, description, schema: null };
    return this.withToolDefinition(newToolDef);
  }

  /**
   * Return a copy of this function with a new name. The name is BOTH what the
   * LLM sees as the tool name and what tool-call dispatch matches against
   * (`prompt.ts` looks up the handler by `fn.name`), so `name` and
   * `toolDefinition.name` are updated together.
   *
   * `.partial()` and `.describe()` deliberately preserve the base name, so
   * deriving several tools from one function (e.g. `read.partial(dir)` as
   * `skillsDir` does) produces several tools that all share that base name.
   * Passing such a list to `llm({ tools })` is rejected by providers that
   * require unique tool names (Anthropic returns a 400). `.rename(...)` gives
   * each derived tool a distinct name.
   */
  rename(newName: string): AgencyFunction {
    const newToolDef = this.toolDefinition ? { ...this.toolDefinition, name: newName } : null;
    return new AgencyFunction({
      name: newName,
      module: this.module,
      fn: this._fn,
      params: this.params,
      toolDefinition: newToolDef,
      exported: this.exported,
      markers: this.markers,
      isPreapproved: this._isPreapproved,
      // The registry never learns the new name, so serialization keeps the
      // registered name for revival (see FunctionRefReviver).
      registeredName: this.registeredName,
    });
  }

  private mergeWithBound(unboundArgs: unknown[]): unknown[] {
    const fullArgs: unknown[] = [];
    let unboundIdx = 0;
    for (const param of this.params) {
      if (param.isBound) {
        fullArgs.push(param.boundValue);
      } else {
        fullArgs.push(unboundArgs[unboundIdx++]);
      }
    }
    return fullArgs;
  }

  private resolveArgs(descriptor: CallType): unknown[] {
    if (descriptor.type === "positional") {
      return this.resolvePositional(descriptor.args);
    }
    return this.resolveNamed(descriptor.positionalArgs, descriptor.namedArgs, descriptor.blockArg);
  }

  private resolvePositional(args: unknown[]): unknown[] {
    const plan = planArgumentBindings(
      this._unboundParams.map((p) => ({
        name: p.name,
        hasDefault: p.hasDefault,
        variadic: p.variadic,
      })),
      args,
    );
    return renderRuntimeArguments(plan);
  }

  private resolveNamed(
    positionalArgs: unknown[],
    namedArgs: Record<string, unknown>,
    blockArg?: unknown,
  ): unknown[] {
    // The variadic — if any — is in `_unboundParams` but not in
    // `_nonVariadicUnbound`. Named lookups search the full unbound list
    // so `foo(rest: [1,2])` finds the variadic; conflict-with-positional
    // checks use the non-variadic position index. Keep in sync with the
    // compile-time resolver in `namedArgsResolver.ts :: resolveNamedArgs`.
    const variadicParam = this._hasVariadic
      ? this._unboundParams[this._unboundParams.length - 1]
      : undefined;

    // Validate named args: no unknowns, no conflicts with positional
    for (const name of Object.keys(namedArgs)) {
      const paramIdx = this._nonVariadicUnbound.findIndex((p) => p.name === name);
      const targetsVariadic = variadicParam && variadicParam.name === name;
      if (paramIdx === -1 && !targetsVariadic) {
        throw new Error(`Unknown named argument '${name}' in call to '${this.name}'`);
      }
      if (paramIdx !== -1 && paramIdx < positionalArgs.length) {
        throw new Error(
          `Named argument '${name}' conflicts with positional argument at position ${paramIdx + 1} in call to '${this.name}'`,
        );
      }
    }

    // Mixed positional + named-variadic rule: when the variadic is bound by
    // name, no positional may exist past the fixed (non-variadic) param
    // count. Mirrors the compile-time check; runs as a backstop for
    // generated TS / direct runtime callers that bypass the type checker.
    if (variadicParam && Object.hasOwn(namedArgs, variadicParam.name)) {
      if (positionalArgs.length > this._nonVariadicUnbound.length) {
        throw new Error(
          `Positional argument cannot feed variadic parameter '${variadicParam.name}' when it is also bound by name in call to '${this.name}'`,
        );
      }
      const value = namedArgs[variadicParam.name];
      if (!Array.isArray(value)) {
        throw new Error(
          `Variadic parameter '${variadicParam.name}' must be bound to an array; got ${typeof value} in call to '${this.name}'`,
        );
      }
    }

    // A trailing block argument (from `f(name: val) as { ... }` syntax)
    // binds to the LAST non-variadic unbound parameter. By convention
    // that's the block-typed param. We synthesize it into namedArgs
    // here so the rest of the fill logic treats it uniformly.
    const hasBlock = blockArg !== undefined;
    if (hasBlock) {
      const lastParam = this._nonVariadicUnbound[this._nonVariadicUnbound.length - 1];
      if (!lastParam) {
        throw new Error(
          `Call to '${this.name}' passed a trailing block but the function takes no parameters`,
        );
      }
      if (Object.hasOwn(namedArgs, lastParam.name)) {
        throw new Error(
          `Trailing block conflicts with named argument '${lastParam.name}' in call to '${this.name}'`,
        );
      }
      namedArgs = { ...namedArgs, [lastParam.name]: blockArg };
    }

    // Build result: positional args first, then fill from named args in parameter order
    const result: unknown[] = [...positionalArgs];

    for (let i = positionalArgs.length; i < this._nonVariadicUnbound.length; i++) {
      const param = this._nonVariadicUnbound[i];
      if (Object.hasOwn(namedArgs, param.name)) {
        result.push(namedArgs[param.name]);
      } else if (param.hasDefault) {
        const hasLaterNamedArg = this._nonVariadicUnbound
          .slice(i + 1)
          .some((p) => p.name in namedArgs);
        if (hasLaterNamedArg) {
          result.push(UNSET);
        } else {
          break;
        }
      } else {
        throw new Error(`Missing required argument '${param.name}' in call to '${this.name}'`);
      }
    }

    // If the variadic was bound by name, splat its array into the trailing
    // slot so resolvePositional gathers it back into a single-array param.
    // This is the runtime mirror of the typescript builder behavior.
    if (variadicParam && Object.hasOwn(namedArgs, variadicParam.name)) {
      const arr = namedArgs[variadicParam.name] as unknown[];
      for (const v of arr) result.push(v);
    }

    // Apply variadic wrapping and default padding
    return this.resolvePositional(result);
  }

  /**
   * Runtime backstop invoked once per tool by `runPrompt` immediately before
   * issuing the LLM request. Throws if any required function-typed param is
   * unbound — duplicating (intentionally) the type checker's check at the
   * `llm(...)` site so dynamically-assembled tool arrays (`tools: [...base,
   * x]`) are also covered. The error wording uses the same builder as the
   * compile-time diagnostic so users see one consistent message.
   */
  validateForLLM(): void {
    for (const p of this.params) {
      if (!p.isFunctionTyped) continue;
      if (p.isBound) continue;
      if (p.hasDefault) continue;
      throw new Error(formatRequiredUnboundRuntimeError(this.name, p.name));
    }
  }

  // Serialization handled by FunctionRefReviver — toJSON() would conflict with the replacer pattern.

  static isAgencyFunction(value: unknown): value is AgencyFunction {
    return typeof value === "object" && value !== null && (value as any).__agencyFunction === true;
  }

  static create(
    opts: AgencyFunctionOpts,
    registry: Record<string, AgencyFunction>,
  ): AgencyFunction {
    const fn = new AgencyFunction(opts);
    // Composite `${module}:${name}` key so two helpers with the same
    // name in different modules can coexist in the shared global
    // registry that `FunctionRefReviver` reads from.
    registry[`${opts.module}:${opts.name}`] = fn;
    return fn;
  }
}

function buildReducedSchema(originalSchema: any, unboundParams: FuncParam[]): any {
  if (!originalSchema || !originalSchema.shape) return originalSchema;
  const unboundNames = unboundParams.map((p) => p.name);
  const shape = originalSchema.shape;
  const reducedShape: Record<string, any> = {};
  for (const [key, value] of Object.entries(shape)) {
    if (unboundNames.includes(key)) {
      reducedShape[key] = value;
    }
  }
  return z.object(reducedShape);
}

// ---------------------------------------------------------------------------
// Positional argument binding, as a declarative plan.
//
// One decision owner, two renderings: the runtime adapter below emits the
// positional array AgencyFunction dispatches (UNSET for defaults, one
// gathered array for a variadic), and std::agency's testFile adapter
// (lib/testFormat/inputArgs.ts) renders the same plan as run()'s named-args
// record. The plan records arity problems instead of throwing; each adapter
// decides what a violation means.
// ---------------------------------------------------------------------------

export type BindingParameter = {
  name: string;
  hasDefault: boolean;
  variadic: boolean;
};
export type SuppliedBindingSlot = {
  kind: "supplied";
  parameterIndex: number;
  valueIndex: number;
};
export type DefaultBindingSlot = {
  kind: "default";
  parameterIndex: number;
};
export type VariadicBindingSlot = {
  kind: "variadic";
  parameterIndex: number;
  valueIndexes: number[];
};
export type BindingSlot = SuppliedBindingSlot | DefaultBindingSlot | VariadicBindingSlot;
export type ArgumentBindingPlan = {
  parameters: BindingParameter[];
  values: unknown[];
  /** In parameter order; a missing required parameter has no slot. */
  slots: BindingSlot[];
  missingRequiredParameterIndexes: number[];
  /** Values beyond the fixed parameters when there is no variadic to
   *  gather them. */
  extraValueIndexes: number[];
};

export function planArgumentBindings(
  parameters: BindingParameter[],
  values: unknown[],
): ArgumentBindingPlan {
  const variadicIndex = parameters.findIndex((p) => p.variadic);
  const fixed = variadicIndex === -1 ? parameters : parameters.slice(0, variadicIndex);
  const slots: BindingSlot[] = [];
  const missingRequiredParameterIndexes: number[] = [];
  for (let i = 0; i < fixed.length; i++) {
    if (i < values.length) {
      slots.push({ kind: "supplied", parameterIndex: i, valueIndex: i });
    } else if (fixed[i].hasDefault) {
      slots.push({ kind: "default", parameterIndex: i });
    } else {
      missingRequiredParameterIndexes.push(i);
    }
  }
  const extraValueIndexes: number[] = [];
  if (variadicIndex !== -1) {
    const valueIndexes: number[] = [];
    for (let i = fixed.length; i < values.length; i++) valueIndexes.push(i);
    slots.push({ kind: "variadic", parameterIndex: variadicIndex, valueIndexes });
  } else {
    for (let i = fixed.length; i < values.length; i++) extraValueIndexes.push(i);
  }
  return { parameters, values, slots, missingRequiredParameterIndexes, extraValueIndexes };
}

/** The runtime rendering AgencyFunction.resolvePositional dispatches on.
 *  It deliberately preserves the pre-extraction behavior for INVALID direct
 *  runtime calls (this is not an arity behavior change): default padding
 *  stops at the first missing required parameter, and extra values without
 *  a variadic pass straight through. */
function renderRuntimeArguments(plan: ArgumentBindingPlan): unknown[] {
  const firstMissing =
    plan.missingRequiredParameterIndexes.length > 0
      ? plan.missingRequiredParameterIndexes[0]
      : Infinity;
  const out: unknown[] = [];
  for (const slot of plan.slots) {
    if (slot.kind === "variadic") {
      out.push(slot.valueIndexes.map((i) => plan.values[i]));
      continue;
    }
    if (slot.parameterIndex > firstMissing) continue;
    if (slot.kind === "supplied") {
      out.push(plan.values[slot.valueIndex]);
    } else {
      out.push(UNSET);
    }
  }
  for (const i of plan.extraValueIndexes) {
    out.push(plan.values[i]);
  }
  return out;
}

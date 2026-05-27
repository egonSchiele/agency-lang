import { z } from "zod";
import { stripBoundParams } from "./stripBoundParams.js";
import { approve } from "./interrupts.js";
import { agencyStore, withPushedHandler } from "./asyncContext.js";

export const UNSET: unique symbol = Symbol("UNSET");

export type FuncParam = {
  name: string;
  hasDefault: boolean;
  defaultValue: unknown;
  variadic: boolean;
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

export type AgencyFunctionOpts = {
  name: string;
  module: string;
  fn: (...args: any[]) => any;
  params: FuncParam[];
  toolDefinition: ToolDefinition | null;
  exported?: boolean;
  safe?: boolean;
  isPreapproved?: boolean;
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
  readonly exported: boolean;
  readonly safe: boolean;
  private readonly _isPreapproved: boolean;

  constructor(opts: AgencyFunctionOpts) {
    this.name = opts.name;
    this.module = opts.module;
    this._fn = opts.fn;
    this.params = opts.params;
    this.toolDefinition = opts.toolDefinition;
    this.exported = opts.exported ?? false;
    this.safe = opts.safe ?? false;
    this._isPreapproved = opts.isPreapproved ?? false;
    this._unboundParams = opts.params.filter(p => !p.isBound);
    this._nonVariadicUnbound = this._unboundParams.filter(p => !p.variadic);
    this._hasVariadic = this._unboundParams.length > 0 && this._unboundParams[this._unboundParams.length - 1].variadic;
    this._isBound = opts.params.some(p => p.isBound);
  }

  get isPreapproved(): boolean {
    return this._isPreapproved;
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
      safe: this.safe,
      isPreapproved: this._isPreapproved,
    });
  }

  getOriginalParams(): FuncParam[] {
    return this.params;
  }

  getUnboundParams(): FuncParam[] {
    return this._unboundParams;
  }

  async invoke(descriptor: CallType): Promise<unknown> {
    // Preapprove tools install a handler that auto-approves any
    // `request_approval` interrupt raised while the tool body runs.
    // The handler must be pushed onto the same `ctx.handlers` chain
    // the invocation consults, so we read `ctx` from the live ALS
    // frame (seeded by the caller's `runner.step` body — or by the
    // bootstrap frame for module-init paths). When no frame is
    // installed (the function was called from a non-Agency context),
    // skip the push/pop dance — no preapprove machinery to wire up.
    const ctx = this._isPreapproved ? agencyStore.getStore()?.ctx : undefined;
    if (!ctx) return this._invokeInner(descriptor);
    return withPushedHandler(
      ctx,
      async () => approve(),
      () => this._invokeInner(descriptor),
    );
  }

  private async _invokeInner(descriptor: CallType): Promise<unknown> {
    const args = this._isBound
      ? this.mergeWithBound(this.resolveArgs(descriptor))
      : this.resolveArgs(descriptor);
    return this._fn(...args);
  }

  partial(bindings: Record<string, unknown>): AgencyFunction {
    if (Object.keys(bindings).length === 0) return this;

    // Single pass: validate bindings against full param list
    for (const name of Object.keys(bindings)) {
      const param = this.params.find(p => p.name === name);
      if (!param) {
        throw new Error(`Unknown parameter '${name}' in .partial() call`);
      }
      if (param.isBound) {
        throw new Error(`Parameter '${name}' is already bound`);
      }
      if (param.variadic) {
        throw new Error(`Variadic parameter '${name}' cannot be bound`);
      }
    }

    // Build new params with bound values set
    const newParams = this.params.map(p => {
      if (p.name in bindings) {
        return { ...p, isBound: true, boundValue: bindings[p.name] };
      }
      return p;
    });

    const unboundParams = newParams.filter(p => !p.isBound);

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
      safe: this.safe,
      isPreapproved: this._isPreapproved,
    });
  }

  preapprove(): AgencyFunction {
    if (this._isPreapproved) return this;
    return new AgencyFunction({
      name: this.name,
      module: this.module,
      fn: this._fn,
      params: this.params,
      toolDefinition: this.toolDefinition,
      exported: this.exported,
      safe: this.safe,
      isPreapproved: true,
    });
  }

  describe(description: string): AgencyFunction {
    const newToolDef = this.toolDefinition
      ? { ...this.toolDefinition, description }
      : { name: this.name, description, schema: null };
    return this.withToolDefinition(newToolDef);
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
    return this.resolveNamed(
      descriptor.positionalArgs,
      descriptor.namedArgs,
      descriptor.blockArg,
    );
  }

  private resolvePositional(args: unknown[]): unknown[] {
    // Fast path: exact arg count, no variadics — no work needed
    if (args.length === this._nonVariadicUnbound.length && !this._hasVariadic) {
      return args;
    }

    // Pad missing optional args with UNSET
    let result = args;
    if (args.length < this._nonVariadicUnbound.length) {
      result = [...args];
      for (let i = args.length; i < this._nonVariadicUnbound.length; i++) {
        if (!this._nonVariadicUnbound[i].hasDefault) break;
        result.push(UNSET);
      }
    }

    // Wrap trailing args for variadic param
    if (this._hasVariadic) {
      const nonVariadicCount = this._nonVariadicUnbound.length;
      const regularArgs = result.slice(0, nonVariadicCount);
      const variadicArgs = result.slice(nonVariadicCount);
      regularArgs.push(variadicArgs);
      return regularArgs;
    }

    return result;
  }

  private resolveNamed(
    positionalArgs: unknown[],
    namedArgs: Record<string, unknown>,
    blockArg?: unknown,
  ): unknown[] {
    // Validate named args: no unknowns, no conflicts with positional
    for (const name of Object.keys(namedArgs)) {
      const paramIdx = this._nonVariadicUnbound.findIndex(p => p.name === name);
      if (paramIdx === -1) {
        throw new Error(
          `Unknown named argument '${name}' in call to '${this.name}'`,
        );
      }
      if (paramIdx < positionalArgs.length) {
        throw new Error(
          `Named argument '${name}' conflicts with positional argument at position ${paramIdx + 1} in call to '${this.name}'`,
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
          .some(p => p.name in namedArgs);
        if (hasLaterNamedArg) {
          result.push(UNSET);
        } else {
          break;
        }
      } else {
        throw new Error(
          `Missing required argument '${param.name}' in call to '${this.name}'`,
        );
      }
    }

    // Apply variadic wrapping and default padding
    return this.resolvePositional(result);
  }

  // Serialization handled by FunctionRefReviver — toJSON() would conflict with the replacer pattern.

  static isAgencyFunction(value: unknown): value is AgencyFunction {
    return typeof value === "object" && value !== null
      && (value as any).__agencyFunction === true;
  }

  static create(
    opts: AgencyFunctionOpts,
    registry: Record<string, AgencyFunction>,
  ): AgencyFunction {
    const fn = new AgencyFunction(opts);
    registry[opts.name] = fn;
    return fn;
  }
}

function buildReducedSchema(
  originalSchema: any,
  unboundParams: FuncParam[]
): any {
  if (!originalSchema || !originalSchema.shape) return originalSchema;
  const unboundNames = unboundParams.map(p => p.name);
  const shape = originalSchema.shape;
  const reducedShape: Record<string, any> = {};
  for (const [key, value] of Object.entries(shape)) {
    if (unboundNames.includes(key)) {
      reducedShape[key] = value;
    }
  }
  return z.object(reducedShape);
}

import { z } from "zod";
import { stripBoundParams } from "./stripBoundParams.js";

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
  | { type: "named"; positionalArgs: unknown[]; namedArgs: Record<string, unknown> };

export type ToolDefinition = {
  name: string;
  description: string;
  schema: unknown;
};

export type AgencyFunctionOpts = {
  name: string;
  module: string;
  fn: Function;
  params: FuncParam[];
  toolDefinition: ToolDefinition | null;
};

export class AgencyFunction {
  readonly __agencyFunction = true;
  readonly name: string;
  readonly module: string;
  readonly params: FuncParam[];
  readonly toolDefinition: ToolDefinition | null;
  private readonly _fn: Function;
  private readonly _unboundParams: FuncParam[];
  private readonly _nonVariadicUnbound: FuncParam[];
  private readonly _hasVariadic: boolean;
  private readonly _isBound: boolean;

  constructor(opts: AgencyFunctionOpts) {
    this.name = opts.name;
    this.module = opts.module;
    this._fn = opts.fn;
    this.params = opts.params;
    this.toolDefinition = opts.toolDefinition;
    this._unboundParams = opts.params.filter(p => !p.isBound);
    this._nonVariadicUnbound = this._unboundParams.filter(p => !p.variadic);
    this._hasVariadic = this._unboundParams.length > 0 && this._unboundParams[this._unboundParams.length - 1].variadic;
    this._isBound = opts.params.some(p => p.isBound);
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
    });
  }

  getOriginalParams(): FuncParam[] {
    return this.params;
  }

  getUnboundParams(): FuncParam[] {
    return this._unboundParams;
  }

  async invoke(descriptor: CallType, state?: unknown): Promise<unknown> {
    if (this._isBound) {
      const callArgs = this.resolveArgs(descriptor);
      const fullArgs = this.mergeWithBound(callArgs);
      return this._fn(...fullArgs, state);
    }
    const resolvedArgs = this.resolveArgs(descriptor);
    return this._fn(...resolvedArgs, state);
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
    return this.resolveNamed(descriptor.positionalArgs, descriptor.namedArgs);
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

  private resolveNamed(positionalArgs: unknown[], namedArgs: Record<string, unknown>): unknown[] {
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

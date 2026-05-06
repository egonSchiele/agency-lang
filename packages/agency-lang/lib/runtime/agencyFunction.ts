import { z } from "zod";
import { stripBoundParams } from "./stripBoundParams.js";

export const UNSET: unique symbol = Symbol("UNSET");

export type FuncParam = {
  name: string;
  hasDefault: boolean;
  defaultValue: unknown;
  variadic: boolean;
};

export type CallType =
  | { type: "positional"; args: unknown[] }
  | { type: "named"; positionalArgs: unknown[]; namedArgs: Record<string, unknown> };

export type ToolDefinition = {
  name: string;
  description: string;
  schema: unknown;
};

export type BoundArgs = {
  indices: number[];
  values: unknown[];
  originalParams: FuncParam[];
};

export type AgencyFunctionOpts = {
  name: string;
  module: string;
  fn: Function;
  params: FuncParam[];
  toolDefinition: ToolDefinition | null;
  boundArgs?: BoundArgs | null;
};

export class AgencyFunction {
  readonly __agencyFunction = true;
  readonly name: string;
  readonly module: string;
  readonly params: FuncParam[];
  readonly toolDefinition: ToolDefinition | null;
  readonly boundArgs: BoundArgs | null;
  private readonly _fn: Function;
  private readonly _nonVariadicParams: FuncParam[];
  private readonly _hasVariadic: boolean;

  constructor(opts: AgencyFunctionOpts) {
    this.name = opts.name;
    this.module = opts.module;
    this._fn = opts.fn;
    this.params = opts.params;
    this.toolDefinition = opts.toolDefinition;
    this.boundArgs = opts.boundArgs ?? null;
    this._nonVariadicParams = opts.params.filter(p => !p.variadic);
    this._hasVariadic = opts.params.length > 0 && opts.params[opts.params.length - 1].variadic;
  }

  withToolDefinition(toolDefinition: ToolDefinition | null): AgencyFunction {
    return new AgencyFunction({
      name: this.name,
      module: this.module,
      fn: this._fn,
      params: this.params,
      toolDefinition,
      boundArgs: this.boundArgs,
    });
  }

  withBoundArgs(boundArgs: BoundArgs): AgencyFunction {
    const unboundParams = boundArgs.originalParams.filter(
      (_, i) => !boundArgs.indices.includes(i)
    );
    return new AgencyFunction({
      name: this.name,
      module: this.module,
      fn: this._fn,
      params: unboundParams,
      toolDefinition: this.toolDefinition,
      boundArgs,
    });
  }

  getOriginalParams(): FuncParam[] {
    return this.boundArgs ? this.boundArgs.originalParams : this.params;
  }

  async invoke(descriptor: CallType, state?: unknown): Promise<unknown> {
    if (this.boundArgs) {
      const callArgs = this.resolveArgs(descriptor);
      const fullArgs = this.mergeWithBound(callArgs);
      return this._fn(...fullArgs, state);
    }
    const resolvedArgs = this.resolveArgs(descriptor);
    return this._fn(...resolvedArgs, state);
  }

  partial(bindings: Record<string, unknown>): AgencyFunction {
    const originalParams = this.getOriginalParams();

    // Single pass: validate and collect indices/values
    const boundIndices: number[] = [];
    const boundValues: unknown[] = [];
    for (const [name, value] of Object.entries(bindings)) {
      const index = originalParams.findIndex(p => p.name === name);
      if (index === -1) {
        throw new Error(`Unknown parameter '${name}' in .partial() call`);
      }
      if (this.boundArgs && this.boundArgs.indices.includes(index)) {
        throw new Error(`Parameter '${name}' is already bound`);
      }
      if (originalParams[index].variadic) {
        throw new Error(`Variadic parameter '${name}' cannot be bound`);
      }
      boundIndices.push(index);
      boundValues.push(value);
    }

    // Compute cumulative bound state
    const allBoundIndices = this.boundArgs
      ? [...this.boundArgs.indices, ...boundIndices]
      : boundIndices;
    const allBoundValues = this.boundArgs
      ? [...this.boundArgs.values, ...boundValues]
      : boundValues;

    // Compute remaining unbound params
    const unboundParams = originalParams.filter(
      (_, i) => !allBoundIndices.includes(i)
    );

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
      params: unboundParams,
      toolDefinition: newToolDef,
      boundArgs: {
        indices: allBoundIndices,
        values: allBoundValues,
        originalParams,
      },
    });
  }

  describe(description: string): AgencyFunction {
    const newToolDef = this.toolDefinition
      ? { ...this.toolDefinition, description }
      : { name: this.name, description, schema: null };
    return this.withToolDefinition(newToolDef);
  }

  private mergeWithBound(unboundArgs: unknown[]): unknown[] {
    const totalParams = this.boundArgs!.originalParams.length;
    const indices = this.boundArgs!.indices;
    const values = this.boundArgs!.values;
    const fullArgs: unknown[] = new Array(totalParams);
    let unboundIdx = 0;

    // Build index→value lookup for O(1) per slot
    const boundMap: Record<number, unknown> = {};
    for (let i = 0; i < indices.length; i++) {
      boundMap[indices[i]] = values[i];
    }

    for (let i = 0; i < totalParams; i++) {
      if (i in boundMap) {
        fullArgs[i] = boundMap[i];
      } else {
        fullArgs[i] = unboundArgs[unboundIdx++];
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
    if (args.length === this._nonVariadicParams.length && !this._hasVariadic) {
      return args;
    }

    // Pad missing optional args with UNSET
    let result = args;
    if (args.length < this._nonVariadicParams.length) {
      result = [...args];
      for (let i = args.length; i < this._nonVariadicParams.length; i++) {
        if (!this._nonVariadicParams[i].hasDefault) break;
        result.push(UNSET);
      }
    }

    // Wrap trailing args for variadic param
    if (this._hasVariadic) {
      const nonVariadicCount = this._nonVariadicParams.length;
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
      const paramIdx = this._nonVariadicParams.findIndex(p => p.name === name);
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

    for (let i = positionalArgs.length; i < this._nonVariadicParams.length; i++) {
      const param = this._nonVariadicParams[i];
      if (Object.hasOwn(namedArgs, param.name)) {
        result.push(namedArgs[param.name]);
      } else if (param.hasDefault) {
        const hasLaterNamedArg = this._nonVariadicParams
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

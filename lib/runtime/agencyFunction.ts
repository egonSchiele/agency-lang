export const UNSET = "UNSET";

export type FuncParam = {
  name: string;
  position: number;
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

  constructor(opts: AgencyFunctionOpts) {
    this.name = opts.name;
    this.module = opts.module;
    this._fn = opts.fn;
    this.params = opts.params;
    this.toolDefinition = opts.toolDefinition;
  }

  async invoke(descriptor: CallType, state?: unknown): Promise<unknown> {
    const resolvedArgs = this.resolveArgs(descriptor);
    return this._fn(...resolvedArgs, state);
  }

  private resolveArgs(descriptor: CallType): unknown[] {
    if (descriptor.type === "positional") {
      return this.resolvePositional(descriptor.args);
    }
    return this.resolveNamed(descriptor.positionalArgs, descriptor.namedArgs);
  }

  private resolvePositional(args: unknown[]): unknown[] {
    const nonVariadicParams = this.params.filter(p => !p.variadic);
    const hasVariadic = this.params.length > 0 && this.params[this.params.length - 1].variadic;

    // Pad missing optional args with UNSET
    const result = [...args];
    for (let i = result.length; i < nonVariadicParams.length; i++) {
      if (!nonVariadicParams[i].hasDefault) break;
      result.push(UNSET);
    }

    // Wrap trailing args for variadic param
    if (hasVariadic) {
      const nonVariadicCount = nonVariadicParams.length;
      const regularArgs = result.slice(0, nonVariadicCount);
      const variadicArgs = result.slice(nonVariadicCount);
      regularArgs.push(variadicArgs);
      return regularArgs;
    }

    return result;
  }

  private resolveNamed(positionalArgs: unknown[], namedArgs: Record<string, unknown>): unknown[] {
    const nonVariadicParams = this.params.filter(p => !p.variadic);

    // Validate no unknown named args
    for (const name of Object.keys(namedArgs)) {
      if (!nonVariadicParams.find(p => p.name === name)) {
        throw new Error(
          `Unknown named argument '${name}' in call to '${this.name}'`,
        );
      }
    }

    // Validate named args don't conflict with positional
    for (const name of Object.keys(namedArgs)) {
      const paramIdx = nonVariadicParams.findIndex(p => p.name === name);
      if (paramIdx < positionalArgs.length) {
        throw new Error(
          `Named argument '${name}' conflicts with positional argument at position ${paramIdx + 1} in call to '${this.name}'`,
        );
      }
    }

    // Build result: positional args first, then fill from named args in parameter order
    const result: unknown[] = [...positionalArgs];

    for (let i = positionalArgs.length; i < nonVariadicParams.length; i++) {
      const param = nonVariadicParams[i];
      if (param.name in namedArgs) {
        result.push(namedArgs[param.name]);
      } else if (param.hasDefault) {
        // Check if any later param has a named arg — if so, insert UNSET placeholder
        const hasLaterNamedArg = nonVariadicParams
          .slice(i + 1)
          .some(p => p.name in namedArgs);
        if (hasLaterNamedArg) {
          result.push(UNSET);
        } else {
          // Trailing skipped params — stop here, resolvePositional will pad
          break;
        }
      } else {
        throw new Error(
          `Missing required argument '${param.name}' in call to '${this.name}'`,
        );
      }
    }

    // Apply variadic wrapping and default padding via resolvePositional
    return this.resolvePositional(result);
  }

  toJSON(): { name: string; module: string } {
    return { name: this.name, module: this.module };
  }

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

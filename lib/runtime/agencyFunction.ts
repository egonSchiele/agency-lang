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

  private resolveNamed(_positionalArgs: unknown[], _namedArgs: Record<string, unknown>): unknown[] {
    throw new Error("Named args not yet implemented");
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

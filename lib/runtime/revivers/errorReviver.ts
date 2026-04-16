import { BaseReviver } from "./baseReviver.js";

const errorConstructors: Record<string, ErrorConstructor> = {
  Error,
  TypeError,
  RangeError,
  ReferenceError,
  SyntaxError,
  URIError,
  EvalError,
};

export class ErrorReviver implements BaseReviver<Error> {
  nativeTypeName(): string {
    return "Error";
  }

  isInstance(value: unknown): value is Error {
    return value instanceof Error;
  }

  serialize(value: Error): Record<string, unknown> {
    return {
      __nativeType: this.nativeTypeName(),
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  validate(value: Record<string, unknown>): boolean {
    return typeof value.name === "string" && typeof value.message === "string";
  }

  revive(value: Record<string, unknown>): Error {
    const Ctor = errorConstructors[value.name as string] ?? Error;
    const error = new Ctor(value.message as string);
    error.name = value.name as string;
    if (typeof value.stack === "string") {
      error.stack = value.stack;
    }
    return error;
  }
}

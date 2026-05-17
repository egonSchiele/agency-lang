// Type declarations for the .mjs resolver hook used in tests.
export type ResolveResult = {
  url: string;
  format: string | null;
  shortCircuit?: boolean;
};

export type ResolveContext = {
  conditions?: string[];
  importAttributes?: Record<string, string>;
  parentURL?: string;
};

export type NextResolve = (
  specifier: string,
  context: ResolveContext,
) => Promise<ResolveResult>;

export function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<ResolveResult>;

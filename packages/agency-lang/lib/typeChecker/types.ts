import { AgencyConfig } from "../config.js";
import {
  AgencyNode,
  FunctionDefinition,
  GraphNodeDefinition,
  VariableType,
} from "../types.js";
import { SourceLocation } from "../types/base.js";
import type { ScopedTypeAliases } from "../compilationUnit.js";

export type TypeCheckError = {
  message: string;
  variableName?: string;
  expectedType?: string;
  actualType?: string;
  loc?: SourceLocation;
};

export type TypeCheckResult = {
  errors: TypeCheckError[];
};

import type { Scope } from "./scope.js";

export type ScopeInfo = {
  scope: Scope;
  body: AgencyNode[];
  name: string;
  scopeKey: string;
  returnType?: VariableType | null;
};

export type BuiltinSignature = {
  params: (VariableType | "any")[];
  returnType: VariableType | "any";
  minParams?: number; // if set, arity is [minParams, params.length]; otherwise exact
};

export type TypeCheckerContext = {
  programNodes: AgencyNode[];
  scopedTypeAliases: ScopedTypeAliases;
  currentScopeKey: string;
  functionDefs: Record<string, FunctionDefinition>;
  nodeDefs: Record<string, GraphNodeDefinition>;
  errors: TypeCheckError[];
  inferredReturnTypes: Record<string, VariableType | "any">;
  inferringReturnType: Set<string>;
  config: AgencyConfig;
  getTypeAliases(): Record<string, VariableType>;
  withScope<T>(key: string, fn: () => T): T;
  inferReturnTypeFor(
    name: string,
    def: FunctionDefinition | GraphNodeDefinition,
  ): VariableType | "any";
};

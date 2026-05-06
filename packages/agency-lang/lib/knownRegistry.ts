export type ParamDef = {
  name: string;
  type: string;
};

export type KnownSignature = {
  params: ParamDef[];
  returnType: string;
};

export type KnownRegistry = {
  functions: Record<string, KnownSignature>;
  methods: Record<string, Record<string, KnownSignature>>;
};

export const knownRegistry: KnownRegistry = {
  functions: {},
  methods: {
    AgencyFunction: {
      partial: {
        params: [{ name: "bindings", type: "Record<string, any>" }],
        returnType: "AgencyFunction",
      },
      describe: {
        params: [{ name: "description", type: "string" }],
        returnType: "AgencyFunction",
      },
    },
  },
};

export function isRegisteredMethod(typeName: string, methodName: string): boolean {
  return !!knownRegistry.methods[typeName]?.[methodName];
}

export function isRegisteredFunction(name: string): boolean {
  return !!knownRegistry.functions[name];
}

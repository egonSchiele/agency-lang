import { BuiltinSignature } from "./types.js";

export const BUILTIN_FUNCTION_TYPES: Record<string, BuiltinSignature> = {
  print: {
    params: ["any"],
    returnType: { type: "primitiveType", value: "void" },
  },
  printJSON: {
    params: ["any"],
    returnType: { type: "primitiveType", value: "void" },
  },
  input: {
    params: [{ type: "primitiveType", value: "string" }],
    returnType: { type: "primitiveType", value: "string" },
  },
  read: {
    params: [{ type: "primitiveType", value: "string" }],
    returnType: { type: "primitiveType", value: "string" },
  },
  readImage: {
    params: [{ type: "primitiveType", value: "string" }],
    returnType: { type: "primitiveType", value: "string" },
  },
  write: {
    params: [
      { type: "primitiveType", value: "string" },
      { type: "primitiveType", value: "string" },
    ],
    returnType: { type: "primitiveType", value: "void" },
  },
  fetch: {
    params: [{ type: "primitiveType", value: "string" }],
    returnType: { type: "primitiveType", value: "string" },
  },
  fetchJSON: {
    params: [{ type: "primitiveType", value: "string" }],
    returnType: "any",
  },
  fetchJson: {
    params: [{ type: "primitiveType", value: "string" }],
    returnType: "any",
  },
  sleep: {
    params: [{ type: "primitiveType", value: "number" }],
    returnType: { type: "primitiveType", value: "void" },
  },
  round: {
    params: [{ type: "primitiveType", value: "number" }],
    returnType: { type: "primitiveType", value: "number" },
  },
  llm: {
    params: ["any", "any"],
    minParams: 1,
    returnType: { type: "primitiveType", value: "string" },
  },
};

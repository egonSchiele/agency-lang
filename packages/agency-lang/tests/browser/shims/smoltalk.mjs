// A stand-in for smoltalk in the browser bundle check. smoltalk imports
// fs, path, and url, so until it ships a browser build the check points
// "smoltalk" here with esbuild's --alias. It exports the names the runtime
// imports by name (a bundler checks those at build time) and the two
// result constructors as they are; everything that would call a model
// throws. The smoke program makes no model call, so nothing here runs
// except the registry lookups, which answer "unknown".

function unavailable(name) {
  return () => {
    throw new Error(`smoltalk.${name} is not available in a browser`);
  };
}

export function success(value) {
  return { success: true, value };
}

export function failure(error, details) {
  return { success: false, error, ...(details === undefined ? {} : { details }) };
}

/** The model registry: unknown here, which every caller accepts. */
export function getModel() {
  return undefined;
}

export function resolveModelForProvider() {
  return undefined;
}

export function modelSupportsInputModality() {
  return undefined;
}

export function redactAttachments(messages) {
  return messages;
}

export class ToolCall {
  constructor() {
    throw new Error("smoltalk.ToolCall is not available in a browser");
  }
}

export const userMessage = unavailable("userMessage");
export const assistantMessage = unavailable("assistantMessage");
export const systemMessage = unavailable("systemMessage");
export const toolMessage = unavailable("toolMessage");
export const text = unavailable("text");
export const structured = unavailable("structured");
export const createClient = unavailable("createClient");

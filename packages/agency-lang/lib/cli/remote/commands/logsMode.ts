// Pure resolution of `remote logs` invocation intent, decided BEFORE any config,
// credential, binding, network, or terminal effect. Registration alone calls
// these; recipes receive the discriminated mode and never reinterpret booleans.

export type RemoteLogsMode =
  | { kind: "list"; json: boolean }
  | { kind: "fetch"; traceId?: string; output: "viewer" | "json" };

export type RemoteLogsEnvironment = {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
};

export function resolveRemoteLogsMode(
  traceId: string | undefined,
  options: { list?: boolean; json?: boolean },
): RemoteLogsMode {
  if (traceId !== undefined && traceId.length === 0) {
    throw new Error("trace id must not be empty");
  }
  if (traceId !== undefined && options.list === true) {
    throw new Error("a trace id cannot be combined with --list");
  }
  if (options.list === true) {
    return { kind: "list", json: options.json === true };
  }
  return {
    kind: "fetch",
    traceId,
    output: options.json === true ? "json" : "viewer",
  };
}

/** The viewer needs an interactive terminal; list and JSON modes do not. Throws
 *  (before any effect) when a viewer-mode fetch has a non-TTY stdin or stdout. */
export function requireRemoteLogsEnvironment(
  mode: RemoteLogsMode,
  environment: RemoteLogsEnvironment,
): void {
  if (
    mode.kind === "fetch" &&
    mode.output === "viewer" &&
    (!environment.stdinIsTTY || !environment.stdoutIsTTY)
  ) {
    throw new Error("remote logs viewer needs an interactive terminal; use --json");
  }
}

/** A connection needed a login, and the server's login mode does not start
 *  one on its own. */
export class NeedsLoginError extends Error {
  serverName: string;

  constructor(serverName: string) {
    super(`MCP server "${serverName}" needs a new login.`);
    this.name = "NeedsLoginError";
    this.serverName = serverName;
  }
}

/** The NeedsLoginError inside `error`, looking through `cause`, or null. */
export function asNeedsLogin(error: unknown): NeedsLoginError | null {
  if (error instanceof NeedsLoginError) {
    return error;
  }
  if (error instanceof Error && error.cause !== undefined) {
    return asNeedsLogin(error.cause);
  }
  return null;
}

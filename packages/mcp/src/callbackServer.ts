import http from "http";

const SUCCESS_HTML = `<!DOCTYPE html><html><body><h1>Authorization successful</h1><p>You can close this tab and return to your terminal.</p></body></html>`;
const ERROR_HTML = `<!DOCTYPE html><html><body><h1>Authorization failed</h1><p>Please try again.</p></body></html>`;

export const DEFAULT_CALLBACK_PORT = 19876;

/** The message a waiting login gets when its callback page is stopped. It is
 *  the text the user sees when they cancel a login. */
export const LOGIN_CANCELLED = "login cancelled";

/** How long a callback page listens at most, from start(). It covers a login
 *  that is started and never finished, which would otherwise hold the port. */
const DEFAULT_LIFETIME_MS = 30 * 60 * 1000;

export type CallbackServerOptions = {
  port?: number; // default DEFAULT_CALLBACK_PORT
  /** How long waitForCode waits, from its first call. Default 5 minutes. */
  timeoutMs?: number;
  /** How long the page listens at most, from start(). Default 30 minutes. */
  lifetimeMs?: number;
  /** The `state` value the provider put in the login URL. */
  state: string;
};

export function callbackUrlFor(port: number = DEFAULT_CALLBACK_PORT): string {
  return `http://127.0.0.1:${port}/oauth/callback`;
}

/** The local page the browser returns to at the end of a login. */
export class CallbackServer {
  private server: http.Server | null = null;
  private port: number;
  private state: string;
  private timeoutMs: number;
  private codePromise: Promise<string>;
  private resolveCode!: (code: string) => void;
  private rejectCode!: (err: Error) => void;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private lifetimeHandle: ReturnType<typeof setTimeout> | null = null;
  private lifetimeMs: number;
  private waiting = false;

  constructor(opts: CallbackServerOptions) {
    this.port = opts.port ?? DEFAULT_CALLBACK_PORT;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.lifetimeMs = opts.lifetimeMs ?? DEFAULT_LIFETIME_MS;
    this.state = opts.state;
    this.codePromise = new Promise<string>((resolve, reject) => {
      this.resolveCode = resolve;
      this.rejectCode = reject;
    });
    // Drops the rejection only when nobody waits on it. A caller of
    // waitForCode() still gets it.
    this.codePromise.catch(() => {});
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => this.answer(req, res));
      this.server.listen(this.port, "127.0.0.1", () => resolve());
      this.server.on("error", (error: NodeJS.ErrnoException) => {
        this.server = null;
        reject(error.code === "EADDRINUSE" ? this.portInUse() : error);
      });
    });
    this.lifetimeHandle = setTimeout(() => {
      const minutes = Math.round(this.lifetimeMs / 60_000);
      this.rejectCode(new Error(`The login page closed after ${minutes} minutes. Start the login again.`));
      void this.stop();
    }, this.lifetimeMs);
  }

  private portInUse(): Error {
    return new Error(
      `another login is in progress (port ${this.port} is in use). Finish or cancel it, then try again.`,
    );
  }

  /** The code from the browser. The first call starts the timeout. */
  async waitForCode(): Promise<string> {
    if (!this.waiting) {
      this.waiting = true;
      this.timeoutHandle = setTimeout(() => {
        this.rejectCode(new Error("OAuth callback timed out"));
        void this.stop();
      }, this.timeoutMs);
    }
    return this.codePromise;
  }

  async stop(): Promise<void> {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    if (this.lifetimeHandle) {
      clearTimeout(this.lifetimeHandle);
      this.lifetimeHandle = null;
    }
    this.rejectCode(new Error(LOGIN_CANCELLED));
    if (this.server) {
      const server = this.server;
      this.server = null;
      // A browser keeps its connection open. An open connection would keep
      // answering on this port and keep the process alive.
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private answer(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || "/", callbackUrlFor(this.port));
    if (url.pathname !== "/oauth/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    if (url.searchParams.get("state") !== this.state || !code) {
      res.writeHead(code ? 403 : 400, { "Content-Type": "text/html" });
      res.end(ERROR_HTML);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(SUCCESS_HTML);
    this.resolveCode(code);
    void this.stop();
  }
}

import http from "http";

const SUCCESS_HTML = `<!DOCTYPE html><html><body><h1>Authorization successful</h1><p>You can close this tab and return to your terminal.</p></body></html>`;
const ERROR_HTML = `<!DOCTYPE html><html><body><h1>Authorization failed</h1><p>Please try again.</p></body></html>`;

export const DEFAULT_CALLBACK_PORT = 19876;

/** The message a waiting login gets when its callback page is stopped. It is
 *  the text the user sees when they cancel a login. */
export const LOGIN_CANCELLED = "login cancelled";

export type CallbackServerOptions = {
  port?: number; // default DEFAULT_CALLBACK_PORT
  timeoutMs?: number; // default 300000 (5 minutes)
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
  private waiting = false;

  constructor(opts: CallbackServerOptions) {
    this.port = opts.port ?? DEFAULT_CALLBACK_PORT;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
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
    return new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => this.answer(req, res));
      this.server.listen(this.port, "127.0.0.1", () => resolve());
      this.server.on("error", reject);
    });
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

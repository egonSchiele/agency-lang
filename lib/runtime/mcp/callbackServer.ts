import http from "http";
import { randomBytes } from "crypto";

const SUCCESS_HTML = `<!DOCTYPE html><html><body><h1>Authorization successful</h1><p>You can close this tab and return to your terminal.</p></body></html>`;
const ERROR_HTML = `<!DOCTYPE html><html><body><h1>Authorization failed</h1><p>Please try again.</p></body></html>`;

const DEFAULT_PORT = 19876;

export type CallbackServerOptions = {
  port?: number; // default 19876
  timeoutMs?: number; // default 300000 (5 minutes)
};

export class CallbackServer {
  private server: http.Server | null = null;
  private port: number;
  private _state: string;
  private timeoutMs: number;
  private codePromise: Promise<string>;
  private resolveCode!: (code: string) => void;
  private rejectCode!: (err: Error) => void;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: CallbackServerOptions = {}) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this._state = randomBytes(32).toString("hex");
    this.codePromise = new Promise<string>((resolve, reject) => {
      this.resolveCode = resolve;
      this.rejectCode = reject;
    });
  }

  get state(): string {
    return this._state;
  }

  get callbackUrl(): string {
    return `http://127.0.0.1:${this.port}/oauth/callback`;
  }

  async start(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);

        if (url.pathname !== "/oauth/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (state !== this._state) {
          res.writeHead(403, { "Content-Type": "text/html" });
          res.end(ERROR_HTML);
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(ERROR_HTML);
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SUCCESS_HTML);
        this.resolveCode(code);
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        // When port is 0, the OS assigns a random port — read it back.
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve(this.callbackUrl);
      });

      this.server.on("error", reject);

      this.timeoutHandle = setTimeout(() => {
        this.rejectCode(new Error("OAuth callback timed out"));
      }, this.timeoutMs);
    });
  }

  async waitForCode(): Promise<string> {
    return this.codePromise;
  }

  async stop(): Promise<void> {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
        this.server = null;
      });
    }
  }
}

import http from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";

const TOKEN_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".agency",
  "oauth"
);

const DEFAULT_PORT = 8914;
const EXPIRY_BUFFER_MS = 60000; // refresh 60s before expiry

export type OAuthConfig = {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string | string[];
  port?: number;
};

type StoredTokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_url: string;
  client_id: string;
  client_secret: string;
};

function getTokenPath(name: string): string {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`Invalid OAuth provider name: "${name}"`);
  }
  return path.join(TOKEN_DIR, `${name}.json`);
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  execFile(cmd, [url], () => {});
}

function waitForCallback(
  port: number
): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state") ?? "";

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
        server.close();
        reject(new Error(`OAuth authorization failed: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Missing authorization code</h1>");
        server.close();
        reject(new Error("No authorization code received"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>Authorization successful!</h1><p>You can close this tab and return to your terminal.</p>"
      );
      server.close();
      resolve({ code, state });
    });

    server.listen(port, "127.0.0.1", () => {});

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth authorization timed out (5 minutes)"));
    }, 300000);
  });
}

async function exchangeCodeForTokens(
  tokenUrl: string,
  params: Record<string, string>
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const body = new URLSearchParams(params);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `OAuth token exchange failed (${response.status}): ${responseBody}`
    );
  }

  const data = (await response.json()) as Record<string, unknown>;

  if (!data.access_token) {
    throw new Error("OAuth token response missing access_token");
  }

  return {
    access_token: data.access_token as string,
    refresh_token: (data.refresh_token as string) ?? "",
    expires_in: (data.expires_in as number) ?? 3600,
  };
}

function saveTokens(name: string, tokens: StoredTokens): void {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  fs.writeFileSync(getTokenPath(name), JSON.stringify(tokens, null, 2), "utf-8");
}

function loadTokens(name: string): StoredTokens | null {
  const tokenPath = getTokenPath(name);
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  const data = fs.readFileSync(tokenPath, "utf-8");
  return JSON.parse(data) as StoredTokens;
}

export async function _authorize(
  name: string,
  config: OAuthConfig
): Promise<{ success: boolean }> {
  const port = config.port ?? DEFAULT_PORT;
  const redirectUri = `http://127.0.0.1:${port}`;
  const state = crypto.randomBytes(16).toString("hex");
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const scopes = Array.isArray(config.scopes)
    ? config.scopes.join(" ")
    : config.scopes;

  const authParams = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });

  const authorizationUrl = `${config.authUrl}?${authParams.toString()}`;

  // Start callback server before opening browser
  const callbackPromise = waitForCallback(port);

  openBrowser(authorizationUrl);

  const { code, state: returnedState } = await callbackPromise;

  if (returnedState !== state) {
    throw new Error("OAuth state mismatch — possible CSRF attack.");
  }

  const tokenResponse = await exchangeCodeForTokens(config.tokenUrl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: codeVerifier,
  });

  const tokens: StoredTokens = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    expires_at: Date.now() + tokenResponse.expires_in * 1000,
    token_url: config.tokenUrl,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  };

  saveTokens(name, tokens);

  return { success: true };
}

export async function _getAccessToken(name: string): Promise<string> {
  const tokens = loadTokens(name);
  if (!tokens) {
    throw new Error(
      `No OAuth tokens found for "${name}". Run authorize("${name}", config) first.`
    );
  }

  // Token still valid
  if (Date.now() < tokens.expires_at - EXPIRY_BUFFER_MS) {
    return tokens.access_token;
  }

  // Need to refresh
  if (!tokens.refresh_token) {
    throw new Error(
      `OAuth token for "${name}" has expired and no refresh token is available. Run authorize("${name}", config) again.`
    );
  }

  const refreshResponse = await exchangeCodeForTokens(tokens.token_url, {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: tokens.client_id,
    client_secret: tokens.client_secret,
  });

  // Update stored tokens
  tokens.access_token = refreshResponse.access_token;
  tokens.expires_at = Date.now() + refreshResponse.expires_in * 1000;
  // Some providers rotate refresh tokens
  if (refreshResponse.refresh_token) {
    tokens.refresh_token = refreshResponse.refresh_token;
  }

  saveTokens(name, tokens);

  return tokens.access_token;
}

export function _isAuthorized(name: string): boolean {
  return loadTokens(name) !== null;
}

export function _revokeAuth(name: string): { revoked: boolean } {
  const tokenPath = getTokenPath(name);
  if (fs.existsSync(tokenPath)) {
    fs.unlinkSync(tokenPath);
    return { revoked: true };
  }
  return { revoked: false };
}

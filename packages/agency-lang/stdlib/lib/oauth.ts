import http from "http";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";

function getTokenDir(): string {
  return process.env.AGENCY_OAUTH_TOKEN_DIR || path.join(os.homedir(), ".agency", "oauth");
}
const DEFAULT_PORT = 8914;
const EXPIRY_BUFFER_MS = 60000;
const AUTH_TIMEOUT_MS = 300000;
const VALID_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

// Per-provider mutex to prevent concurrent refresh races
const refreshLocks: Record<string, Promise<string> | undefined> = {};

export type OAuthConfig = {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string | string[];
  port?: number;
  extraAuthParams?: string | Record<string, string>;
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
  if (!VALID_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid OAuth provider name: "${name}". Use only letters, numbers, dots, hyphens, and underscores.`
    );
  }
  return path.join(getTokenDir(), `${name}.json`);
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseExtraParams(str: string): Record<string, string> {
  if (!str.trim()) return {};
  const result: Record<string, string> = {};
  for (const pair of str.trim().split(/\s+/)) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx > 0) {
      result[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }
  return result;
}

function openBrowser(url: string): void {
  if (process.platform === "darwin") {
    execFile("open", [url], () => {});
  } else if (process.platform === "win32") {
    execFile("cmd.exe", ["/c", "start", "", url], () => {});
  } else {
    execFile("xdg-open", [url], () => {});
  }
}

function waitForCallback(
  port: number
): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const server = http.createServer((req, res) => {
      if (settled) {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state") ?? "";

      if (error) {
        settled = true;
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Authorization failed</h1><p>${escapeHtml(error)}</p>`);
        clearTimeout(timer);
        server.close();
        reject(new Error(`OAuth authorization failed: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Missing authorization code</h1>");
        return;
      }

      settled = true;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>Authorization successful!</h1><p>You can close this tab and return to your terminal.</p>"
      );
      clearTimeout(timer);
      server.close();
      resolve({ code, state });
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      settled = true;
      clearTimeout(timer);
      if (err.code === "EADDRINUSE") {
        reject(new Error(`OAuth callback port ${port} is already in use. Try a different port.`));
      } else {
        reject(new Error(`OAuth callback server error: ${err.message}`));
      }
    });

    server.listen(port, "127.0.0.1");

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error("OAuth authorization timed out (5 minutes)"));
      }
    }, AUTH_TIMEOUT_MS);
    timer.unref();
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
    expires_in: Number(data.expires_in) || 3600,
  };
}

async function saveTokens(name: string, tokens: StoredTokens): Promise<void> {
  await fs.mkdir(getTokenDir(), { recursive: true });
  await fs.writeFile(getTokenPath(name), JSON.stringify(tokens, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

async function loadTokens(name: string): Promise<StoredTokens | null> {
  const tokenPath = getTokenPath(name);
  try {
    const data = await fs.readFile(tokenPath, "utf-8");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (!parsed.access_token || !parsed.token_url || !parsed.client_id) {
      return null;
    }
    return parsed as unknown as StoredTokens;
  } catch {
    return null;
  }
}

export async function _authorize(
  name: string,
  config: OAuthConfig
): Promise<{ success: boolean }> {
  const port = (config.port && config.port > 0) ? config.port : DEFAULT_PORT;
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
  });

  // Provider-specific params (e.g. access_type=offline for Google)
  if (config.extraAuthParams) {
    const params = typeof config.extraAuthParams === "string"
      ? parseExtraParams(config.extraAuthParams)
      : config.extraAuthParams;
    for (const [key, value] of Object.entries(params)) {
      authParams.set(key, value);
    }
  }

  const authorizationUrl = `${config.authUrl}?${authParams.toString()}`;

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

  await saveTokens(name, tokens);

  return { success: true };
}

export async function _getAccessToken(name: string): Promise<string> {
  const tokens = await loadTokens(name);
  if (!tokens) {
    throw new Error(
      `No OAuth tokens found for "${name}". Run authorize() first.`
    );
  }

  if (Date.now() < tokens.expires_at - EXPIRY_BUFFER_MS) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new Error(
      `OAuth token for "${name}" has expired and no refresh token is available. Run authorize() again.`
    );
  }

  // Use a mutex to prevent concurrent refresh attempts for the same provider.
  if (refreshLocks[name]) {
    return refreshLocks[name]!;
  }

  const refreshPromise = (async () => {
    try {
      const refreshResponse = await exchangeCodeForTokens(tokens.token_url, {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: tokens.client_id,
        client_secret: tokens.client_secret,
      });

      tokens.access_token = refreshResponse.access_token;
      tokens.expires_at = Date.now() + refreshResponse.expires_in * 1000;
      // Some providers rotate refresh tokens
      if (refreshResponse.refresh_token) {
        tokens.refresh_token = refreshResponse.refresh_token;
      }

      await saveTokens(name, tokens);

      return tokens.access_token;
    } finally {
      delete refreshLocks[name];
    }
  })();

  refreshLocks[name] = refreshPromise;
  return refreshPromise;
}

export async function _isAuthorized(name: string): Promise<boolean> {
  return (await loadTokens(name)) !== null;
}

export async function _revokeAuth(name: string): Promise<{ revoked: boolean }> {
  const tokenPath = getTokenPath(name);
  try {
    await fs.unlink(tokenPath);
    return { revoked: true };
  } catch {
    return { revoked: false };
  }
}

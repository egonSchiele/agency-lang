import fs from "fs";
import path from "path";
import os from "os";
import type { OAuthTokens, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";

const DEFAULT_TOKEN_DIR = path.join(os.homedir(), ".agency", "tokens");

export class TokenStore {
  private dir: string;

  constructor(dir: string = DEFAULT_TOKEN_DIR) {
    this.dir = dir;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
  }

  private tokenPath(serverName: string): string {
    return path.join(this.dir, `${serverName}.json`);
  }

  private verifierPath(serverName: string): string {
    return path.join(this.dir, `${serverName}.verifier`);
  }

  private clientInfoPath(serverName: string): string {
    return path.join(this.dir, `${serverName}.client.json`);
  }

  private atomicWrite(filePath: string, data: string): void {
    this.ensureDir();
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  }

  private readJson(filePath: string): any | undefined {
    try {
      const data = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  async saveTokens(serverName: string, tokens: OAuthTokens): Promise<void> {
    this.atomicWrite(this.tokenPath(serverName), JSON.stringify(tokens));
  }

  async loadTokens(serverName: string): Promise<OAuthTokens | undefined> {
    return this.readJson(this.tokenPath(serverName));
  }

  async deleteTokens(serverName: string): Promise<void> {
    const p = this.tokenPath(serverName);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    await this.deleteCodeVerifier(serverName);
    await this.deleteClientInfo(serverName);
  }

  async saveCodeVerifier(serverName: string, verifier: string): Promise<void> {
    this.atomicWrite(this.verifierPath(serverName), verifier);
  }

  async loadCodeVerifier(serverName: string): Promise<string | undefined> {
    try {
      return fs.readFileSync(this.verifierPath(serverName), "utf-8");
    } catch {
      return undefined;
    }
  }

  async deleteCodeVerifier(serverName: string): Promise<void> {
    const p = this.verifierPath(serverName);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  async saveClientInfo(serverName: string, info: OAuthClientInformationMixed): Promise<void> {
    this.atomicWrite(this.clientInfoPath(serverName), JSON.stringify(info));
  }

  async loadClientInfo(serverName: string): Promise<OAuthClientInformationMixed | undefined> {
    return this.readJson(this.clientInfoPath(serverName));
  }

  async deleteClientInfo(serverName: string): Promise<void> {
    const p = this.clientInfoPath(serverName);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  async listServers(): Promise<string[]> {
    try {
      const files = fs.readdirSync(this.dir);
      return files
        .filter((f) => f.endsWith(".json") && !f.endsWith(".client.json"))
        .map((f) => f.replace(/\.json$/, ""));
    } catch {
      return [];
    }
  }
}

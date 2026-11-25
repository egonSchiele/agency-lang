import { DEFAULT_TIMEOUT_SEC, type ExecResult, type Sandbox } from "./types.js";

export type FakeReply = { exitCode?: number; output?: string };

/** A sandbox that runs nothing. It records every line it is given, answers
 *  each from `reply` (exit 0 and no output when that returns undefined),
 *  and keeps uploads in memory. For unit tests. */
export class FakeSandbox implements Sandbox {
  readonly id = "fake";
  /** Every exec and startBackground line, in order. */
  readonly commands: string[] = [];
  /** startBackground lines only. */
  readonly background: string[] = [];
  /** The timeout of each exec, in order. */
  readonly timeouts: number[] = [];
  readonly files: Record<string, Buffer> = {};
  deleted = false;

  constructor(private readonly reply: (command: string) => FakeReply | undefined = () => undefined) {}

  async exec(command: string, options: { timeoutSec?: number } = {}): Promise<ExecResult> {
    this.commands.push(command);
    this.timeouts.push(options.timeoutSec ?? DEFAULT_TIMEOUT_SEC);
    const answer = this.reply(command) ?? {};
    return { exitCode: answer.exitCode ?? 0, output: answer.output ?? "" };
  }

  async startBackground(command: string): Promise<void> {
    this.commands.push(command);
    this.background.push(command);
  }

  async upload(content: Buffer, remotePath: string): Promise<void> {
    this.files[remotePath] = content;
  }

  async download(remotePath: string): Promise<Buffer> {
    const content = this.files[remotePath];
    if (content === undefined) {
      throw new Error(`no such file in the sandbox: ${remotePath}`);
    }
    return content;
  }

  async delete(): Promise<void> {
    this.deleted = true;
  }
}

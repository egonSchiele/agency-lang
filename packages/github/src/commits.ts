import { success, failure, isFailure } from "agency-lang/runtime";
import { runGit, assertValidRefName } from "./internal/git.js";
import { formatError } from "./internal/errors.js";
import type { Result } from "./internal/result.js";

const DEFAULT_AUTHOR = { name: "Agency Lang Agent", email: "agency-bot@agency-lang.com" };

// Reject control characters and other delimiters that could let an attacker
// inject additional `-c key=value` config entries when the author identity
// is interpolated into `git -c user.name=... -c user.email=... commit`.
// `execFile` already prevents shell injection, but `git -c` parses
// `key=value`; an embedded newline could terminate one entry and start
// another (e.g. `name=Eve\ncore.sshCommand=...`).
function validateAuthorIdentity(author: { name: string; email: string }): string | undefined {
  if (!author.name || author.name.trim() === "") return "author name is empty";
  if (!author.email || author.email.trim() === "") return "author email is empty";
  if (/[\n\r\0]/.test(author.name)) return "author name contains a control character";
  if (/[\n\r\0]/.test(author.email)) return "author email contains a control character";
  return undefined;
}

function trailer(): string {
  const version = process.env.AGENCY_RUN_ACTION_VERSION;
  return version
    ? `Generated-by-Agency-Action: egonSchiele/run-agency-action@${version}`
    : `Generated-by-Agency-Action: local`;
}

export async function commitFiles(args: {
  message: string;
  files?: string[];
  // Either pass `author: { name, email }` (TS callers) or `authorName`/`authorEmail`
  // (Agency wrappers — Agency lacks a clean null-default for object args).
  // An empty `authorName` means "use the default author".
  author?: { name: string; email: string };
  authorName?: string;
  authorEmail?: string;
  push?: boolean;
  branch?: string;
}): Promise<Result<{ sha: string }>> {
  if (args.branch !== undefined && args.branch !== "") {
    try {
      assertValidRefName(args.branch);
    } catch (e) {
      return failure(formatError(e)) as Result<{ sha: string }>;
    }
  }

  const shouldPush = args.push ?? true;
  // Only treat authorName/authorEmail as an override if BOTH are non-empty.
  // Git rejects empty author identity, and silently using "" for one would
  // produce a confusing low-level git failure.
  const authorFromNames = (args.authorName && args.authorEmail)
    ? { name: args.authorName, email: args.authorEmail }
    : undefined;
  if (args.authorName && !args.authorEmail) {
    return failure("commitFiles: authorName provided without authorEmail") as Result<{ sha: string }>;
  }
  const author = args.author ?? authorFromNames ?? DEFAULT_AUTHOR;

  const authorError = validateAuthorIdentity(author);
  if (authorError) {
    return failure(`commitFiles: ${authorError}`) as Result<{ sha: string }>;
  }

  if (args.branch && args.branch !== "") {
    const checkout = await runGit(["checkout", "-B", args.branch]);
    if (isFailure(checkout)) return checkout as Result<{ sha: string }>;
  }

  const add = args.files && args.files.length > 0
    ? await runGit(["add", "--", ...args.files])
    : await runGit(["add", "-u"]);
  if (isFailure(add)) return add as Result<{ sha: string }>;

  const commit = await runGit([
    "-c", `user.name=${author.name}`,
    "-c", `user.email=${author.email}`,
    "commit", "-m", args.message, "--trailer", trailer(),
  ]);
  if (isFailure(commit)) return commit as Result<{ sha: string }>;

  if (shouldPush) {
    const branchResult = (args.branch && args.branch !== "")
      ? { ok: true as const, name: args.branch }
      : await currentBranch();
    if (!branchResult.ok) return branchResult.failure as Result<{ sha: string }>;
    const push = await runGit(["push", "--set-upstream", "origin", branchResult.name]);
    if (isFailure(push)) return push as Result<{ sha: string }>;
  }

  const head = await runGit(["rev-parse", "HEAD"]);
  if (isFailure(head)) return head as Result<{ sha: string }>;
  return success({ sha: head.value.stdout.trim() }) as Result<{ sha: string }>;
}

type BranchLookup = { ok: true; name: string } | { ok: false; failure: Result<never> };

async function currentBranch(): Promise<BranchLookup> {
  const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (isFailure(result)) return { ok: false, failure: result as Result<never> };
  return { ok: true, name: result.value.stdout.trim() };
}

// Text parsing for safeBash's `gh` rule. Each function throws an Error that
// says what is wrong, and the Agency side turns the throw into the plan's
// broad reason, so a refused line tells the model why.
import { _ghCheckNumber } from "./github/args.js";
import { checkRepoCoord, type RepoCoord } from "./github/repo.js";

export type GhTarget = { number: number; owner: string; repo: string };

const DIGITS = /^[0-9]+$/;
const TARGET_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/([0-9]+)$/;
const REPO_FLAG = /^(?:github\.com\/)?([^/]+)\/([^/]+)$/;

/** `1451`, or `https://github.com/OWNER/REPO/pull/1451` (also `/issues/`).
 *  owner and repo are "" for a bare number. */
export function _ghParseTarget(text: string, kind: "pull" | "issues"): GhTarget {
  if (DIGITS.test(text)) {
    const number = Number(text);
    _ghCheckNumber(number);
    return { number, owner: "", repo: "" };
  }
  const url = TARGET_URL.exec(text);
  if (url === null) {
    throw new Error(
      `Expected a number or a https://github.com/OWNER/REPO/${kind}/N URL, got "${text}".`,
    );
  }
  if (url[3] !== kind) {
    throw new Error(`Expected a /${kind}/ URL, got "${text}".`);
  }
  const number = Number(url[4]);
  _ghCheckNumber(number);
  const coord = checkRepoCoord({ owner: url[1], repo: url[2] });
  return { number, owner: coord.owner, repo: coord.repo };
}

/** `OWNER/REPO` or `github.com/OWNER/REPO`, the value of `--repo` or `-R`. */
export function _ghParseRepoFlag(text: string): RepoCoord {
  const match = REPO_FLAG.exec(text);
  if (match === null) {
    throw new Error(`--repo takes OWNER/REPO or github.com/OWNER/REPO, got "${text}".`);
  }
  return checkRepoCoord({ owner: match[1], repo: match[2] });
}

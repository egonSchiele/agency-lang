---
name: "git"
---

# git

Typed, safe git tools for agents. Each tool builds its own git command
  internally, so the model never supplies a raw flag. Read tools (status, log,
  diff, ...) raise effects an agent policy can auto-approve. Write tools (add,
  commit, checkout, ...) prompt for approval. Tighten any tool before handing it
  to an agent with `.partial()`, e.g.
  `gitAdd.partial(all: false, allowedPaths: ["src/"])` or
  `gitBranchDelete.partial(force: false, protectedBranches: ["main"])`.

  Every tool takes an optional `cwd`, the repo to operate on. It defaults to the
  agent working directory (see `setAgentCwd`). Pass an absolute path to target a
  different repo.

  ```ts
  import { gitStatus, gitCommit } from "std::git"

  node main() {
    const status = gitStatus()             // read: auto-approvable
    print(status.branch)
    gitCommit("Update docs") with approve  // write: prompts for approval
  }
  ```

## Types

### ChangeCode

git porcelain change codes: "." unmodified, "M" modified, "A" added,
  "D" deleted, "R" renamed, "C" copied, "U" unmerged, "T" type-changed,
  "?" untracked, "!" ignored.

```ts
/** git porcelain change codes: "." unmodified, "M" modified, "A" added,
  "D" deleted, "R" renamed, "C" copied, "U" unmerged, "T" type-changed,
  "?" untracked, "!" ignored. */
export type ChangeCode =
  | "."
  | "M"
  | "A"
  | "D"
  | "R"
  | "C"
  | "U"
  | "T"
  | "?"
  | "!"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L47))

### FileStatus

```ts
export type FileStatus = {
  path: string;
  index: ChangeCode;
  worktree: ChangeCode;
  renamedFrom?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L48))

### GitStatus

```ts
export type GitStatus = {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  entries: FileStatus[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L54))

### GitCommit

```ts
export type GitCommit = {
  sha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L61))

### GitLog

```ts
export type GitLog = {
  commits: GitCommit[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L69))

### FileDiff

```ts
export type FileDiff = {
  path: string;
  status: ChangeCode;
  additions?: number;
  deletions?: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L70))

### GitDiff

```ts
export type GitDiff = {
  files: FileDiff[];
  patch: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L76))

### GitBranch

```ts
export type GitBranch = {
  name: string;
  current: boolean;
  upstream: string;
  sha: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L77))

### BlameLine

```ts
export type BlameLine = {
  sha: string;
  author: string;
  line: number;
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L83))

### GitRemote

```ts
export type GitRemote = {
  name: string;
  url: string;
  direction: "fetch" | "push"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L89))

### GitStash

```ts
export type GitStash = {
  ref: string;
  description: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L90))

### GitRead

Read-only git effects, auto-approvable.

```ts
/** Read-only git effects, auto-approvable. */
export effectSet GitRead = <std::git::status, std::git::log, std::git::diff, std::git::show, std::git::branchList, std::git::remoteList, std::git::blame, std::git::stashList>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L116))

### GitWrite

Mutating git effects, should prompt.

```ts
/** Mutating git effects, should prompt. */
export effectSet GitWrite = <std::git::add, std::git::commit, std::git::checkout, std::git::switch, std::git::branchCreate, std::git::branchDelete, std::git::stashPush, std::git::stashPop, std::git::restore>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L118))

### Git

All git effects.

```ts
/** All git effects. */
export effectSet Git = <GitRead, GitWrite>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L120))

## Effects

### std::git::status

```ts
effect std::git::status {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L96))

### std::git::log

```ts
effect std::git::log {
  cwd: string;
  ref: string;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L97))

### std::git::diff

```ts
effect std::git::diff {
  cwd: string;
  ref: string;
  ref2: string;
  staged: boolean;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L98))

### std::git::show

```ts
effect std::git::show {
  cwd: string;
  ref: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L99))

### std::git::branchList

```ts
effect std::git::branchList {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L100))

### std::git::remoteList

```ts
effect std::git::remoteList {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L101))

### std::git::blame

```ts
effect std::git::blame {
  cwd: string;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L102))

### std::git::stashList

```ts
effect std::git::stashList {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L103))

### std::git::add

```ts
effect std::git::add {
  cwd: string;
  paths: string[];
  all: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L105))

### std::git::commit

```ts
effect std::git::commit {
  cwd: string;
  message: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L106))

### std::git::checkout

```ts
effect std::git::checkout {
  cwd: string;
  target: string;
  force: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L107))

### std::git::switch

```ts
effect std::git::switch {
  cwd: string;
  branch: string;
  create: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L108))

### std::git::branchCreate

```ts
effect std::git::branchCreate {
  cwd: string;
  branch: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L109))

### std::git::branchDelete

```ts
effect std::git::branchDelete {
  cwd: string;
  branch: string;
  force: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L110))

### std::git::stashPush

```ts
effect std::git::stashPush {
  cwd: string;
  message: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L111))

### std::git::stashPop

```ts
effect std::git::stashPop {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L112))

### std::git::restore

```ts
effect std::git::restore {
  cwd: string;
  paths: string[];
  staged: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L113))

## Functions

### gitIsRepo

```ts
gitIsRepo(cwd: string = ""): boolean raises <std::git::status>
```

True when `cwd` is inside a git work tree. Never fails: a directory that is not
  a git repository (or does not exist) returns false, so callers can guard on it
  before running other git tools.
  @param cwd - The directory to check. Defaults to the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** `boolean`

**Throws:** `std::git::status`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L135))

### gitStatus

```ts
gitStatus(cwd: string = ""): GitStatus raises <std::git::status>
```

Show the working-tree status: current branch, ahead/behind counts, and
  changed files.
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** [GitStatus](#gitstatus)

**Throws:** `std::git::status`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L147))

### gitLog

```ts
gitLog(
  n: number = 20,
  oneline: boolean = false,
  path: string = "",
  ref: string = "",
  author: string = "",
  allowedPaths: string[] = [],
  cwd: string = "",
): GitLog raises <std::git::log>
```

Show commit history as structured commits.
  @param n - Max number of commits (default 20).
  @param oneline - Omit commit bodies.
  @param path - Limit to commits touching this path (may not start with "-").
  @param ref - Start from this revision (e.g. HEAD~5, a branch, a sha).
  @param author - Filter by author substring.
  @param allowedPaths - If non-empty, path must fall under one of these prefixes.
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

`allowedPaths` is a developer guardrail: bind a prefix list via `.partial()`
    to constrain which paths the model may query.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` | 20 |
| oneline | `boolean` | false |
| path | `string` | "" |
| ref | `string` | "" |
| author | `string` | "" |
| allowedPaths | `string[]` | [] |
| cwd | `string` | "" |

**Returns:** [GitLog](#gitlog)

**Throws:** `std::git::log`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L160))

### gitDiff

```ts
gitDiff(
  ref: string = "",
  ref2: string = "",
  staged: boolean = false,
  path: string = "",
  allowedPaths: string[] = [],
  cwd: string = "",
): GitDiff raises <std::git::diff>
```

Show a diff as a structured per-file summary plus the raw unified patch.
  @param ref - Compare against this revision (default: working tree vs index).
  @param ref2 - Optional second revision to diff ref..ref2.
  @param staged - Diff the index (staged changes) instead of the working tree.
  @param path - Limit the diff to this path (may not start with "-").
  @param allowedPaths - If non-empty, path must fall under one of these prefixes.
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

`allowedPaths` is a developer guardrail: bind a prefix list via `.partial()`
    to constrain which paths the model may diff.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ref | `string` | "" |
| ref2 | `string` | "" |
| staged | `boolean` | false |
| path | `string` | "" |
| allowedPaths | `string[]` | [] |
| cwd | `string` | "" |

**Returns:** [GitDiff](#gitdiff)

**Throws:** `std::git::diff`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L185))

### gitShow

```ts
gitShow(ref: string = "HEAD", cwd: string = ""): GitDiff raises <std::git::show>
```

Show a commit as a structured per-file summary plus the raw patch. Line
  counts are approximate for merge commits (combined diffs are not counted).
  @param ref - The revision to show (default HEAD).
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ref | `string` | "HEAD" |
| cwd | `string` | "" |

**Returns:** [GitDiff](#gitdiff)

**Throws:** `std::git::show`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L206))

### gitBranchList

```ts
gitBranchList(cwd: string = ""): GitBranch[] raises <std::git::branchList>
```

List local branches with their current-marker, upstream, and sha.
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** `GitBranch[]`

**Throws:** `std::git::branchList`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L218))

### gitRemoteList

```ts
gitRemoteList(cwd: string = ""): GitRemote[] raises <std::git::remoteList>
```

List configured remotes with their fetch/push URLs.
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** `GitRemote[]`

**Throws:** `std::git::remoteList`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L228))

### gitBlame

```ts
gitBlame(
  path: string,
  ref: string = "",
  cwd: string = "",
): BlameLine[] raises <std::git::blame>
```

Show line-by-line authorship for a file.
  @param path - The file to blame (may not start with "-").
  @param ref - Optional revision to blame at.
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| ref | `string` | "" |
| cwd | `string` | "" |

**Returns:** `BlameLine[]`

**Throws:** `std::git::blame`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L238))

### gitStashList

```ts
gitStashList(cwd: string = ""): GitStash[] raises <std::git::stashList>
```

List stashes with their ref and description.
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** `GitStash[]`

**Throws:** `std::git::stashList`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L250))

### gitAdd

```ts
gitAdd(
  paths: string[] = [],
  all: boolean = false,
  allowedPaths: string[] = [],
  cwd: string = "",
): string raises <std::git::add>
```

Stage changes for commit.
  @param paths - Files to stage (may not start with "-").
  @param all - Stage every change in the repo (git add -A).
  @param allowedPaths - If non-empty, each path must fall under one of these prefixes.
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

`all` and `allowedPaths` are developer guardrails: bind `all: false` and/or
    a prefix list for `allowedPaths` via `.partial()` before handing this to an
    agent.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| paths | `string[]` | [] |
| all | `boolean` | false |
| allowedPaths | `string[]` | [] |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::add`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L265))

### gitCommit

```ts
gitCommit(message: string, cwd: string = ""): string raises <std::git::commit>
```

Create a commit from the staged changes.
  @param message - The commit message.
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::commit`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L283))

### gitCheckout

```ts
gitCheckout(
  target: string,
  force: boolean = false,
  cwd: string = "",
): string raises <std::git::checkout>
```

Check out a branch, commit, or path.
  @param target - The branch/commit/path (may not start with "-").
  @param force - Discard local changes while checking out (git checkout --force).
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

Bind `force: false` via `.partial()` to forbid discarding local changes.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| target | `string` |  |
| force | `boolean` | false |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::checkout`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L297))

### gitSwitch

```ts
gitSwitch(
  branch: string,
  create: boolean = false,
  cwd: string = "",
): string raises <std::git::switch>
```

Switch to a branch.
  @param branch - The branch to switch to (may not start with "-").
  @param create - Create the branch first (git switch -c).
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| branch | `string` |  |
| create | `boolean` | false |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::switch`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L315))

### gitBranchCreate

```ts
gitBranchCreate(
  branch: string,
  cwd: string = "",
): string raises <std::git::branchCreate>
```

Create a new branch at HEAD (does not switch to it).
  @param branch - The new branch name (may not start with "-").
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| branch | `string` |  |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::branchCreate`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L329))

### gitBranchDelete

```ts
gitBranchDelete(
  branch: string,
  force: boolean = false,
  protectedBranches: string[] = [],
  cwd: string = "",
): string raises <std::git::branchDelete>
```

Delete a local branch.
  @param branch - The branch to delete (may not start with "-").
  @param force - Delete even if the branch is unmerged (git branch -D).
  @param protectedBranches - Branch names that may never be deleted (e.g. ["main", "master"]).
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

Guardrails: bind `force: false` and/or a `protectedBranches` list via
    `.partial()` before handing this to an agent.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| branch | `string` |  |
| force | `boolean` | false |
| protectedBranches | `string[]` | [] |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::branchDelete`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L345))

### gitStashPush

```ts
gitStashPush(
  message: string = "",
  cwd: string = "",
): string raises <std::git::stashPush>
```

Stash the working-tree changes.
  @param message - Optional stash message.
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` | "" |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::stashPush`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L366))

### gitStashPop

```ts
gitStashPop(cwd: string = ""): string raises <std::git::stashPop>
```

Apply and drop the most recent stash.
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::stashPop`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L379))

### gitRestore

```ts
gitRestore(
  paths: string[],
  staged: boolean = false,
  allowedPaths: string[] = [],
  cwd: string = "",
): string raises <std::git::restore>
```

Restore files to a previous state.
  @param paths - Files to restore (may not start with "-").
  @param staged - Unstage the files instead of discarding working-tree changes.
  @param allowedPaths - If non-empty, each path must fall under one of these prefixes.
  @param cwd - The git repo directory. Defaults to the agent working directory. Pass an absolute path to target a different repo.

`allowedPaths` is a developer guardrail: bind a prefix list via `.partial()`
    to constrain which paths the model may restore.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| paths | `string[]` |  |
| staged | `boolean` | false |
| allowedPaths | `string[]` | [] |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::restore`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L393))

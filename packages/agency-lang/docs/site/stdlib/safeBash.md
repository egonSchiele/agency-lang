---
name: "safeBash"
---

# safeBash

## Types

### Word

```ts
export type Word =
  | LiteralWord
  | PathWord
  | GlobWord
  | FlagWord
  | SingleQuotedWord
  | DoubleQuotedWord
  | VariableWord
  | InterpolatedVariableWord
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L41))

### ScriptName

```ts
export type ScriptName = LiteralWord | PathWord
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L51))

### LiteralWord

```ts
export type LiteralWord = {
  tag: "literal";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L53))

### PathWord

```ts
export type PathWord = {
  tag: "path";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L58))

### GlobWord

An unquoted word bash will expand (`*.ts`, `src/*.md`). Its own node
so it is never mistaken for the quoted text `'*.ts'`; no rule here
treats it as a literal.

```ts
/** An unquoted word bash will expand (`*.ts`, `src/*.md`). Its own node
 * so it is never mistaken for the quoted text `'*.ts'`; no rule here
 * treats it as a literal. */
export type GlobWord = {
  tag: "glob";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L66))

### FlagWord

```ts
export type FlagWord = {
  tag: "flag";
  flagName: string;
  flagValue?: string;
  /** Present and true when the value is an unquoted glob (`--include=*.ts`). */
  valueIsGlob?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L71))

### SingleQuotedWord

```ts
export type SingleQuotedWord = {
  tag: "singleQuoted";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L79))

### DoubleQuotedWord

```ts
export type DoubleQuotedWord = {
  tag: "doubleQuoted";
  parts: Word[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L84))

### VariableWord

```ts
export type VariableWord = {
  tag: "variable";
  name: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L89))

### InterpolatedVariableWord

A word built from two or more adjacent parts: `$HOME.txt`, `"a"b`,
`"$HOME"/x`. These are ONE word in bash; split into separate words they
become separate arguments and the command means something else.

```ts
/** A word built from two or more adjacent parts: `$HOME.txt`, `"a"b`,
 * `"$HOME"/x`. These are ONE word in bash; split into separate words they
 * become separate arguments and the command means something else.
 */
export type InterpolatedVariableWord = {
  tag: "interpolatedVariable";
  parts: (
  | LiteralWord
  | VariableWord
  | SingleQuotedWord
  | DoubleQuotedWord)[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L98))

### Assignment

`name=value` (or `name=` with a null value) before a command.

```ts
/** `name=value` (or `name=` with a null value) before a command. */
export type Assignment = {
  tag: "assignment";
  name: string;
  value?: Word
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L108))

### Redirect

A redirect like `> out.txt`, `>> log`, `2> err.txt`, `< in.txt`, or
the dup `2>&1` (op `>&`, target a one-digit literal). `fd` is the
explicit file descriptor (`2` in `2>`), or undefined for the default.
Heredocs and here-strings are rejected rather than parsed.

```ts
/** A redirect like `> out.txt`, `>> log`, `2> err.txt`, `< in.txt`, or
 * the dup `2>&1` (op `>&`, target a one-digit literal). `fd` is the
 * explicit file descriptor (`2` in `2>`), or undefined for the default.
 * Heredocs and here-strings are rejected rather than parsed. */
export type Redirect = {
  tag: "redirect";
  fd?: number;
  op: string;
  target: Word
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L118))

### SimpleCommand

```ts
export type SimpleCommand = {
  tag: "simpleCommand";
  assignments: Assignment[];
  /* The command name, or null for an assignment-only line (`FOO=bar`).
   *  Bash requires at least one of a command name or an assignment. */
  command?: ScriptName;
  /** Every word after the command name, in source order. There is no
   *  `subcommands` field: no syntactic rule separates `git status` from
   *  `echo status`, so splitting them would put a command's real
   *  arguments in whichever bucket the preceding word happened to pick. */
  args: Word[];
  redirects: Redirect[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L125))

### Command

```ts
export type Command = SimpleCommand | Pipeline | And | Or | Parens
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L139))

### PipelineStage

What may sit between pipes: a simple command or a parenthesized group.

```ts
/** What may sit between pipes: a simple command or a parenthesized group. */
export type PipelineStage = SimpleCommand | Parens
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L142))

### Pipeline

`a | b | c`: flat, two or more stages, binding tighter than `&&`/`||`.

```ts
/** `a | b | c`: flat, two or more stages, binding tighter than `&&`/`||`. */
export type Pipeline = {
  tag: "pipeline";
  stages: PipelineStage[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L145))

### And

```ts
export type And = {
  tag: "and";
  left: Command;
  right: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L150))

### Or

```ts
export type Or = {
  tag: "or";
  left: Command;
  right: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L156))

### Parens

```ts
export type Parens = {
  tag: "parens";
  command: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L162))

### BashNode

```ts
export type BashNode =
  | Command
  | SimpleCommand
  | Assignment
  | Redirect
  | Word
  | ScriptName
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L167))

### BashAST

```ts
export type BashAST = Command[]
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L175))

### FlagSpec

Which flags a verb takes. Short letters are listed one per entry, so a
combined `-rn` is checked letter by letter. A long flag that takes no
value is listed as written (`--color=never`).

```ts
/** Which flags a verb takes. Short letters are listed one per entry, so a
 * combined `-rn` is checked letter by letter. A long flag that takes no
 * value is listed as written (`--color=never`). */
export type FlagSpec = {
  /** Flags that stand alone. */
  plain: string[];
  /** Flags that take a value, from the rest of the word (`-A3`), after
   * `=` (`--regexp=x`), or from the next word (`-A 3`). Each may appear
   * once. */
  valued: string[];
  /** Every flag must come before the first positional word. True for a
   * command real grep will run: BSD grep, and GNU grep with
   * POSIXLY_CORRECT set, read a later `-s` as a file to search. */
  optionsFirst: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L464))

### FlagValue

One valued flag and its value. `flag` is the letter for a short flag
(`A`) and the whole name for a long one (`--regexp`).

```ts
/** One valued flag and its value. `flag` is the letter for a short flag
 * (`A`) and the whole name for a long one (`--regexp`). */
export type FlagValue = {
  flag: string;
  value: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L479))

### SplitArgs

A command's arguments checked against a FlagSpec.

```ts
/** A command's arguments checked against a FlagSpec. */
export type SplitArgs = {
  plain: string[];
  values: FlagValue[];
  positionals: Word[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L485))

### ReadVerb

A read verb's flags, how many paths it takes, and whether a bare
digit flag (`-20`) means `-n 20`.

```ts
/** A read verb's flags, how many paths it takes, and whether a bare
 * digit flag (`-20`) means `-n 20`. */
export type ReadVerb = {
  flags: FlagSpec;
  /** 0 for any number; 1 for head and tail (several files print headers)
   * and uniq (a second positional is its output file); 2 for diff and
   * cmp, which need exactly two. */
  maxPaths: number;
  /** True for head and tail, where `-20` is `-n 20`, and the value of
   * `-n` or `-c` is a count. */
  digitFlagIsCount: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1013))

### FlatCommand

One simple command from a flattened line, and whether a pipe feeds
it its stdin. Not named `Stage`: `PipelineStage` is a parsed pipe
stage, which may be a whole parenthesized group.

```ts
/** One simple command from a flattened line, and whether a pipe feeds
 * it its stdin. Not named `Stage`: `PipelineStage` is a parsed pipe
 * stage, which may be a whole parenthesized group. */
export type FlatCommand = {
  command: SimpleCommand;
  readsStdin: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1306))

## Constants

### GREP_FLAGS

```ts
export static const GREP_FLAGS: FlagSpec = {
  plain: [
    "n",
    "r",
    "i",
    "w",
    "l",
    "v",
    "E",
    "F",
    "c",
    "h",
    "H",
    "o",
    "s",
    "--color=never",
  ],
  valued: ["e", "A", "B", "C"],
  optionsFirst: true
}
```

**Type:** [FlagSpec](#flagspec)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L514))

### READ_VERBS

```ts
export static const READ_VERBS: Record<string, ReadVerb> = {
  cat: {
    flags: {
      plain: ["n", "b", "s"],
      valued: [],
      optionsFirst: true
    },
    maxPaths: 0,
    digitFlagIsCount: false
  },
  head: {
    flags: {
      plain: [],
      valued: ["n", "c"],
      optionsFirst: true
    },
    maxPaths: 1,
    digitFlagIsCount: true
  },
  tail: {
    flags: {
      plain: [],
      valued: ["n", "c"],
      optionsFirst: true
    },
    maxPaths: 1,
    digitFlagIsCount: true
  },
  wc: {
    flags: {
      plain: ["l", "w", "c", "m"],
      valued: [],
      optionsFirst: true
    },
    maxPaths: 0,
    digitFlagIsCount: false
  },
  diff: {
    flags: {
      plain: ["u", "q", "N", "w", "b", "B", "--color=never"],
      valued: ["U"],
      optionsFirst: true
    },
    maxPaths: 2,
    digitFlagIsCount: false
  },
  cmp: {
    flags: {
      plain: [],
      valued: [],
      optionsFirst: true
    },
    maxPaths: 2,
    digitFlagIsCount: false
  },
  sort: {
    flags: {
      plain: ["n", "r", "u", "f", "b"],
      valued: ["k", "t"],
      optionsFirst: true
    },
    maxPaths: 0,
    digitFlagIsCount: false
  },
  uniq: {
    flags: {
      plain: ["c", "d", "u", "i"],
      valued: [],
      optionsFirst: true
    },
    maxPaths: 1,
    digitFlagIsCount: false
  },
  cut: {
    flags: {
      plain: [],
      valued: ["d", "f", "c"],
      optionsFirst: true
    },
    maxPaths: 0,
    digitFlagIsCount: false
  },
  nl: {
    flags: {
      plain: [],
      valued: ["b"],
      optionsFirst: true
    },
    maxPaths: 0,
    digitFlagIsCount: false
  },
  tac: {
    flags: {
      plain: [],
      valued: [],
      optionsFirst: true
    },
    maxPaths: 0,
    digitFlagIsCount: false
  },
  rev: {
    flags: {
      plain: [],
      valued: [],
      optionsFirst: true
    },
    maxPaths: 0,
    digitFlagIsCount: false
  }
}
```

**Type:** `Record<string, ReadVerb>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1034))

## Functions

### effectsFor

```ts
effectsFor(
  command: SimpleCommand,
  cwd: string,
  readsStdin: boolean = false,
): Result<Effect[]>
```

Which interrupts this one command needs raised.

  A failure means the command is not recognized. The caller turns that
  into a `std::bash` question for the whole string rather than trying to
  ask a narrow question about part of it.

  @param command - One simple command from the parsed AST
  @param cwd - The resolved working directory, for payloads that need it
  @param readsStdin - True when a pipe feeds this command its stdin

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | [SimpleCommand](#simplecommand) |  |
| cwd | `string` |  |
| readsStdin | `boolean` | false |

**Returns:** `Result<Effect[]>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L309))

### outcomeOf

```ts
outcomeOf(plan: Plan): string
```

Name the outcome of a plan: refuse, shellFree, agency, narrow, or broad.
  Exhaustive over Execution, so a new execution kind is a type error here.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| plan | [Plan](safeBash/actions.md#plan) |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1281))

### planFor

```ts
planFor(source: string, cwd: string): Plan
```

Decide everything about a call before any of it happens.

  Parses the string, classifies every command, and works out which
  interrupts to raise and what to run. Nothing here has an effect, which
  is what makes the decision testable: hand in a string, look at the plan.

  @param source - One or more bash commands
  @param cwd - The resolved working directory

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| cwd | `string` |  |

**Returns:** [Plan](safeBash/actions.md#plan)

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1586))

### isRefused

```ts
isRefused(command: SimpleCommand): boolean
```

True when this command must not run, whatever anyone approves.

  Matches the command word, including the last part of a path, so `rm`,
  `/bin/rm` and `./rm` are all refused.

  This wall is friction against the obvious spelling, not a guarantee.
  `find . -delete` and `xargs rm` get past it and are approvable under
  `std::bash`, which is where the actual control lives.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | [SimpleCommand](#simplecommand) |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1686))

### bashParser

```ts
bashParser(code: string): Result<BashAST>
```

Parse a string of bash code into an AST.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| code | `string` |  |

**Returns:** `Result<BashAST>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1762))

### resolveCwd

```ts
resolveCwd(cwd: string): string
```

Which directory a command runs in: the caller's, or the agent's when the
  caller did not say.

  Resolved once, at the top, and then carried on every action. An action
  that did not carry it would run wherever the process happened to be,
  which is the same command doing two different things.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1786))

### safeBash

```ts
safeBash(
  command: string,
  cwd: string = "",
): Result<string> raises <std::bash, std::write, std::grep, std::git::status, std::git::diff, std::git::log, std::read, std::run, std::guard>
```

Run a shell command, asking the narrowest question that describes it.

  `bash` cannot be pre-approved, because a command is a string and a
  string could do anything, so every call needs a human. Many of the
  commands an agent writes can be identified, and for those we ask a more
  specific question — one a policy can answer in advance.

  Nothing runs until every question is answered. If everything is
  approved, the whole string goes to bash in one call, so bash does the
  control flow and produces the output.

  A success result means the command exited 0, and its value is the
  command's stdout. A non-zero exit is a failure whose message carries
  the exit code, stdout, and stderr. There is no need to echo `$?` or
  re-run a command to learn how it exited. Output longer than a couple of
  thousand characters is saved and replaced by a preview that names it;
  read it with readSpill or grepSpill, not with bash.

  @param command - One or more bash commands
  @param cwd - Working directory. Defaults to the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | `string` |  |
| cwd | `string` | "" |

**Returns:** `Result<string>`

**Throws:** `std::bash`, `std::write`, `std::grep`, `std::read`, `std::git::status`, `std::git::log`, `std::git::diff`, `std::guard`, `std::run`

**Needs:** `fileRead`, `fileWrite`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1807))

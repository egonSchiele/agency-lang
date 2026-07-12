# The agent team

The agency agent is a team of specialists behind one prompt. A **coordinator**
reads every message you send and decides how to answer. It replies directly to
simple messages, and it hands larger jobs to a specialist that has the right
tools for the work.

```text
you → coordinator ─┬─ code       (read / write / run / typecheck)
                   ├─ research    (web search / fetch pages)
                   ├─ oracle      (deep reasoning, read-only)
                   ├─ explorer    (broad codebase tours, read-only)
                   └─ review      (check Agency code for errors)
```

Each specialist runs in its own thread, with its own system prompt and its own
set of tools. One specialist cannot see another's conversation, so the
coordinator passes each one a self-contained message. Specialists return a
summary, and the coordinator relays it to you.

You normally never pick a specialist yourself. To send your first turn straight
to one, launch with `--agent <name>` (see [Running the agent](/agent/running)).

## The coordinator

The coordinator does the routing. It answers conversational messages and
clarifying questions itself, and it delegates anything that needs real tools. It
also generates images directly when you ask for one, saving the result to a file.

## The code agent

The code agent handles anything that touches source code or the filesystem. It
can read, write, and edit files, list and search directories, run shell commands,
use git, and typecheck Agency code. Relative paths resolve against the directory
you launched the agent in, so a bare filename like `foo.agency` is enough.

Use it for: writing or changing code, running a build or test, debugging an
error, or answering a focused question about Agency syntax.

It typechecks every Agency file it writes before claiming the change is done, and
it can consult the oracle when it gets stuck.

## The research agent

The research agent looks outward. It searches the web, fetches URLs as HTML,
JSON, or Markdown, and searches Wikipedia. Use it for current information,
external documentation, or summarizing a page.

Web search needs a backend. Pick one with the `/search` command (hosted search,
Tavily, Brave, or off). On the hosted path, search is on by default.

## The oracle

The oracle is a read-only senior reviewer running on a stronger reasoning model.
It can read your code and the Agency docs, but it cannot write, edit, or run
anything. Its job is to think hard about a specific question and return a sharp
verdict.

The coordinator consults it often: before starting a non-trivial task, after the
code agent produces a diff, and whenever a plan needs a second opinion. When the
agent says "let me ask the oracle," this is what it means.

## The explorer

The explorer is a read-only researcher built for breadth. It reads many files and
returns a structured synthesis. Use it for broad questions: "summarize the docs,"
"give me a tour of `lib/parsers/`," or "how does X work across the codebase?"

The difference from the oracle is the shape of the answer. The oracle gives a
decision about one thing. The explorer gives an organized overview of many
things.

## The review agent

The review agent checks Agency code for syntax and type errors. The coordinator
calls it after the code agent produces non-trivial new or changed Agency code, as
a fast correctness pass before showing you the result.

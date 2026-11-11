# Why the agent writes tools

The Agency agent can keep two kinds of thing across sessions. A skill is
a page of notes the agent reads when a task calls for it. A tool is an
Agency function the agent calls. `learnSkill` saves a skill and
`writeToolFor` has a tool written; [learned-catalog.md](./learned-catalog.md)
covers how both are stored and offered.

This doc says what tools are for, what a tool gives you that a skill
cannot, what a tool costs, and when writing one is a waste of time.

## What skills and tools share

Both hold knowledge about one user, and both keep it out of the prompt
until it is needed.

Take a tool that emails a note to the user. It holds the user's address,
their email provider, and the sender address that provider accepts. None
of that belongs in the coordinator's prompt, because most turns never send
an email. A skill could hold the same three facts. If holding facts were
the only goal, a skill would be enough.

## What a tool offers that a skill does not

A skill is knowledge the model still has to carry out. A tool is knowledge
that has already been carried out, in code.

### 1. A strong model does the work once, and a weak model uses it

Suppose the agent runs on a small local model, and the user asks for
today's news. The small model has to pick sources, write search prompts,
and shape the result, and it does each of those poorly.

A `getNews` tool can be written once by a strong model. That model works
out which sources to read and which prompts get good summaries, and writes
the result down as code. The small model then has one job, which is to
call `getNews` with a list of topics.

A skill cannot do this. The small model would read the notes and then
carry them out itself, so the result would still depend on the small
model.

### 2. The same request gets the same treatment every time

Ask the agent to review a pull request and it decides on the spot what to
look at. One review reads the tests closely and skips error handling. The
next review does the reverse. Each review misses something, and which
thing it misses changes.

A PR review tool fixes the approach ahead of time: which files to read,
which checks to run, which questions to answer about each change. The
model still makes judgments inside the tool, but it makes them about the
same things every time.

### 3. A tool can be measured, and then improved

An approach that changes on every run cannot be scored, because there is
no one thing to score. A tool is one fixed thing. You can run a PR review
tool over ten old pull requests, list what it missed, change it, and run
it again to see whether the change helped.

Without a score, there is no way to tell whether a change to the tool
helped.

### 4. A tool's effects are known before it runs

The toolbox reads a tool's effects from its code. The user sees the whole
list at the save prompt, and `listTools` reports it afterwards. So the
user knows ahead of time that the news tool fetches from the web and does
nothing else. An ad hoc run has no such list. The user learns what it
does one approval prompt at a time. See
[toolbox.md](../stdlib/toolbox.md).

### 5. A tool has its own context, arranged for one job

The coordinator's prompt has to prepare it for any request, so it is a
compromise. A tool that calls a model starts that call with an empty
context, and everything in it can be chosen for the one job the tool does.

The Agency coding agent is an example. It is a function, so it is a tool.
It only writes Agency code, so its prompt carries a short tutorial on the
language and a listing of the docs with a description of each file. That
arrangement was tested against others on the `evals/agency-coding` suite.
A listing of file paths without the descriptions scored well below the
full listing, and the tutorial scored best. [agency-writer-prompt.md](./agency-writer-prompt.md)
has the measurements.

So part of improving a tool is arranging its knowledge: what to put in
its prompt, in what order, and what to leave for it to look up. The
context is the only space there is for teaching the model something it
was not trained on.

### 6. The research happens once

Before the agent can email a note, it has to find the email module, read
how to call it, and learn which provider the user has. Done ad hoc, that
happens on every request. A tool pays for it once, when the tool is
written.

## Tool sharpening

Tool sharpening means spending time ahead of a task so that the agent
does that task well every time after. It suits work the user wants done
often and done well.

Sharpening a tool can mean any of these:

1. Moving steps out of the model and into code, so they run the same way
   every time.
2. Deciding ahead of time what the tool looks at, as the PR review
   example does.
3. Arranging the knowledge in the tool's own prompt, as the coding agent's
   tutorial does.
4. Writing tests or an eval suite for the tool, and changing it until the
   score goes up.

`designTool` is the tool that writes tools, so it is the first one to
sharpen. `evals/design-tool` is its eval suite.

## What a tool costs

Every tool the model can call has its name and description in the prompt
on every turn, whether or not the turn uses it. Two learned tools cost
little. Fifty would crowd out the conversation.

The Pi coding agent is built on this point. It ships four tools, which
are read, write, edit, and bash, and a system prompt under a thousand
tokens. Its author gives two reasons. A tool costs context on every turn,
so a tool that a workflow may never use is a permanent cost. And frontier
models already know how to use `rg`, `find`, and `gh` through bash,
because the labs trained them on exactly that.

The second reason is where the Agency agent's situation differs:

- No model was trained on Agency, so the coding agent needs the tutorial.
- A small local model was not trained well on anything, so it needs the
  work done for it.
- No lab will train a model on one user's review standards or email
  address.

Pi also lets each user add their own skills, extensions, and command line
tools. Its small core leaves room for them.

The two views agree on a rule: write as many tools as are useful, and
show the model only a few at a time. Today the agent offers every learned
tool on every turn. When the catalog grows, the agent will need to look a
tool up by need, the way it reads a skill.

## When a tool is not worth writing

- The task happens once.
- The model already does the task well from its training. General coding
  and searching files are examples. A custom tool there adds context cost
  and nothing else.
- The task changes faster than the tool gets used, so the tool is stale
  by the time it runs.
- Writing the tool costs more than the ad hoc runs it replaces. This
  depends on how well `designTool` works, which is one more reason to
  measure it.

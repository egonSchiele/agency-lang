# Verbal tics to cut

Phrases a language model reaches for that a careful human editor cuts.
Check every piece of prose against the list before you show it to
anyone: a commit message, a PR description, a doc, a prompt, a reply.

The list lives in `stdlib/agents/writing/review.agency`, as `ticsPrompt`,
the prompt of the writing reviewer's tics pass. Read it there, and edit it there; this
file is only the pointer, so there is one copy. Each entry has the tic,
an example, and the plain replacement.

The rule behind all of them: state the fact. Do not decorate it, rank
it, or warn the reader about it.

## How to use the list

Write the draft. Then read it once looking for nothing but these
patterns. Most of them cluster at the ends of paragraphs and in the
first sentence of a reply, where the urge to be interesting is
strongest. Cut them there first.

The writing reviewer (`std::agents/writing/review`) runs the same list
as a separate LLM pass beside its main review, so a draft run through
the reviewer gets these findings too, marked advisory.

Sources: a catalog of Claude clichés at
https://www.linkandth.ink/p/catalog-of-claude-cliches, and
https://agentplix.com/posts/how-to-stop-claude-from-writing-it-s-not-its/,
plus the phrases the owner of this repository has flagged in review.

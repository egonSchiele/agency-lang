# Verbal tics to cut

Phrases a language model reaches for that a careful human editor cuts.
Check every piece of prose against this list before you show it to
anyone: a commit message, a PR description, a doc, a prompt, a reply.
Each entry has the tic, an example, and the plain replacement.

The rule behind all of them: state the fact. Do not decorate it, rank
it, or warn the reader about it.

## Sentence shapes

1. Contrastive binary: "not X, but Y", "neither X nor Y", "X, never Y".

   Bad: "Judge the code as Agency, never as JavaScript."
   Good: "Judge the code as Agency. Do not judge it as JavaScript."

   Bad: "Both forms are valid Agency; neither is a JavaScript lambda."
   Good: "Do not flag either form as a JavaScript lambda."

2. Stakes-raising: a sentence that tells the reader how much the last
   sentence matters.

   Bad: "Facts about Agency. Get these wrong and the review is wrong."
   Good: "Facts about Agency:"

3. Aphoristic ender: a short punchy clause that closes a paragraph with
   a flourish. "And no more." "Full stop." "The rest is noise."

   Bad: "The code works; say what the Agency way is and why."
   Good: "The code works. Name the Agency form and say why it is preferred."

4. Colon reveal: a setup, a colon, then the point delivered as a twist.

   Bad: "The song and dance is all in one step you skipped: the parser
   parses literals, but the model returns text."
   Good: "The parser parses string literals. The model returns text.
   Converting between them is where the extra code comes from."

5. Mirrored clauses: two halves built on the same frame for effect.

   Bad: "Keep this to yourself; do not report it as a finding."
   Good: "Do not report this analysis as a finding."

6. Semicolon joins and "but" joins that leave the reader unsure which
   half is the instruction.

   Bad: "Rebuilding it with `failure(e)` loses nothing but is not an error."
   Good: "Return the original failure unchanged. Rebuilding it with
   `failure(e)` changes the source of the error message."

7. Meta-signposting: announcing the structure instead of using it.
   "Three things." "Here's the thing." "Two corrections, then the
   changes." Use a heading or a numbered list and start.

8. The reframe: "Better posed:", "Put differently:", "In other words".
   Say it once, the right way.

## Words and phrases

9. "load-bearing", "seam", "surface" (as a verb), "footgun", "trap",
   "the flagship X". Say what the thing does.

10. "the key insight", "the real fix", "the actual problem", "the root
    cause is one design mistake rather than three bugs". Describe the
    problem. The reader decides what is key.

11. "genuinely", "honestly", "the honest answer", "to be fair",
    "frankly". Delete the word. The sentence means the same thing.

12. "worth noting", "it is worth stating plainly", "note that". Delete
    the phrase and keep the fact.

13. "You're absolutely right", "Great question", "Fair question".
    Answer the question.

14. "essentially", "basically", "simply", "just", "fundamentally",
    "structurally". Delete.

15. Negative-list prohibitions as rhythm: "No checklist, no summary
    line, no praise."

    Good: "Omit checklists, summary lines, and praise for correct code."

16. Shouting with capitals for emphasis: "ONLY", "NEVER", "ALL".
    Emphasis is a plain word in a short sentence.

17. Naming a scheme cleverly, or writing about code as if it were a
    person: "the reject arm has the last word". See
    general-writing-tips.md rule 10.

## How to use this list

Write the draft. Then read it once looking for nothing but these
patterns. Most of them cluster at the ends of paragraphs and in the
first sentence of a reply, where the urge to be interesting is
strongest. Cut them there first.

Sources: a catalog of Claude clichés at
https://www.linkandth.ink/p/catalog-of-claude-cliches, and
https://agentplix.com/posts/how-to-stop-claude-from-writing-it-s-not-its/,
plus the phrases the owner of this repository has flagged in review.

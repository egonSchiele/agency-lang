Context: a rubric an LLM judge applies. Plain directives beat charm.

- "A match arm can carry a condition, as the `std::write` arm does." writes about the code as if it were a person doing something, and "as the ... arm does" is a roundabout way to point at an example. Say what the reader can do and point them at the example: "you can set guards on match arms. See the `"std::write"` arm for an example."
- "Three things, each worth a third." is a clever name for the scoring scheme. Say it plainly: "All three points count equally towards the final score."
- "Say what happens when..." is a stock phrase that hides what is actually required. State the requirement.
- "The reject arm has the last word: anything the earlier arms let through, it turns away." is a metaphor where a fact was needed: the `_` arm rejects every other effect.

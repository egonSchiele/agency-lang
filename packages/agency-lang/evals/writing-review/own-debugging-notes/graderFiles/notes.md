Context: a developer doc read by someone changing this code later. The audience is not the author today.

- "Before it, the nodes used `with reject`, which also rejected the docs-tool reads: the coding agent asked for `handlers.md`, got "interrupt rejected", and invented a handler syntax from memory." is the story of how the author found the bug. A future maintainer does not need it; git history has it. Cut.
- "Reads and greps of the working directory are still rejected." is a note the author left for a follow-up decision, not a fact about the design. Cut, or file it as an issue.
- What remains is one sentence of fact: which handler, where it lives, what it approves, what it rejects. That is the whole paragraph.

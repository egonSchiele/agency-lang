Context: this is a rubric an LLM judge reads. The reviewer should judge the shape of the text, not only its sentences.

- The paragraph mixes four kinds of content: what correct code looks like, an explanation of the parts, the list of things to check, and how to score. A reader has to untangle which sentence is which. They belong in separate parts: an example, one or two sentences explaining it, a numbered checklist, one sentence on scoring.
- Code is described in words with fragments squeezed inside sentences ("Handlers use the real syntax: `handle { ... } with (data) { ... }`, the outer handle block wraps the inner one, and each handler returns its verdict..."). Show the handler as a code block and describe it after.
- The last four sentences ("Code that is not valid Agency scores 0...", "Not valid means...", "A missing raises clause...") are patches the author added after watching the judge misbehave. They are the author's debugging, not instructions a reader needs. Cut them.

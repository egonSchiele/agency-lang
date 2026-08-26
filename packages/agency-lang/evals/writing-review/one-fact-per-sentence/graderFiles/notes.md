Context: an assignment an LLM coding agent must follow exactly.

- "Second, `runArchive(count: number): string`: it calls archiveNotes inside an inner handler that approves `notes::archive`, and that inner handler sits inside an outer handler that rejects `notes::archive` when the count is greater than 10 and otherwise expresses no opinion." carries five facts: where archiveNotes is called, what the inner handler does, the nesting, the outer handler's reject condition, its default. Split into one sentence per fact.
- The first function's sentence joins two requirements with a semicolon ("...carrying `count` in the interrupt's data; if the interrupt is approved it returns..."). Two sentences.
- The parenthetical at the end "(both handlers run; the inner approves and the outer rejects; a reject anywhere in the chain wins)" gives away the answer the doc comment is supposed to test, and hides three facts in brackets. Cut it.
- "expresses no opinion" is a roundabout way of saying the handler passes. Use the language's word: "passes on it".

Context: a rubric for an LLM judge. The subject is code syntax.

- The whole text describes syntax in prose, with code fragments inside parentheses inside sentences. One code block showing the handler, with the guarded arm in it, would say all of it at once. Put the example first. Then each item in the checklist can refer to it with "as shown above".
- The four checks are not numbered, so the reader has to work out which sentences are "the four" that "full marks need". Number them.
- "(`return reject()` is fine)" and "an if-chain on the effect name scores 0" are answers to judge behaviour the author saw, not part of the standard. Cut.

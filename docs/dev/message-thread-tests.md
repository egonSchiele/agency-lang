- There are a lot of cases to test with message threads, so this doc keeps a list of all the cases and where the tests for those cases are.
- Create a message thread with two messages: tests/agency/threads/simple.agency
- Assign a variable to a message thread: tests/agency/threads/messages.agency
- Message thread with sub-threads: tests/agency/threads/subthreads.agency
- message thread with nested threads: tests/agency/threads/nested-threads.agency
- message thread with mixed nested threads and subthreads: tests/agency/threads/nested-threads-and-subthreads.agency
- Message threads nested more than two levels deep: tests/agency/threads/thread-three-levels-deep.agency

- message thread with nested function calls: tests/agency/threads/nested-function-calls/nested-three-levels-deep.agency
- the same function being called inside and outside a message thread: tests/agency/threads/nested-function-calls/inside-and-outside.agency
- threads and subthreads inside functions

- Subthreads that are not nested inside of a thread should raise an error with the typechecker.
- Another thought: what about tools? What if a func that assumed it will be threaded is called as a tool?
- If I do want to transfer message history to another node, how would I do that?

- We also need to test messages being returned from an agent to JavaScript
- messages being returned from a function to a node
- A JavaScript file calling an agent with message history
- making an LLM call with message history
- making an LLM call inside a subthread with message history
- Making an LLM call inside a thread with message history
- Making an LLM call inside a thread with message history with the LLM call not being the first call.

- func calls assigned to a var
- built-in function calls
- built-in function calls assigned to a var

- parallel block: tests/agency/threads/parallel.agency
- parallel block with async function calls inside
- nested parallel blocks: tests/agency/threads/nested-parallel.agency
- no thread -- just making sure that if there is no thread, things run async as normal

- do funcs specifically marked sync/async create threads? What about func calls that are awaited?
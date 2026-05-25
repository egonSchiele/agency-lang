# Dry-Run Execution

## The Idea

Execute an Agency program with mocked/sandboxed tools that log what *would* happen without actually doing it. Produce a trace that the user (or parent agent) can review before approving real execution.

## Why It Matters

Static analysis tells you what code *could* do. Dry-run execution tells you what it *will* do for a specific input. It's the middle ground between "trust the code and run it" and "analyze every possible path":

- Agent generates code to reorganize files
- Dry-run shows: "would read /data/input.csv, would call LLM with prompt X, would write /data/output.csv, would delete /data/input.csv"
- User reviews the trace and approves or rejects

This is especially valuable for agent-generated code because the user can see the concrete plan of action. It's like a "what-if" mode.

Agency already has traces and the debugger, so the infrastructure for recording and inspecting execution is partially in place.

## How It Would Work

1. Compile the Agency program normally
2. Execute with a special runtime mode where:
   - All stdlib functions with side effects (fs, shell, http, etc.) are replaced with mocks
   - Mocks log the call and its arguments but don't perform the action
   - Mocks return configurable fake data (default values, user-provided fixtures, or LLM-generated plausible responses)
   - LLM calls can be real (to see the actual plan unfold) or mocked (for speed)
3. Produce a trace of all operations that would have been performed
4. Present trace to user for review
5. If approved, re-execute with real tools (possibly using checkpointing to skip already-computed steps)

## Key Questions

- **Mock fidelity**: How realistic do mocks need to be? If `readFile()` is mocked, what does it return? Options:
  - Default empty values (empty string, empty array)
  - User-provided fixture data
  - Actually read the file but don't write (read-only mode rather than full mock)
  - LLM-generated plausible data
- **LLM calls in dry-run**: Real or mocked? Real gives an accurate preview but costs money. Mocked is free but the plan might diverge from real execution.
- **Branching**: If a dry-run takes one branch, the user only sees that path. How do we communicate that other paths exist? Combine with symbolic execution for completeness?
- **Trace format**: Reuse existing trace infrastructure? Or a purpose-built "plan preview" format that's more human-readable?
- **Approval UX**: How does the user review and approve? Print to console? Open in debugger? A structured diff?
- **Re-execution efficiency**: After approval, can we avoid re-doing work? E.g., keep LLM responses from the dry-run and replay them during real execution?
- **Partial dry-run**: Can you dry-run just the dangerous parts? E.g., let reads happen for real but mock writes?

## Complexity Considerations

- Mock infrastructure needs to cover all side-effecting stdlib functions
- The gap between dry-run and real execution (mock data vs real data causing different branches) needs to be clearly communicated
- Integration with existing trace/debugger infrastructure should be straightforward but needs design work
- "Read-only mode" (real reads, mocked writes) might be the best default — gives realistic data flow while preventing damage

## Dependencies

- Existing trace infrastructure (partially built)
- Existing debugger (for trace inspection)
- Mock/sandbox versions of stdlib functions
- Subprocess IPC (dry-run is most valuable for agent-generated code in subprocesses)

## Related Ideas

- Subprocess IPC (dry-run the generated code before real execution)
- Symbolic execution (dry-run is concrete single-path; symbolic is abstract all-paths)
- Policy checking (dry-run can verify policy compliance empirically)
- Traces and bundles (existing infrastructure to build on)

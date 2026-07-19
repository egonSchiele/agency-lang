# Skills for the verifier

Each file in this directory is one skill: a short markdown document the verifier
reads on demand, when the task in front of it calls for that knowledge.

Skills exist so we can teach an agent something without making its system
prompt longer. A prompt is paid for on every call; a skill is read only when
the agent decides it is relevant.

Add a skill here when the agent repeatedly gets something wrong that a page
of instruction would fix, and the knowledge is too specific to justify space
in every prompt. Name the situation it applies to in the first line, so the
agent can tell from the listing whether to open it.

Do not add a skill for something a capable model already knows. A skill that
restates general good practice costs context and teaches nothing.

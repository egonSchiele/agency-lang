## The formatted grader

Every test in `evals/agency-coding` carries a grader named `formatted`. It reads the file the writer saved and runs the Agency formatter on it. The grader passes only when the formatter would leave the file unchanged. A missing file fails, and so does a file that does not parse.

The grader has a weight of 0.2. The other graders for a test keep their weights, so formatting is a small share of the score.

The writer has the stdlib `format` tool for this. Its prompt tells it to format the draft after the draft typechecks and to return the formatted text.

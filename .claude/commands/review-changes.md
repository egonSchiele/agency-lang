Review the current changes in this branch for violations of the project's coding standards and anti-patterns.

1. Run `git diff main` to get the full diff of changes in this branch.
2. Read `packages/agency-lang/docs/dev/anti-patterns.md` — the anti-pattern catalog.
3. Read `packages/agency-lang/docs/dev/coding-standards.md` — the coding standards.
4. Review the diff against both documents. For each violation found, report:
   - Which anti-pattern or coding standard was violated
   - The file and approximate line number
   - A specific suggested fix
5. Focus ONLY on patterns documented in those two files. Do not invent new rules.
6. Do not flag things that are clearly intentional or necessary for the context.
7. If no violations are found, report that the changes look clean.

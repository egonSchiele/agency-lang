Fixture projects for `scripts/lint-run-reads.test.ts`.

`project/` has code the check must report (`lib/reported.ts`) and code it must leave alone (`lib/allowed.ts`). A line the check must report ends with `// expect: reported`.

`no-readers/` has no reader functions, which the check must refuse to pass.

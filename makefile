.PHONY: all test stdlib

all:
	pnpm run templates && pnpm run build && $(MAKE) stdlib && $(MAKE) doc

stdlib:
	pnpm exec tsc -p tsconfig.stdlib.json

test:
	pnpm run test

publish:
	npm publish

fixtures:
	pnpm run templates && pnpm run build
	node dist/scripts/regenerate-fixtures.js

doc:
	rm -rf docs-new/stdlib/ && pnpm run agency doc stdlib -o docs-new/stdlib/

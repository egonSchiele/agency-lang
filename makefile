.PHONY: all test stdlib

all:
	pnpm run templates && pnpm run build && $(MAKE) stdlib

stdlib:
	pnpm exec tsc -p tsconfig.stdlib.json

test:
	pnpm run test

publish:
	npm publish

fixtures:
	pnpm run templates && pnpm run build
	node dist/scripts/regenerate-fixtures.js
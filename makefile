.PHONY: all test

all:
	pnpm run templates && pnpm run build

test:
	pnpm run test

publish:
	npm publish

fixtures:
	pnpm run templates && pnpm run build
	node dist/scripts/regenerate-fixtures.js
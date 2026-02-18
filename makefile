.PHONY: all test

all:
	# pnpm run templates && pnpm run build && pnpm run start tests/function.agency
	# pnpm run templates && pnpm run build && pnpm run start tests/assignment.agency
	pnpm run templates && pnpm run build

test:
	pnpm run test

publish:
	npm publish

fixtures:
	pnpm run templates && pnpm run build
	node dist/scripts/regenerate-fixtures.js
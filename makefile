.PHONY: all test graphtest

all:
	# pnpm run templates && pnpm run build && pnpm run start tests/function.agency
	# pnpm run templates && pnpm run build && pnpm run start tests/assignment.agency
	pnpm run templates && pnpm run build

test:
	pnpm run test
	
graphtest:
	node dist/scripts/generateGraph.js foo.agency > foo.mts
	STATELOG_HOST=http://localhost:1065 node foo.mts

publish:
	npm publish

fixtures:
	node dist/scripts/regenerate-fixtures.js
	node dist/scripts/regenerate-graph-fixtures.js
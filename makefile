.PHONY: all test graphtest

all:
	# pnpm run templates && pnpm run build && pnpm run start tests/function.adl
	# pnpm run templates && pnpm run build && pnpm run start tests/assignment.adl
	pnpm run templates && pnpm run build

test:
	DEBUG=1 node dist/scripts/generateGraph.js foo.adl
	
graphtest:
	node dist/scripts/generateGraph.js foo.adl > foo.mts
	STATELOG_HOST=http://localhost:1065 node foo.mts
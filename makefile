all:
	# pnpm run templates && pnpm run build && pnpm run start tests/function.adl
	# pnpm run templates && pnpm run build && pnpm run start tests/assignment.adl
	pnpm run templates && pnpm run build

graphtest:
	node dist/scripts/generateGraph.js index.adl > foo.mts
	node foo.mts
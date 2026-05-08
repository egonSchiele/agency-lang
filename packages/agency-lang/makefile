.PHONY: all test stdlib doc packages-doc

all:
	pnpm run templates && pnpm run build && $(MAKE) stdlib && $(MAKE) doc

stdlib:
	pnpm run agency compile stdlib/ && \
	pnpm exec tsc -p tsconfig.stdlib.json

test:
	pnpm run test

publish:
	pnpm publish --no-git-checks

fixtures:
	pnpm run templates && pnpm run build
	node dist/scripts/regenerate-fixtures.js

doc:
	rm -rf docs-new/stdlib/ && pnpm run agency doc stdlib -o docs-new/stdlib/

packages-doc:
	rm -rf docs-new/packages/
	pnpm run agency doc ../brave-search -o docs-new/packages/brave-search/ --ignore tests --base-url https://github.com/egonSchiele/agency-lang/blob/main/packages/brave-search/
	pnpm run agency doc ../web-fetch -o docs-new/packages/web-fetch/ --ignore tests --base-url https://github.com/egonSchiele/agency-lang/blob/main/packages/web-fetch/
	pnpm run agency doc ../mcp -o docs-new/packages/mcp/ --ignore tests --base-url https://github.com/egonSchiele/agency-lang/blob/main/packages/mcp/

test-log:
	rm -f test-output
	pnpm run test:agency | tee test-output
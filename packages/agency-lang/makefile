.PHONY: all test stdlib agents doc packages-doc

all:
	pnpm run templates && pnpm run build && $(MAKE) stdlib && $(MAKE) agents && $(MAKE) doc

stdlib:
	pnpm run agency compile stdlib/

agents:
	pnpm run agency compile dist/lib/agents/review/ && \
	pnpm run agency compile dist/lib/agents/judge.agency

test:
	pnpm run test

publish:
	pnpm publish --no-git-checks

fixtures:
	pnpm run templates && pnpm run build
	node dist/scripts/regenerate-fixtures.js

doc:
	rm -rf docs/site/stdlib/ && pnpm run agency doc stdlib -o docs/site/stdlib/

packages-doc:
	rm -rf docs/site/packages/
	pnpm run agency doc ../brave-search -o docs/site/packages/brave-search/ --ignore tests --base-url https://github.com/egonSchiele/agency-lang/blob/main/packages/brave-search/
	pnpm run agency doc ../web-fetch -o docs/site/packages/web-fetch/ --ignore tests --base-url https://github.com/egonSchiele/agency-lang/blob/main/packages/web-fetch/
	pnpm run agency doc ../mcp -o docs/site/packages/mcp/ --ignore tests --base-url https://github.com/egonSchiele/agency-lang/blob/main/packages/mcp/
	pnpm run agency doc ../email -o docs/site/packages/email/ --ignore tests --base-url https://github.com/egonSchiele/agency-lang/blob/main/packages/email/
	pnpm run agency doc ../github -o docs/site/packages/github/ --ignore tests --base-url https://github.com/egonSchiele/agency-lang/blob/main/packages/github/

test-log:
	rm -f test-output
	pnpm run test:agency | tee test-output

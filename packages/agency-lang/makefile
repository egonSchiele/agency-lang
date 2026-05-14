.PHONY: all test stdlib agents doc packages-doc refresh-action-pins

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

# Print the current SHAs for the actions used by `agency schedule add --backend github`.
# Manually paste into lib/cli/schedule/backends/pinnedActions.ts.
#
# IMPORTANT: the tags below MUST stay in sync with the `tag:` values in
# pinnedActions.ts. They reference *exact* tags (not moving major-version
# aliases like `v4` or `v1`) so that the SHA we print is for the same
# version the workflow file says it pins. To bump a version, edit both
# this list and pinnedActions.ts in the same commit.
refresh-action-pins:
	@echo "Look up these SHAs and update lib/cli/schedule/backends/pinnedActions.ts by hand:"
	@for spec in actions/checkout@v4.1.7 egonSchiele/run-agency-action@v1.0.2; do \
	  repo=$${spec%@*}; tag=$${spec#*@}; \
	  ref_obj=$$(gh api repos/$$repo/git/ref/tags/$$tag --jq '.object'); \
	  type=$$(echo "$$ref_obj" | jq -r '.type'); \
	  sha=$$(echo "$$ref_obj" | jq -r '.sha'); \
	  if [ "$$type" = "tag" ]; then \
	    sha=$$(gh api repos/$$repo/git/tags/$$sha --jq '.object.sha'); \
	  fi; \
	  printf "  %-40s %s  # %s\n" "$$repo" "$$sha" "$$tag"; \
	done

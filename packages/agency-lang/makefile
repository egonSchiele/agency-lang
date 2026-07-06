.PHONY: all test stdlib agents doc packages-doc refresh-action-pins build

all:
	pnpm run templates && pnpm run build && $(MAKE) stdlib && $(MAKE) agents && $(MAKE) doc

# Build the dist/ tree. Invoked by `pnpm run build`. Kept here (rather
# than as a chain in package.json) so the steps remain readable and easy
# to extend without inflating the package.json scripts section.
build:
	rm -rf dist/
	tsc
	tsc-alias
	mkdir -p dist/lib/cli/runShim
	cp lib/cli/runShim/*.mjs dist/lib/cli/runShim/
	mkdir -p dist/lib/stdlib/providers
	cp lib/stdlib/providers/*.mjs dist/lib/stdlib/providers/
	mkdir -p dist/lib/agents/docs
	cp -r docs/site/guide dist/lib/agents/docs/guide
	cp -r docs/site/cli dist/lib/agents/docs/cli

stdlib:
	pnpm run agency compile stdlib/

agents:
	cp -r lib/agents dist/lib && \
	pnpm run agency compile dist/lib/agents/review/ && \
	pnpm run agency compile dist/lib/agents/policy/ && \
	pnpm run agency compile dist/lib/agents/agency-agent/ && \
	pnpm run agency compile dist/lib/agents/eval/ && \
	pnpm run agency compile dist/lib/agents/optimize/ && \
	mkdir -p dist/lib/agents/docs
	cp -r docs/site/guide dist/lib/agents/docs/guide
	cp -r docs/site/cli dist/lib/agents/docs/cli

test:
	pnpm run test

publish:
	pnpm publish --no-git-checks

fixtures:
	pnpm run templates && pnpm run build
	node dist/scripts/regenerate-fixtures.js

doc:
	rm -rf docs/site/stdlib/ && pnpm run agency doc stdlib -o docs/site/stdlib/

# Documentable packages: each has an index.agency that `agency doc` reads.
# (brave-search / tui / examples have no library source, so they're skipped.)
DOC_PACKAGES = web-fetch mcp email github whisper-local

packages-doc:
	@for pkg in $(DOC_PACKAGES); do \
	  echo "Generating docs for $$pkg..."; \
	  rm -rf docs/site/packages/$$pkg/; \
	  pnpm run agency doc ../$$pkg -o docs/site/packages/$$pkg/ --ignore tests --base-url https://github.com/egonSchiele/agency-lang/blob/main/packages/$$pkg/ || exit 1; \
	done

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

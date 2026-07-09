.PHONY: all test stdlib agents doc packages-doc refresh-action-pins build clean publish compile-agency

# Resolve tsc/tsc-alias from the workspace, not from whatever happens to
# be global. Historically `make build` was only ever reached via
# `pnpm run build`, which put node_modules/.bin on PATH; `all` now invokes
# it directly ($(MAKE) build), so the Makefile must point at the tools
# itself. Explicit paths (not a PATH export) because Apple's GNU make 3.81
# does not reliably apply an exported PATH to its exec fast path. Also
# pins tool versions to the repo lockfile.
TSC := ./node_modules/.bin/tsc
TSC_ALIAS := ./node_modules/.bin/tsc-alias

# The bundled agent dirs. Adding an agent = add it here, nowhere else.
AGENT_DIRS := review policy agency-agent eval optimize
AGENT_PATHS := $(addprefix dist/lib/agents/,$(AGENT_DIRS))

# Sync-style staging (scripts/stage-agents.mjs): copies sources over,
# deletes orphans (a removed foo.agency takes its foo.js), and never
# deletes a compiled output whose source survives — the old rm -rf
# recipe wiped every compiled agent .js and made incremental agent
# skips impossible.
define stage-agent-sources
	node ./scripts/stage-agents.mjs lib/agents dist/lib/agents
endef

# Stage the doc markdown the agents read at runtime. rm before cp -r:
# copying onto an existing dir NESTS (guide/guide) — that artifact exists
# in pre-Stage-C tarballs; these copies must be idempotent.
define stage-agent-docs
	mkdir -p dist/lib/agents/docs
	rm -rf dist/lib/agents/docs/guide dist/lib/agents/docs/cli
	cp -r docs/site/guide dist/lib/agents/docs/guide
	cp -r docs/site/cli dist/lib/agents/docs/cli
endef

all:
	pnpm run templates && $(MAKE) build && $(MAKE) compile-agency && $(MAKE) doc

# Build the dist/ tree. Invoked by `pnpm run build`. Kept here (rather
# than as a chain in package.json) so the steps remain readable and easy
# to extend without inflating the package.json scripts section.
#
# Incremental: dist/ is NOT wiped here (use `make clean` for a full
# reset; publish always goes through clean). Because the buildinfo lives
# OUTSIDE dist/ (it must not ship in the tarball), dist and its
# incremental state no longer share a lifetime: if dist/ was deleted by
# hand but the buildinfo survived, tsc would consider everything
# up-to-date, emit nothing, and leave an empty dist. The recipe's first
# line drops the stale buildinfo in that case. It keys on dist/lib as a
# heuristic for "dist meaningfully exists" — a PARTIAL hand-deletion that
# leaves dist/lib (e.g. rm -rf dist/scripts) is not covered; `make clean`
# is the recovery for any surgically damaged dist.
#
# The .mjs copies are wipe-then-copy so an .mjs deleted from lib/ cannot
# linger (and later ship) in dist. The wipe targets *.mjs ONLY: these
# dist dirs also hold tsc-emitted .js/.d.ts, which incremental tsc would
# NOT re-emit if deleted behind its back.
build:
	@if [ ! -d dist/lib ]; then rm -f .agency-build/tsc.tsbuildinfo; fi
	$(TSC)
	$(TSC_ALIAS)
	mkdir -p dist/lib/cli/runShim
	rm -f dist/lib/cli/runShim/*.mjs
	cp lib/cli/runShim/*.mjs dist/lib/cli/runShim/
	mkdir -p dist/lib/stdlib/providers
	rm -f dist/lib/stdlib/providers/*.mjs
	cp lib/stdlib/providers/*.mjs dist/lib/stdlib/providers/

# Full reset: compiled TS, incremental scratch state, and the gitignored
# stdlib .js siblings. Both dist/ AND stdlib/**/*.js ship in the npm
# tarball, so publish MUST come through here to guarantee no orphaned
# output (from a deleted/renamed source) can ship. Safe: stdlib contains
# no .ts and no tracked/.mjs .js — every stdlib .js is agency-generated.
clean:
	rm -rf dist/ .agency-build/
	find stdlib -name '*.js' -type f -delete

# ONE compiler process for stdlib + all agent dirs: node boot and the
# compiler import are paid once, and the process-wide parse cache means
# the stdlib prelude (imported by every one of the 94 files) is parsed
# once instead of once per invocation. This is the load-bearing lever for
# the Stage C warm-make target.
compile-agency:
	$(stage-agent-sources)
	node ./dist/scripts/agency.js compile stdlib/ $(AGENT_PATHS)
	$(stage-agent-docs)

# Selective-use aliases (same recipes, one root set each).
stdlib:
	node ./dist/scripts/agency.js compile stdlib/

agents:
	$(stage-agent-sources)
	node ./dist/scripts/agency.js compile $(AGENT_PATHS)
	$(stage-agent-docs)

test:
	pnpm run test

# Publish = clean rebuild, no tests (CI gates merges; publishing is not a
# test run — deliberate). Note `make all` regenerates docs/site/stdlib/,
# so publish can leave tracked doc files modified in the working tree.
publish:
	$(MAKE) clean
	$(MAKE) all
	pnpm publish --no-git-checks

fixtures:
	pnpm run templates && pnpm run build
	node dist/scripts/regenerate-fixtures.js

# Regenerate stdlib docs only when stdlib content OR the compiler (which
# includes the doc generator) changed. `make clean` wipes .agency-build
# and forces regeneration.
doc:
	@STAMP=$$(node ./scripts/stdlib-stamp.mjs); \
	if [ -f .agency-build/doc.stamp ] && [ "$$(cat .agency-build/doc.stamp)" = "$$STAMP" ]; then \
	  echo "stdlib docs up to date"; \
	else \
	  rm -rf docs/site/stdlib/ && node ./dist/scripts/agency.js doc stdlib -o docs/site/stdlib/ && \
	  mkdir -p .agency-build && echo "$$STAMP" > .agency-build/doc.stamp; \
	fi

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

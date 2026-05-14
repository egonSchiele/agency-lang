.PHONY: all build clean publish

all: build

# Default `make` target only builds TypeScript so it stays usable in CI and
# environments without cmake / a C++ toolchain. To compile the native addon,
# use `pnpm run build:native` or `pnpm run build` (TS + native), or run
# `npx agency-whisper build` as documented for end users.
build:
	pnpm run build:ts

clean:
	rm -rf build dist

publish:
	pnpm publish --access public --no-git-checks

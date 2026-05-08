PACKAGES := $(wildcard packages/*)

.PHONY: all $(PACKAGES)

all: $(PACKAGES)

packages/agency-lang: packages/tui

$(PACKAGES):
	@if [ -f $@/makefile ] || [ -f $@/Makefile ]; then $(MAKE) -C $@; fi

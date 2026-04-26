PACKAGES := $(wildcard packages/*)

.PHONY: all $(PACKAGES)

all: $(PACKAGES)

$(PACKAGES):
	@if [ -f $@/makefile ] || [ -f $@/Makefile ]; then $(MAKE) -C $@; fi

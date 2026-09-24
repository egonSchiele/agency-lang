AGENCY_LANG := packages/agency-lang
# The other packages compile their Agency code with agency-lang's compiler,
# so they build after it. None depends on another, so they build in
# parallel.
SIBLINGS := $(filter-out $(AGENCY_LANG),$(wildcard packages/*))

.PHONY: all ci siblings $(SIBLINGS)

all:
	$(MAKE) -C $(AGENCY_LANG)
	$(MAKE) -j siblings

# The build CI test jobs use; see `ci` in packages/agency-lang/makefile.
ci:
	$(MAKE) -C $(AGENCY_LANG) ci
	$(MAKE) -j siblings

siblings: $(SIBLINGS)

$(SIBLINGS):
	@if [ -f $@/makefile ] || [ -f $@/Makefile ]; then $(MAKE) -C $@; fi

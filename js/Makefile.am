NULL =
BUILT_SOURCES =

misc/config.js: misc/config.js.in Makefile
	[ -d $(@D) ] || $(mkdir_p) $(@D) ; \
	sed -e "s|[@]PACKAGE_NAME@|$(PACKAGE_NAME)|g" \
	    -e "s|[@]PACKAGE_VERSION@|$(PACKAGE_VERSION)|g" \
	    -e "s|[@]HAVE_BLUETOOTH@|$(HAVE_BLUETOOTH)|g" \
	    -e "s|[@]HAVE_NETWORKMANAGER@|$(HAVE_NETWORKMANAGER)|g" \
	    -e "s|[@]GETTEXT_PACKAGE@|$(GETTEXT_PACKAGE)|g" \
	    -e "s|[@]datadir@|$(datadir)|g" \
	    -e "s|[@]libexecdir@|$(libexecdir)|g" \
	    -e "s|[@]localstatedir@|$(localstatedir)|g" \
	    -e "s|[@]pkgdatadir@|$(pkgdatadir)|g" \
	    -e "s|[@]sysconfdir@|$(sysconfdir)|g" \
	    -e "s|[@]LIBMUTTER_API_VERSION@|$(LIBMUTTER_API_VERSION)|g" \
               $< > $@

js_resource_files = $(shell $(GLIB_COMPILE_RESOURCES) --sourcedir=$(srcdir) --sourcedir=$(builddir) --generate-dependencies $(srcdir)/js-resources.gresource.xml)
js-resources.h: js-resources.gresource.xml $(js_resource_files) misc/config.js
	$(AM_V_GEN) $(GLIB_COMPILE_RESOURCES) --target=$@ --sourcedir=$(srcdir) --sourcedir=$(builddir) --generate --c-name shell_js_resources $<
js-resources.c: js-resources.gresource.xml $(js_resource_files) misc/config.js
	$(AM_V_GEN) $(GLIB_COMPILE_RESOURCES) --target=$@ --sourcedir=$(srcdir) --sourcedir=$(builddir) --generate --c-name shell_js_resources $<

js_built_sources = js-resources.c js-resources.h

BUILT_SOURCES += $(js_built_sources)

all-local: $(js_built_sources)

js_resource_dist_files = $(filter-out misc/config.js, $(js_resource_files))

eoslaunchdir = $(pkgdatadir)
dist_eoslaunch_DATA = misc/eos-launch.js

EXTRA_DIST = \
	$(js_resource_dist_files) \
	js-resources.gresource.xml \
	misc/config.js.in \
	misc/eos-launch.js \
	$(NULL)

CLEANFILES = \
	$(js_built_sources) \
	$(NULL)

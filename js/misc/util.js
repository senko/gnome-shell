// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gettext = imports.gettext;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Signals = imports.signals;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const Json = imports.gi.Json;
const Main = imports.ui.main;
const Tweener = imports.ui.tweener;
const Params = imports.misc.params;

const SCROLL_TIME = 0.1;

const FALLBACK_BROWSER_ID = 'chromium-browser.desktop';
const GOOGLE_CHROME_ID = 'google-chrome.desktop';

// http://daringfireball.net/2010/07/improved_regex_for_matching_urls
const _balancedParens = '\\((?:[^\\s()<>]+|(?:\\(?:[^\\s()<>]+\\)))*\\)';
const _leadingJunk = '[\\s`(\\[{\'\\"<\u00AB\u201C\u2018]';
const _notTrailingJunk = '[^\\s`!()\\[\\]{};:\'\\".,<>?\u00AB\u00BB\u201C\u201D\u2018\u2019]';

const _urlRegexp = new RegExp(
    '(^|' + _leadingJunk + ')' +
    '(' +
        '(?:' +
            '(?:http|https|ftp)://' +             // scheme://
            '|' +
            'www\\d{0,3}[.]' +                    // www.
            '|' +
            '[a-z0-9.\\-]+[.][a-z]{2,4}/' +       // foo.xx/
        ')' +
        '(?:' +                                   // one or more:
            '[^\\s()<>]+' +                       // run of non-space non-()
            '|' +                                 // or
            _balancedParens +                     // balanced parens
        ')+' +
        '(?:' +                                   // end with:
            _balancedParens +                     // balanced parens
            '|' +                                 // or
            _notTrailingJunk +                    // last non-junk char
        ')' +
    ')', 'gi');

let _desktopSettings = null;

// findUrls:
// @str: string to find URLs in
//
// Searches @str for URLs and returns an array of objects with %url
// properties showing the matched URL string, and %pos properties indicating
// the position within @str where the URL was found.
//
// Return value: the list of match objects, as described above
function findUrls(str) {
    let res = [], match;
    while ((match = _urlRegexp.exec(str)))
        res.push({ url: match[2], pos: match.index + match[1].length });
    return res;
}

// http://stackoverflow.com/questions/4691070/validate-url-without-www-or-http
const _searchUrlRegexp = new RegExp(
    '^([a-zA-Z0-9]+(\.[a-zA-Z0-9]+)+.*)\\.+[A-Za-z0-9\.\/%&=\?\-_]+$',
    'gi');

const supportedSearchSchemes = [ 'http', 'https', 'ftp' ];

// findSearchUrls:
// @terms: list of searchbar terms to find URLs in
// @maxLength: maximum number of characters in each non-URI term to match against, defaults
//             to 32 characters to prevent hogging the CPU with too long generic strings.
//
// Similar to "findUrls", but adapted for use only with terms from the searchbar.
//
// In order not to be too CPU-expensive, this function is implemented in the following way:
//   1. If the term is a valid URI in that it's possible to parse at least
//      its scheme and host fields, it's considered a valid URL "as-is".
//   2. Else, if the term is a generic string exceeding the maximum length
//      specified then we simply ignore it and move onto the next term.
//   3. In any other case (non-URI term, valid length) we match the term
//      passed against the regular expression to determine if it's a URL.
//
// Note that the regex for these URLs matches strings such as "google.com" (no need to the
// specify a preceding scheme), which is why we have to limit its execution to a certain
// maximum length, as the term can be pretty free-form. By default, this maximum length
// is 32 characters, which should be a good compromise considering that "many of the world's
// most visited web sites have domain names of between 6 - 10 characters" (see [1][2]).
//
// [1] https://www.domainregistration.com.au/news/2013/1301-domain-length.php
// [2] https://www.domainregistration.com.au/infocentre/info-domain-length.php
//
// Return value: the list of URLs found in the string
function findSearchUrls(terms, maxLength=32) {
    let res = [], match;
    for (let term of terms) {
        if (GLib.uri_parse_scheme(term)) {
            let supportedScheme = false;
            for (let scheme of supportedSearchSchemes) {
                if (term.startsWith(scheme + '://')) {
                    supportedScheme = true;
                    break;
                }
            }

            // Check that there's a valid host after the scheme part.
            if (supportedScheme && term.split('://')[1]) {
                res.push(term);
                continue
            }
        }

        // Try to save CPU cycles from regexp-matching too long strings.
        if ((term.length > maxLength))
            continue;

        while ((match = _searchUrlRegexp.exec(term)))
            res.push(match[0]);
    }
    return res;
}

// spawn:
// @argv: an argv array
//
// Runs @argv in the background, handling any errors that occur
// when trying to start the program.
function spawn(argv) {
    try {
        trySpawn(argv);
    } catch (err) {
        _handleSpawnError(argv[0], err);
    }
}

// spawnCommandLine:
// @command_line: a command line
//
// Runs @command_line in the background, handling any errors that
// occur when trying to parse or start the program.
function spawnCommandLine(command_line) {
    try {
        let [success, argv] = GLib.shell_parse_argv(command_line);
        trySpawn(argv);
    } catch (err) {
        _handleSpawnError(command_line, err);
    }
}

// spawnApp:
// @argv: an argv array
//
// Runs @argv as if it was an application, handling startup notification
function spawnApp(argv) {
    try {
        let app = Gio.AppInfo.create_from_commandline(argv.join(' '), null,
                                                      Gio.AppInfoCreateFlags.SUPPORTS_STARTUP_NOTIFICATION);

        let context = global.create_app_launch_context(0, -1);
        app.launch([], context, false);
    } catch(err) {
        _handleSpawnError(argv[0], err);
    }
}

// trySpawn:
// @argv: an argv array
//
// Runs @argv in the background. If launching @argv fails,
// this will throw an error.
function trySpawn(argv)
{
    var success, pid;
    try {
        [success, pid] = GLib.spawn_async(null, argv, null,
                                          GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                                          null);
    } catch (err) {
        /* Rewrite the error in case of ENOENT */
        if (err.matches(GLib.SpawnError, GLib.SpawnError.NOENT)) {
            throw new GLib.SpawnError({ code: GLib.SpawnError.NOENT,
                                        message: _("Command not found") });
        } else if (err instanceof GLib.Error) {
            // The exception from gjs contains an error string like:
            //   Error invoking GLib.spawn_command_line_async: Failed to
            //   execute child process "foo" (No such file or directory)
            // We are only interested in the part in the parentheses. (And
            // we can't pattern match the text, since it gets localized.)
            let message = err.message.replace(/.*\((.+)\)/, '$1');
            throw new (err.constructor)({ code: err.code,
                                          message: message });
        } else {
            throw err;
        }
    }
    // Dummy child watch; we don't want to double-fork internally
    // because then we lose the parent-child relationship, which
    // can break polkit.  See https://bugzilla.redhat.com//show_bug.cgi?id=819275
    GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, function () {});
}

// trySpawnCommandLine:
// @command_line: a command line
//
// Runs @command_line in the background. If launching @command_line
// fails, this will throw an error.
function trySpawnCommandLine(command_line) {
    let success, argv;

    try {
        [success, argv] = GLib.shell_parse_argv(command_line);
    } catch (err) {
        // Replace "Error invoking GLib.shell_parse_argv: " with
        // something nicer
        err.message = err.message.replace(/[^:]*: /, _("Could not parse command:") + "\n");
        throw err;
    }

    trySpawn(argv);
}

function _handleSpawnError(command, err) {
    let title = _("Execution of “%s” failed:").format(command);
    Main.notifyError(title, err.message);
}

function formatTimeSpan(date) {
    let now = GLib.DateTime.new_now_local();

    let timespan = now.difference(date);

    let minutesAgo = timespan / GLib.TIME_SPAN_MINUTE;
    let hoursAgo = timespan / GLib.TIME_SPAN_HOUR;
    let daysAgo = timespan / GLib.TIME_SPAN_DAY;
    let weeksAgo = daysAgo / 7;
    let monthsAgo = daysAgo / 30;
    let yearsAgo = weeksAgo / 52;

    if (minutesAgo < 5)
        return _("Just now");
    if (hoursAgo < 1)
        return Gettext.ngettext("%d minute ago",
                                "%d minutes ago", minutesAgo).format(minutesAgo);
    if (daysAgo < 1)
        return Gettext.ngettext("%d hour ago",
                                "%d hours ago", hoursAgo).format(hoursAgo);
    if (daysAgo < 2)
        return _("Yesterday");
    if (daysAgo < 15)
        return Gettext.ngettext("%d day ago",
                                "%d days ago", daysAgo).format(daysAgo);
    if (weeksAgo < 8)
        return Gettext.ngettext("%d week ago",
                                "%d weeks ago", weeksAgo).format(weeksAgo);
    if (yearsAgo < 1)
        return Gettext.ngettext("%d month ago",
                                "%d months ago", monthsAgo).format(monthsAgo);
    return Gettext.ngettext("%d year ago",
                            "%d years ago", yearsAgo).format(yearsAgo);
}

function formatTime(time, params) {
    let date;
    // HACK: The built-in Date type sucks at timezones, which we need for the
    //       world clock; it's often more convenient though, so allow either
    //       Date or GLib.DateTime as parameter
    if (time instanceof Date)
        date = GLib.DateTime.new_from_unix_local(time.getTime() / 1000);
    else
        date = time;

    let now = GLib.DateTime.new_now_local();

    let daysAgo = now.difference(date) / (24 * 60 * 60 * 1000 * 1000);

    let format;

    if (_desktopSettings == null)
        _desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    let clockFormat = _desktopSettings.get_string('clock-format');
    let hasAmPm = date.format('%p') != '';

    params = Params.parse(params, { timeOnly: false });

    if (clockFormat == '24h' || !hasAmPm) {
        // Show only the time if date is on today
        if (daysAgo < 1 || params.timeOnly)
            /* Translators: Time in 24h format */
            format = N_("%H\u2236%M");
        // Show the word "Yesterday" and time if date is on yesterday
        else if (daysAgo <2)
            /* Translators: this is the word "Yesterday" followed by a
             time string in 24h format. i.e. "Yesterday, 14:30" */
            // xgettext:no-c-format
            format = N_("Yesterday, %H\u2236%M");
        // Show a week day and time if date is in the last week
        else if (daysAgo < 7)
            /* Translators: this is the week day name followed by a time
             string in 24h format. i.e. "Monday, 14:30" */
            // xgettext:no-c-format
            format = N_("%A, %H\u2236%M");
        else if (date.get_year() == now.get_year())
            /* Translators: this is the month name and day number
             followed by a time string in 24h format.
             i.e. "May 25, 14:30" */
            // xgettext:no-c-format
            format = N_("%B %d, %H\u2236%M");
        else
            /* Translators: this is the month name, day number, year
             number followed by a time string in 24h format.
             i.e. "May 25 2012, 14:30" */
            // xgettext:no-c-format
            format = N_("%B %d %Y, %H\u2236%M");
    } else {
        // Show only the time if date is on today
        if (daysAgo < 1 || params.timeOnly)
            /* Translators: Time in 12h format */
            format = N_("%l\u2236%M %p");
        // Show the word "Yesterday" and time if date is on yesterday
        else if (daysAgo <2)
            /* Translators: this is the word "Yesterday" followed by a
             time string in 12h format. i.e. "Yesterday, 2:30 pm" */
            // xgettext:no-c-format
            format = N_("Yesterday, %l\u2236%M %p");
        // Show a week day and time if date is in the last week
        else if (daysAgo < 7)
            /* Translators: this is the week day name followed by a time
             string in 12h format. i.e. "Monday, 2:30 pm" */
            // xgettext:no-c-format
            format = N_("%A, %l\u2236%M %p");
        else if (date.get_year() == now.get_year())
            /* Translators: this is the month name and day number
             followed by a time string in 12h format.
             i.e. "May 25, 2:30 pm" */
            // xgettext:no-c-format
            format = N_("%B %d, %l\u2236%M %p");
        else
            /* Translators: this is the month name, day number, year
             number followed by a time string in 12h format.
             i.e. "May 25 2012, 2:30 pm"*/
            // xgettext:no-c-format
            format = N_("%B %d %Y, %l\u2236%M %p");
    }

    let formattedTime = date.format(Shell.util_translate_time_string(format));
    // prepend LTR-mark to colon/ratio to force a text direction on times
    return formattedTime.replace(/([:\u2236])/g, '\u200e$1');
}

function createTimeLabel(date, params) {
    if (_desktopSettings == null)
        _desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });

    let label = new St.Label({ text: formatTime(date, params) });
    let id = _desktopSettings.connect('changed::clock-format', function() {
        label.text = formatTime(date, params);
    });
    label.connect('destroy', function() {
        _desktopSettings.disconnect(id);
    });
    return label;
}

// lowerBound:
// @array: an array or array-like object, already sorted
//         according to @cmp
// @val: the value to add
// @cmp: a comparator (or undefined to compare as numbers)
//
// Returns the position of the first element that is not
// lower than @val, according to @cmp.
// That is, returns the first position at which it
// is possible to insert @val without violating the
// order.
// This is quite like an ordinary binary search, except
// that it doesn't stop at first element comparing equal.

function lowerBound(array, val, cmp) {
    let min, max, mid, v;
    cmp = cmp || function(a, b) { return a - b; };

    if (array.length == 0)
        return 0;

    min = 0; max = array.length;
    while (min < (max - 1)) {
        mid = Math.floor((min + max) / 2);
        v = cmp(array[mid], val);

        if (v < 0)
            min = mid + 1;
        else
            max = mid;
    }

    return (min == max || cmp(array[min], val) < 0) ? max : min;
}

// insertSorted:
// @array: an array sorted according to @cmp
// @val: a value to insert
// @cmp: the sorting function
//
// Inserts @val into @array, preserving the
// sorting invariants.
// Returns the position at which it was inserted
function insertSorted(array, val, cmp) {
    let pos = lowerBound(array, val, cmp);
    array.splice(pos, 0, val);

    return pos;
}

const CloseButton = new Lang.Class({
    Name: 'CloseButton',
    Extends: St.Button,

    _init: function(boxpointer) {
        this.parent({ style_class: 'notification-close'});

        // This is a bit tricky. St.Bin has its own x-align/y-align properties
        // that compete with Clutter's properties. This should be fixed for
        // Clutter 2.0. Since St.Bin doesn't define its own setters, the
        // setters are a workaround to get Clutter's version.
        this.set_x_align(Clutter.ActorAlign.END);
        this.set_y_align(Clutter.ActorAlign.START);

        // XXX Clutter 2.0 workaround: ClutterBinLayout needs expand
        // to respect the alignments.
        this.set_x_expand(true);
        this.set_y_expand(true);

        this._boxPointer = boxpointer;
        if (boxpointer)
            this._boxPointer.connect('arrow-side-changed', Lang.bind(this, this._sync));
    },

    _computeBoxPointerOffset: function() {
        if (!this._boxPointer || !this._boxPointer.actor.get_stage())
            return 0;

        let side = this._boxPointer.arrowSide;
        if (side == St.Side.TOP)
            return this._boxPointer.getArrowHeight();
        else
            return 0;
    },

    _sync: function() {
        let themeNode = this.get_theme_node();

        let offY = this._computeBoxPointerOffset();
        this.translation_x = themeNode.get_length('-shell-close-overlap-x')
        this.translation_y = themeNode.get_length('-shell-close-overlap-y') + offY;
    },

    vfunc_style_changed: function() {
        this._sync();
        this.parent();
    },
});

function makeCloseButton(boxpointer) {
    return new CloseButton(boxpointer);
}

function ensureActorVisibleInScrollView(scrollView, actor) {
    let adjustment = scrollView.vscroll.adjustment;
    let [value, lower, upper, stepIncrement, pageIncrement, pageSize] = adjustment.get_values();

    let offset = 0;
    let vfade = scrollView.get_effect("fade");
    if (vfade)
        offset = vfade.vfade_offset;

    let box = actor.get_allocation_box();
    let y1 = box.y1, y2 = box.y2;

    let parent = actor.get_parent();
    while (parent != scrollView) {
        if (!parent)
            throw new Error("actor not in scroll view");

        let box = parent.get_allocation_box();
        y1 += box.y1;
        y2 += box.y1;
        parent = parent.get_parent();
    }

    if (y1 < value + offset)
        value = Math.max(0, y1 - offset);
    else if (y2 > value + pageSize - offset)
        value = Math.min(upper, y2 + offset - pageSize);
    else
        return;

    Tweener.addTween(adjustment,
                     { value: value,
                       time: SCROLL_TIME,
                       transition: 'easeOutQuad' });
}

function getBrowserId() {
    let id = FALLBACK_BROWSER_ID;
    let app = Gio.app_info_get_default_for_type('x-scheme-handler/http', true);
    if (app != null)
        id = app.get_id();
    return id;
}

function getBrowserApp() {
    let id = getBrowserId();
    let appSystem = Shell.AppSystem.get_default();
    let browserApp = appSystem.lookup_app(id);
    return browserApp;
}

function blockClickEventsOnActor(actor) {
    actor.reactive = true;
    actor.connect('button-press-event', function (actor, event) {
        return true;
    });
    actor.connect('button-release-event', function (actor, event) {
        return true;
    });
}

function _getJsonSearchEngine(folder) {
    let path = GLib.build_filenamev([GLib.get_user_config_dir(), folder, 'Default', 'Preferences']);
    let parser = new Json.Parser();

    /*
     * Translators: this is the name of the search engine that shows in the
     * Shell's desktop search entry.
     */
    let defaultString = _("Google");

    try {
        parser.load_from_file(path);
    } catch (e if e.matches(GLib.FileError, GLib.FileError.NOENT)) {
        // No configuration file found for the browser
        return defaultString;
    } catch (e) {
        logError(e, 'error while parsing ' + path);
        return null;
    }

    let root = parser.get_root().get_object();

    let searchProviderDataNode = root.get_member('default_search_provider_data');
    if (!searchProviderDataNode || searchProviderDataNode.get_node_type() != Json.NodeType.OBJECT)
        return defaultString;

    let searchProviderData = searchProviderDataNode.get_object();
    if (!searchProviderData)
        return defaultString;

    let templateUrlDataNode = searchProviderData.get_member('template_url_data');
    if (!templateUrlDataNode || templateUrlDataNode.get_node_type() != Json.NodeType.OBJECT)
        return defaultString;

    let templateUrlData = templateUrlDataNode.get_object();
    if (!templateUrlData)
        return defaultString;

    let shortNameNode = templateUrlData.get_member('short_name');
    if (!shortNameNode || shortNameNode.get_node_type() != Json.NodeType.VALUE)
        return defaultString;

    return shortNameNode.get_string();
}

// getSearchEngineName:
//
// Retrieves the current search engine from
// the default browser.
function getSearchEngineName() {
    let browser = getBrowserId();

    if (browser === FALLBACK_BROWSER_ID)
        return _getJsonSearchEngine('chromium');

    if (browser === GOOGLE_CHROME_ID)
        return _getJsonSearchEngine('google-chrome');

    return null;
}

const AppSettingsMonitor = new Lang.Class({
    Name: 'AppSettingsMonitor',

    _init: function(appId, schemaId) {
        this._appId = appId;
        this._schemaId = schemaId;

        this._app = null;
        this._settings = null;
        this._handlers = [];

        this._schemaSource = Gio.SettingsSchemaSource.get_default();

        this._appSystem = Shell.AppSystem.get_default();
        this._appSystem.connect('installed-changed',
                                Lang.bind(this, this._onInstalledChanged));
        this._onInstalledChanged();
    },

    get available() {
        return this._app != null && this._settings != null;
    },

    activateApp: function() {
        if (this._app)
            this._app.activate();
    },

    watchSetting: function(key, callback) {
        let handler = { id: 0, key: key, callback: callback };
        this._handlers.push(handler);

        this._connectHandler(handler);
    },

    _connectHandler: function(handler) {
        if (!this._settings || handler.id > 0)
            return;

        handler.id = this._settings.connect('changed::' + handler.key,
                                            handler.callback);
        handler.callback(this._settings, handler.key);
    },

    _disconnectHandler: function(handler) {
        if (this._settings && handler.id > 0)
            this._settings.disconnect(handler.id);
        handler.id = 0;
    },

    _onInstalledChanged: function() {
        let hadApp = (this._app != null);
        this._app = this._appSystem.lookup_app(this._appId);
        let haveApp = (this._app != null);

        if (hadApp == haveApp)
            return;

        if (haveApp)
            this._checkSettings();
        else
            this._setSettings(null);
    },

    _setSettings: function(settings) {
        this._handlers.forEach((handler) => { this._disconnectHandler(handler); });

        let hadSettings = (this._settings != null);
        this._settings = settings;
        let haveSettings = (this._settings != null);

        this._handlers.forEach((handler) => { this._connectHandler(handler); });

        if (hadSettings != haveSettings)
            this.emit('available-changed');
    },

    _checkSettings: function() {
        let schema = this._schemaSource.lookup(this._schemaId, true);
        if (schema) {
            this._setSettings(new Gio.Settings({ settings_schema: schema }));
        } else if (this._app) {
            Mainloop.timeout_add_seconds(1, () => {
                this._checkSettings();
                return GLib.SOURCE_REMOVE;
            });
        }
    }
});
Signals.addSignalMethods(AppSettingsMonitor.prototype);

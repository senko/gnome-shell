// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Signals = imports.signals;

let IBusCandidatePopup;
try {
    var IBus = imports.gi.IBus;
    _checkIBusVersion(1, 5, 2);
    IBusCandidatePopup = imports.ui.ibusCandidatePopup;
} catch (e) {
    var IBus = null;
    log(e);
}

let _ibusManager = null;

function _checkIBusVersion(requiredMajor, requiredMinor, requiredMicro) {
    if ((IBus.MAJOR_VERSION > requiredMajor) ||
        (IBus.MAJOR_VERSION == requiredMajor && IBus.MINOR_VERSION > requiredMinor) ||
        (IBus.MAJOR_VERSION == requiredMajor && IBus.MINOR_VERSION == requiredMinor &&
         IBus.MICRO_VERSION >= requiredMicro))
        return;

    throw "Found IBus version %d.%d.%d but required is %d.%d.%d".
        format(IBus.MAJOR_VERSION, IBus.MINOR_VERSION, IBus.MINOR_VERSION,
               requiredMajor, requiredMinor, requiredMicro);
}

function getIBusManager() {
    if (_ibusManager == null)
        _ibusManager = new IBusManager();
    return _ibusManager;
}

const IBusManager = new Lang.Class({
    Name: 'IBusManager',

    // This is the longest we'll keep the keyboard frozen until an input
    // source is active.
    _MAX_INPUT_SOURCE_ACTIVATION_TIME: 4000, // ms
    _PRELOAD_ENGINES_DELAY_TIME: 30, // sec

    _init: function() {
        if (!IBus)
            return;

        IBus.init();

        this._candidatePopup = new IBusCandidatePopup.CandidatePopup();

        this._panelService = null;
        this._engines = {};
        this._ready = false;
        this._registerPropertiesId = 0;
        this._currentEngineName = null;
        this._preloadEnginesId = 0;

        this._ibus = IBus.Bus.new_async();
        this._ibus.connect('connected', Lang.bind(this, this._onConnected));
        this._ibus.connect('disconnected', Lang.bind(this, this._clear));
        // Need to set this to get 'global-engine-changed' emitions
        this._ibus.set_watch_ibus_signal(true);
        this._ibus.connect('global-engine-changed', Lang.bind(this, this._engineChanged));

        this._spawn();
    },

    _spawn: function() {
        try {
            Gio.Subprocess.new(['ibus-daemon', '--xim', '--panel', 'disable'],
                               Gio.SubprocessFlags.NONE);
        } catch(e) {
            log('Failed to launch ibus-daemon: ' + e.message);
        }
    },

    _clear: function() {
        if (this._panelService)
            this._panelService.destroy();

        this._panelService = null;
        this._candidatePopup.setPanelService(null);
        this._engines = {};
        this._ready = false;
        this._registerPropertiesId = 0;
        this._currentEngineName = null;

        this.emit('ready', false);

        this._spawn();
    },

    _onConnected: function() {
        this._ibus.list_engines_async(-1, null, Lang.bind(this, this._initEngines));
        this._ibus.request_name_async(IBus.SERVICE_PANEL,
                                      IBus.BusNameFlag.REPLACE_EXISTING,
                                      -1, null,
                                      Lang.bind(this, this._initPanelService));
    },

    _initEngines: function(ibus, result) {
        let enginesList = this._ibus.list_engines_async_finish(result);
        if (enginesList) {
            for (let i = 0; i < enginesList.length; ++i) {
                let name = enginesList[i].get_name();
                this._engines[name] = enginesList[i];
            }
            this._updateReadiness();
        } else {
            this._clear();
        }
    },

    _initPanelService: function(ibus, result) {
        let success = this._ibus.request_name_async_finish(result);
        if (success) {
            this._panelService = new IBus.PanelService({ connection: this._ibus.get_connection(),
                                                         object_path: IBus.PATH_PANEL });
            this._candidatePopup.setPanelService(this._panelService);
            this._panelService.connect('update-property', Lang.bind(this, this._updateProperty));
            try {
                // IBus versions older than 1.5.10 have a bug which
                // causes spurious set-content-type emissions when
                // switching input focus that temporarily lose purpose
                // and hints defeating its intended semantics and
                // confusing users. We thus don't use it in that case.
                _checkIBusVersion(1, 5, 10);
                this._panelService.connect('set-content-type', Lang.bind(this, this._setContentType));
            } catch (e) {
            }
            // If an engine is already active we need to get its properties
            this._ibus.get_global_engine_async(-1, null, Lang.bind(this, function(i, result) {
                let engine;
                try {
                    engine = this._ibus.get_global_engine_async_finish(result);
                    if (!engine)
                        return;
                } catch(e) {
                    return;
                }
                this._engineChanged(this._ibus, engine.get_name());
            }));
            this._updateReadiness();
        } else {
            this._clear();
        }
    },

    _updateReadiness: function() {
        this._ready = (Object.keys(this._engines).length > 0 &&
                       this._panelService != null);
        this.emit('ready', this._ready);
    },

    _engineChanged: function(bus, engineName) {
        if (!this._ready)
            return;

        this._currentEngineName = engineName;

        if (this._registerPropertiesId != 0)
            return;

        this._registerPropertiesId =
            this._panelService.connect('register-properties', Lang.bind(this, function(p, props) {
                if (!props.get(0))
                    return;

                this._panelService.disconnect(this._registerPropertiesId);
                this._registerPropertiesId = 0;

                this.emit('properties-registered', this._currentEngineName, props);
            }));
    },

    _updateProperty: function(panel, prop) {
        this.emit('property-updated', this._currentEngineName, prop);
    },

    _setContentType: function(panel, purpose, hints) {
        this.emit('set-content-type', purpose, hints);
    },

    activateProperty: function(key, state) {
        this._panelService.property_activate(key, state);
    },

    getEngineDesc: function(id) {
        if (!IBus || !this._ready || !this._engines.hasOwnProperty(id))
            return null;

        return this._engines[id];
    },

    setEngine: function(id, callback) {
        // Send id even if id == this._currentEngineName
        // because 'properties-registered' signal can be emitted
        // while this._ibusSources == null on a lock screen.
        if (!IBus || !this._ready) {
            if (callback)
                callback();
            return;
        }

        this._ibus.set_global_engine_async(id, this._MAX_INPUT_SOURCE_ACTIVATION_TIME,
                                           null, callback);
    },

    preloadEngines: function(ids) {
        if (!IBus || !this._ibus || ids.length == 0)
            return;

        if (this._preloadEnginesId != 0) {
            Mainloop.source_remove(this._preloadEnginesId);
            this._preloadEnginesId = 0;
        }

        this._preloadEnginesId =
            Mainloop.timeout_add_seconds(this._PRELOAD_ENGINES_DELAY_TIME,
                                         Lang.bind(this, function() {
                                             this._ibus.preload_engines_async(
                                                 ids,
                                                 -1,
                                                 null,
                                                 null);
                                             this._preloadEnginesId = 0;
                                             return GLib.SOURCE_REMOVE;
                                         }));
    },
});
Signals.addSignalMethods(IBusManager.prototype);

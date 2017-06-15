// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Signals = imports.signals;
const Lang = imports.lang;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const GObject = imports.gi.GObject;

const AppDisplay = imports.ui.appDisplay;
const LayoutManager = imports.ui.layout;
const Main = imports.ui.main;
const Monitor = imports.ui.monitor;
const OverviewControls = imports.ui.overviewControls;
const Params = imports.misc.params;
const Search = imports.ui.search;
const ShellEntry = imports.ui.shellEntry;
const Tweener = imports.ui.tweener;
const WorkspacesView = imports.ui.workspacesView;
const EdgeDragAction = imports.ui.edgeDragAction;
const IconGrid = imports.ui.iconGrid;

const SHELL_KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';
const PINCH_GESTURE_THRESHOLD = 0.7;

const SEARCH_ACTIVATION_TIMEOUT = 50;
const ViewPage = {
    WINDOWS: 1,
    APPS: 2
};

const ViewsDisplayPage = {
    APP_GRID: 1,
    SEARCH: 2
};

const FocusTrap = new Lang.Class({
    Name: 'FocusTrap',
    Extends: St.Widget,

    vfunc_navigate_focus: function(from, direction) {
        if (direction == Gtk.DirectionType.TAB_FORWARD ||
            direction == Gtk.DirectionType.TAB_BACKWARD)
            return this.parent(from, direction);
        return false;
    }
});

function getTermsForSearchString(searchString) {
    searchString = searchString.replace(/^\s+/g, '').replace(/\s+$/g, '');
    if (searchString == '')
        return [];

    let terms = searchString.split(/\s+/);
    return terms;
}

const TouchpadShowOverviewAction = new Lang.Class({
    Name: 'TouchpadShowOverviewAction',

    _init: function(actor) {
        actor.connect('captured-event', Lang.bind(this, this._handleEvent));
    },

    _handleEvent: function(actor, event) {
        if (event.type() != Clutter.EventType.TOUCHPAD_PINCH)
            return Clutter.EVENT_PROPAGATE;

        if (event.get_touchpad_gesture_finger_count() != 3)
            return Clutter.EVENT_PROPAGATE;

        if (event.get_gesture_phase() == Clutter.TouchpadGesturePhase.END)
            this.emit('activated', event.get_gesture_pinch_scale ());

        return Clutter.EVENT_STOP;
    }
});
Signals.addSignalMethods(TouchpadShowOverviewAction.prototype);

const ShowOverviewAction = new Lang.Class({
    Name: 'ShowOverviewAction',
    Extends: Clutter.GestureAction,
    Signals: { 'activated': { param_types: [GObject.TYPE_DOUBLE] } },

    _init : function() {
        this.parent();
        this.set_n_touch_points(3);

        global.display.connect('grab-op-begin', Lang.bind(this, function() {
            this.cancel();
        }));
    },

    vfunc_gesture_prepare : function(action, actor) {
        return Main.actionMode == Shell.ActionMode.NORMAL &&
               this.get_n_current_points() == this.get_n_touch_points();
    },

    _getBoundingRect : function(motion) {
        let minX, minY, maxX, maxY;

        for (let i = 0; i < this.get_n_current_points(); i++) {
            let x, y;

            if (motion == true) {
                [x, y] = this.get_motion_coords(i);
            } else {
                [x, y] = this.get_press_coords(i);
            }

            if (i == 0) {
                minX = maxX = x;
                minY = maxY = y;
            } else {
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }

        return new Meta.Rectangle({ x: minX,
                                    y: minY,
                                    width: maxX - minX,
                                    height: maxY - minY });
    },

    vfunc_gesture_begin : function(action, actor) {
        this._initialRect = this._getBoundingRect(false);
        return true;
    },

    vfunc_gesture_end : function(action, actor) {
        let rect = this._getBoundingRect(true);
        let oldArea = this._initialRect.width * this._initialRect.height;
        let newArea = rect.width * rect.height;
        let areaDiff = newArea / oldArea;

        this.emit('activated', areaDiff);
    }
});

const ViewsDisplayLayout = new Lang.Class({
    Name: 'ViewsDisplayLayout',
    Extends: Clutter.BinLayout,
    Signals: { 'allocated-size-changed': { param_types: [GObject.TYPE_INT,
                                                         GObject.TYPE_INT] } },

    _init: function(entry, appDisplayActor, searchResultsActor) {
        this.parent();

        this._entry = entry;
        this._appDisplayActor = appDisplayActor;
        this._searchResultsActor = searchResultsActor;

        this._entry.connect('style-changed', Lang.bind(this, this._onStyleChanged));
        this._appDisplayActor.connect('style-changed', Lang.bind(this, this._onStyleChanged));

        this._heightAboveEntry = 0;
        this.searchResultsTween = 0;
        this._lowResolutionMode = false;
    },

    _onStyleChanged: function() {
        this.layout_changed();
    },

    _centeredHeightAbove: function (height, availHeight) {
        return Math.max(0, Math.floor((availHeight - height) / 2));
    },

    _computeAppDisplayPlacement: function (viewHeight, entryHeight, availHeight) {
        // If we have the space for it, we add some padding to the top of the
        // all view when calculating its centered position. This is to offset
        // the icon labels at the bottom of the icon grid, so the icons
        // themselves appears centered.
        let themeNode = this._appDisplayActor.get_theme_node();
        let topPadding = themeNode.get_length('-natural-padding-top');
        let heightAbove = this._centeredHeightAbove(viewHeight + topPadding, availHeight);
        let leftover = Math.max(availHeight - viewHeight - heightAbove, 0);
        heightAbove += Math.min(topPadding, leftover);
        // Always leave enough room for the search entry at the top
        heightAbove = Math.max(entryHeight, heightAbove);
        return heightAbove;
    },

    _computeChildrenAllocation: function(allocation) {
        let availWidth = allocation.x2 - allocation.x1;
        let availHeight = allocation.y2 - allocation.y1;

        // Entry height
        let entryHeight = this._entry.get_preferred_height(availWidth)[1];
        let themeNode = this._entry.get_theme_node();
        let entryMinPadding = themeNode.get_length('-minimum-vpadding');
        let entryTopMargin = themeNode.get_length('margin-top');
        entryHeight += entryMinPadding * 2;

        // AppDisplay height
        let appDisplayHeight = this._appDisplayActor.get_preferred_height(availWidth)[1];
        let heightAboveGrid = this._computeAppDisplayPlacement(appDisplayHeight, entryHeight, availHeight);
        this._heightAboveEntry = this._centeredHeightAbove(entryHeight, heightAboveGrid);

        let entryBox = allocation.copy();
        entryBox.y1 = this._heightAboveEntry + entryTopMargin;
        entryBox.y2 = entryBox.y1 + entryHeight;

        let appDisplayBox = allocation.copy();
        appDisplayBox.y1 = this._computeAppDisplayPlacement(appDisplayHeight, entryHeight, availHeight);
        appDisplayBox.y2 = Math.min(appDisplayBox.y1 + appDisplayHeight, allocation.y2);

        let searchResultsBox = allocation.copy();

        // The views clone does not have a searchResultsActor
        if (this._searchResultsActor) {
            let searchResultsHeight = availHeight - entryHeight;
            searchResultsBox.x1 = allocation.x1;
            searchResultsBox.x2 = allocation.x2;
            searchResultsBox.y1 = entryBox.y2;
            searchResultsBox.y2 = searchResultsBox.y1 + searchResultsHeight;
        }

        return [entryBox, appDisplayBox, searchResultsBox];
    },

    vfunc_allocate: function(container, allocation, flags) {
        let [entryBox, appDisplayBox, searchResultsBox] = this._computeChildrenAllocation(allocation);

        // We want to emit the signal BEFORE any allocation has happened since the
        // icon grid will need to precompute certain values before being able to
        // report a sensible preferred height for the specified width.
        this.emit('allocated-size-changed', allocation.x2 - allocation.x1, allocation.y2 - allocation.y1);

        this._entry.allocate(entryBox, flags);
        this._appDisplayActor.allocate(appDisplayBox, flags);
        if (this._searchResultsActor)
            this._searchResultsActor.allocate(searchResultsBox, flags);
    },

    set searchResultsTween(v) {
        if (v == this._searchResultsTween || this._searchResultsActor == null)
            return;

        this._appDisplayActor.visible = v != 1;
        this._searchResultsActor.visible = v != 0;

        this._appDisplayActor.opacity = (1 - v) * 255;
        this._searchResultsActor.opacity = v * 255;

        let entryTranslation = - this._heightAboveEntry * v;
        this._entry.translation_y = entryTranslation;

        this._searchResultsActor.translation_y = entryTranslation;

        this._searchResultsTween = v;
    },

    get searchResultsTween() {
        return this._searchResultsTween;
    }
});

const ViewsDisplayContainer = new Lang.Class({
    Name: 'ViewsDisplayContainer',
    Extends: St.Widget,

    _init: function(entry, appDisplay, searchResults) {
        this._entry = entry;
        this._appDisplay = appDisplay;
        this._searchResults = searchResults;

        this._activePage = ViewsDisplayPage.APP_GRID;

        let layoutManager = new ViewsDisplayLayout(entry, appDisplay.actor, searchResults.actor);
        this.parent({ layout_manager: layoutManager,
                      x_expand: true,
                      y_expand: true });

        layoutManager.connect('allocated-size-changed', Lang.bind(this, this._onAllocatedSizeChanged));

        this.add_child(this._entry);
        this.add_child(this._appDisplay.actor);
        this.add_child(this._searchResults.actor);
    },

    _onTweenComplete: function() {
        this._searchResults.isAnimating = false;
    },

    _onAllocatedSizeChanged: function(actor, width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = box.y1 = 0;
        box.x2 = width;
        box.y2 = height;
        box = this._appDisplay.actor.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;

        this._appDisplay.adaptToSize(availWidth, availHeight);
    },

    showPage: function(page, doAnimation) {
        if (this._activePage === page)
            return;

        this._activePage = page;

        let tweenTarget = page == ViewsDisplayPage.SEARCH ? 1 : 0;
        if (doAnimation) {
            this._searchResults.isAnimating = true;
            Tweener.addTween(this.layout_manager,
                             { searchResultsTween: tweenTarget,
                               transition: 'easeOutQuad',
                               time: 0.25,
                               onComplete: this._onTweenComplete,
                               onCompleteScope: this,
                             });
        } else {
            this.layout_manager.searchResultsTween = tweenTarget;
        }
    },

    getActivePage: function() {
        return this._activePage;
    }
});

const ViewsDisplay = new Lang.Class({
    Name: 'ViewsDisplay',

    _init: function() {
        this._enterSearchTimeoutId = 0;

        this._appDisplay = new AppDisplay.AppDisplay()

        this._searchResults = new Search.SearchResults();
        this._searchResults.connect('search-progress-updated', Lang.bind(this, this._updateSpinner));

        // Since the entry isn't inside the results container we install this
        // dummy widget as the last results container child so that we can
        // include the entry in the keynav tab path
        this._focusTrap = new FocusTrap({ can_focus: true });
        this._focusTrap.connect('key-focus-in', Lang.bind(this, function() {
            this.entry.grab_key_focus();
        }));
        this._searchResults.actor.add_actor(this._focusTrap);

        global.focus_manager.add_group(this._searchResults.actor);

        this.entry = new ShellEntry.OverviewEntry();
        this.entry.connect('search-activated', Lang.bind(this, this._onSearchActivated));
        this.entry.connect('search-active-changed', Lang.bind(this, this._onSearchActiveChanged));
        this.entry.connect('search-navigate-focus', Lang.bind(this, this._onSearchNavigateFocus));
        this.entry.connect('search-terms-changed', Lang.bind(this, this._onSearchTermsChanged));

        this.entry.clutter_text.connect('key-focus-in', Lang.bind(this, function() {
            this._searchResults.highlightDefault(true);
        }));
        this.entry.clutter_text.connect('key-focus-out', Lang.bind(this, function() {
            this._searchResults.highlightDefault(false);
        }));

        // Clicking on any empty area should exit search and get back to the desktop.
        let clickAction = new Clutter.ClickAction();
        clickAction.connect('clicked', Lang.bind(this, this._resetSearch));
        Main.overview.addAction(clickAction, false);
        this._searchResults.actor.bind_property('mapped', clickAction, 'enabled', GObject.BindingFlags.SYNC_CREATE);

        this.actor = new ViewsDisplayContainer(this.entry, this._appDisplay, this._searchResults);
    },

    _updateSpinner: function() {
        this.entry.setSpinning(this._searchResults.searchInProgress);
    },

    _enterSearch: function() {
        if (this._enterSearchTimeoutId > 0)
            return;

        // We give a very short time for search results to populate before
        // triggering the animation, unless an animation is already in progress
        if (this._searchResults.isAnimating) {
            this.actor.showPage(ViewsDisplayPage.SEARCH, true);
            return;
        }

        this._enterSearchTimeoutId = Mainloop.timeout_add(SEARCH_ACTIVATION_TIMEOUT, Lang.bind(this, function () {
            this._enterSearchTimeoutId = 0;
            this.actor.showPage(ViewsDisplayPage.SEARCH, true);
        }));
    },

    _leaveSearch: function() {
        if (this._enterSearchTimeoutId > 0) {
            Mainloop.source_remove(this._enterSearchTimeoutId);
            this._enterSearchTimeoutId = 0;
        }
        this.actor.showPage(ViewsDisplayPage.APP_GRID, true);
    },

    _onSearchActivated: function() {
        this._searchResults.activateDefault();
        this._resetSearch();
    },

    _onSearchActiveChanged: function() {
        if (this.entry.active)
            this._enterSearch();
        else
            this._leaveSearch();
    },

    _onSearchNavigateFocus: function(entry, direction) {
        this._searchResults.navigateFocus(direction);
    },

    _onSearchTermsChanged: function() {
        let terms = this.entry.getSearchTerms();
        this._searchResults.setTerms(terms);
    },

    _resetSearch: function() {
        this.entry.resetSearch();
    },

    get appDisplay() {
        return this._appDisplay;
    },

    get activeViewsPage() {
        return this.actor.getActivePage();
    }
});

const ViewsDisplayConstraint = new Lang.Class({
    Name: 'ViewsDisplayConstraint',
    Extends: Monitor.MonitorConstraint,

    vfunc_update_allocation: function(actor, actorBox) {
        let originalBox = actorBox.copy();
        this.parent(actor, actorBox);

        actorBox.init_rect(originalBox.get_x(), originalBox.get_y(),
                           actorBox.get_width(), originalBox.get_height());
    }
});

const ViewSelector = new Lang.Class({
    Name: 'ViewSelector',

    _init : function() {
        this.actor = new Shell.Stack({ name: 'viewSelector' });

        this._activePage = null;

        this._workspacesDisplay = new WorkspacesView.WorkspacesDisplay();
        this._workspacesDisplay.connect('empty-space-clicked', Lang.bind(this, this._onEmptySpaceClicked));
        this._workspacesPage = this._addPage(this._workspacesDisplay.actor,
                                             _("Windows"), 'focus-windows-symbolic');

        this._viewsDisplay = new ViewsDisplay();
        this._appsPage = this._addPage(this._viewsDisplay.actor,
                                       _("Applications"), 'view-grid-symbolic');
        this._appsPage.add_constraint(new ViewsDisplayConstraint({ primary: true,
                                                                   work_area: true }));

        this.appDisplay = this._viewsDisplay.appDisplay;
        this._entry = this._viewsDisplay.entry;

        this._stageKeyPressId = 0;
        Main.overview.connect('showing', Lang.bind(this,
            function () {
                this._stageKeyPressId = global.stage.connect('key-press-event',
                                                             Lang.bind(this, this._onStageKeyPress));
            }));
        Main.overview.connect('hiding', Lang.bind(this,
            function () {
                if (this._stageKeyPressId != 0) {
                    global.stage.disconnect(this._stageKeyPressId);
                    this._stageKeyPressId = 0;
                }
            }));
        Main.overview.connect('shown', Lang.bind(this,
            function() {
                // If we were animating from the desktop view to the
                // apps page the workspace page was visible, allowing
                // the windows to animate, but now we no longer want to
                // show it given that we are now on the apps page or
                // search page.
                if (this._activePage != this._workspacesPage) {
                    this._workspacesPage.opacity = 0;
                    this._workspacesPage.hide();
                }
            }));

        Main.wm.addKeybinding('toggle-overview',
                              new Gio.Settings({ schema_id: SHELL_KEYBINDINGS_SCHEMA }),
                              Meta.KeyBindingFlags.NONE,
                              Shell.ActionMode.NORMAL |
                              Shell.ActionMode.OVERVIEW,
                              Lang.bind(Main.overview, Main.overview.toggle));

        let side;
        if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL)
            side = St.Side.RIGHT;
        else
            side = St.Side.LEFT;
        let gesture = new EdgeDragAction.EdgeDragAction(side,
                                                        Shell.ActionMode.NORMAL);
        gesture.connect('activated', Lang.bind(this, function() {
            if (Main.overview.visible)
                Main.overview.hide();
            else
                this.showApps();
        }));
        global.stage.add_action(gesture);

        gesture = new ShowOverviewAction();
        gesture.connect('activated', Lang.bind(this, this._pinchGestureActivated));
        global.stage.add_action(gesture);

        gesture = new TouchpadShowOverviewAction(global.stage);
        gesture.connect('activated', Lang.bind(this, this._pinchGestureActivated));
    },

    _pinchGestureActivated: function(action, scale) {
        if (scale < PINCH_GESTURE_THRESHOLD)
            Main.overview.show();
    },

    _onEmptySpaceClicked: function() {
        this.setActivePage(ViewPage.APPS);
    },

    showApps: function() {
        Main.overview.show();
    },

    show: function(viewPage) {
        this._activePage = null;
        this._showPage(this._pageFromViewPage(viewPage));
        this._workspacesDisplay.show(true);
    },

    animateFromOverview: function() {
        // Make sure workspace page is fully visible to allow
        // workspace.js do the animation of the windows
        this._workspacesPage.opacity = 255;

        this._workspacesDisplay.animateFromOverview(this._activePage != this._workspacesPage);

        this._showPage(this._workspacesPage);

        if (!this._workspacesDisplay.activeWorkspaceHasMaximizedWindows())
            Main.overview.fadeInDesktop();
    },

    setWorkspacesFullGeometry: function(geom) {
        this._workspacesDisplay.setWorkspacesFullGeometry(geom);
    },

    hide: function() {
        // Nothing to do, since we always show the app selector
    },

    _addPage: function(actor, name, a11yIcon, params) {
        params = Params.parse(params, { a11yFocus: null });

        let page = new St.Bin({ child: actor,
                                x_align: St.Align.START,
                                y_align: St.Align.START,
                                x_fill: true,
                                y_fill: true });
        if (params.a11yFocus)
            Main.ctrlAltTabManager.addGroup(params.a11yFocus, name, a11yIcon);
        else
            Main.ctrlAltTabManager.addGroup(actor, name, a11yIcon,
                                            { proxy: this.actor,
                                              focusCallback: Lang.bind(this,
                                                  function() {
                                                      this._a11yFocusPage(page);
                                                  })
                                            });;
        page.hide();
        this.actor.add_actor(page);
        return page;
    },

    _fadePageIn: function() {
        Tweener.addTween(this._activePage,
                         { opacity: 255,
                           time: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME,
                           transition: 'easeOutQuad'
                         });
    },

    _fadePageOut: function(page) {
        let oldPage = page;
        Tweener.addTween(page,
                         { opacity: 0,
                           time: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this, function() {
                               this._animateIn(oldPage);
                           })
                         });
    },

    _animateIn: function(oldPage) {
        if (oldPage)
            oldPage.hide();

        this.emit('page-empty');

        this._activePage.show();

        if (this._activePage == this._appsPage && oldPage == this._workspacesPage) {
            // Restore opacity, in case we animated via _fadePageOut
            this._activePage.opacity = 255;
            this.appDisplay.animate(IconGrid.AnimationDirection.IN);
        } else {
            this._fadePageIn();
        }
    },

    _animateOut: function(page) {
        let oldPage = page;
        if (page == this._appsPage &&
            this._activePage == this._workspacesPage &&
            !Main.overview.animationInProgress) {
            this.appDisplay.animate(IconGrid.AnimationDirection.OUT, Lang.bind(this,
                function() {
                    this._animateIn(oldPage)
                }));
        } else {
            this._fadePageOut(page);
        }
    },

    _showPage: function(page) {
        if (!Main.overview.visible)
            return;

        if (page == this._activePage)
            return;

        let oldPage = this._activePage;
        this._activePage = page;
        this.emit('page-changed');

        if (oldPage)
            this._animateOut(oldPage)
        else
            this._animateIn();
    },

    _a11yFocusPage: function(page) {
        page.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false);
    },

    _onStageKeyPress: function(actor, event) {
        // Ignore events while anything but the overview has
        // pushed a modal (system modals, looking glass, ...)
        if (Main.modalCount > 1)
            return Clutter.EVENT_PROPAGATE;

        let symbol = event.get_key_symbol();

        if (this._activePage == this._workspacesPage) {
            if (symbol == Clutter.Escape) {
                Main.overview.toggleWindows();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (!global.stage.key_focus) {
            if (symbol == Clutter.Tab || symbol == Clutter.Down) {
                this._activePage.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false);
                return Clutter.EVENT_STOP;
            } else if (symbol == Clutter.ISO_Left_Tab) {
                this._activePage.navigate_focus(null, Gtk.DirectionType.TAB_BACKWARD, false);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    },

    _pageFromViewPage: function(viewPage) {
        let page;

        if (viewPage == ViewPage.WINDOWS)
            page = this._workspacesPage;
        else
            page = this._appsPage;

        return page;
    },

    getActivePage: function() {
        if (this._activePage == this._workspacesPage)
            return ViewPage.WINDOWS;
        else
            return ViewPage.APPS;
    },

    setActivePage: function(viewPage) {
        this._showPage(this._pageFromViewPage(viewPage));
    },

    fadeIn: function() {
        let actor = this._activePage;
        Tweener.addTween(actor, { opacity: 255,
                                  time: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME / 2,
                                  transition: 'easeInQuad'
                                });
    },

    fadeHalf: function() {
        let actor = this._activePage;
        Tweener.addTween(actor, { opacity: 128,
                                  time: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME / 2,
                                  transition: 'easeOutQuad'
                                });
    }
});
Signals.addSignalMethods(ViewSelector.prototype);

/*******************************************************************************

    uBlock Origin for UXP - WebExtension runtime
    Copyright (C) 2026-present uBlock-UXP contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

*/

// browser.tabs, browser.windows, browser.webNavigation, and the tab/frame
// tracker shared with webRequest and runtime messaging.
//
// IDs follow Firefox: tab IDs are small integers starting at 1, a frame ID
// is 0 for a tab's top-level window and the window's outer window ID
// otherwise, window IDs are the browser windows' outer window IDs.
//
// Loaded into Extension.jsm's global (see there).

/* global Cc, Ci, Cr, Cu, Services, XPCOMUtils, setTimeout, dispatch,
          MatchPattern, outerWindowIdOf, EventManager, ExtensionError,
          apiAsync */
/* exported createTabsAPIs, errorNameOf */

'use strict';

var { createTabsAPIs, errorNameOf } = (( ) => {

const { PrivateBrowsingUtils } = Cu.import('resource://gre/modules/PrivateBrowsingUtils.jsm', {});

const TAB_ID_NONE = -1;
const WINDOW_ID_NONE = -1;
const WINDOW_ID_CURRENT = -2;
const BROWSER_CHROME_URL = 'chrome://browser/content/browser.xul';
const wpl = Ci.nsIWebProgressListener;
const PROGRESS_MASK = Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT |
    Ci.nsIWebProgress.NOTIFY_STATE_WINDOW |
    Ci.nsIWebProgress.NOTIFY_LOCATION;

/******************************************************************************/

let errorNames = null;

// "NS_ERROR_ABORT" and the like, as Firefox reports errors.
const errorNameOf = function(status) {
    if ( errorNames === null ) {
        errorNames = new Map(Object.keys(Cr).map(name => [ Cr[name], name ]));
    }
    return errorNames.get(status) || `NS_ERROR_${status}`;
};

const browserWindows = function() {
    const out = [];
    const windows = Services.wm.getEnumerator('navigator:browser');
    while ( windows.hasMoreElements() ) {
        const win = windows.getNext();
        if ( win.closed === false && win.gBrowser ) { out.push(win); }
    }
    return out;
};

const isBrowserWindow = win =>
    win.document.documentElement.getAttribute('windowtype') === 'navigator:browser';

const frameIdOf = win => win.top === win ? 0 : outerWindowIdOf(win);
const parentFrameIdOf = win => win.top === win ? -1 : frameIdOf(win.parent);

const documentURLOf = function(win) {
    try {
        return win.document.documentURI;
    } catch {
    }
    return '';
};

// Internal schemes resolve to file: or jar: URIs; report what was asked for.
// A document written by document.open() loads through a channel
// `wyciwyg://<id>/<URL>`: report the URL the document gets.
const requestURLOf = function(request) {
    try {
        const channel = request.QueryInterface(Ci.nsIChannel);
        const uri = channel.URI;
        if ( uri.schemeIs('wyciwyg') ) {
            return uri.spec.replace(/^wyciwyg:\/\/\d+\//, '');
        }
        if ( uri.schemeIs('file') || uri.schemeIs('jar') ) {
            const original = channel.originalURI;
            if ( /^(?:about|chrome|resource|moz-extension)$/.test(original.scheme) ) {
                return original.spec;
            }
        }
        return uri.spec;
    } catch {
    }
    return '';
};

// A tab's docShell: its web progress, and its window as the key to know it
// by (XPCOM objects cannot be weak keys; the window lives as long as the
// docShell, and moves with it).
const docShellOf = function(browser) {
    try {
        const webProgress = browser.webProgress;
        return { webProgress, key: webProgress.DOMWindow };
    } catch {
    }
    return null;
};

const windowStateOf = function(win) {
    switch ( win.windowState ) {
    case win.STATE_MAXIMIZED: return 'maximized';
    case win.STATE_MINIMIZED: return 'minimized';
    case win.STATE_FULLSCREEN: return 'fullscreen';
    default: return 'normal';
    }
};

const whenWindowReady = function(win) {
    return new Promise(resolve => {
        const check = ( ) => {
            if ( win.closed ) { return resolve(false); }
            if ( win.document.readyState === 'complete' && win.gBrowser ) {
                return resolve(true);
            }
            setTimeout(check, 50);
        };
        check();
    });
};

// [tabId], [object] argument forms of tabs.update() and tabs.reload().
const tabIdAndObject = args => typeof args[0] === 'number'
    ? [ args[0], args[1] || {} ]
    : [ undefined, args[0] || {} ];

/******************************************************************************/

const TabTracker = class {
    constructor(extension) {
        this.extension = extension;
        this.ids = new WeakMap();
        this.browsers = new Map();
        this.nextId = 1;
        this.windows = new Set();
        this.selectedTabIds = new WeakMap();
        this.openerPending = new WeakSet();
        this.locations = new WeakMap();
        this.focusedWindowId = WINDOW_ID_NONE;
        const events = (namespace, names) => Object.fromEntries(
            names.map(name => [ name, new EventManager(`${namespace}.${name}`) ])
        );
        this.tabEvents = events('tabs', [
            'onActivated', 'onAttached', 'onCreated', 'onDetached',
            'onHighlighted', 'onMoved', 'onRemoved', 'onReplaced', 'onUpdated',
        ]);
        this.windowEvents = events('windows', [ 'onCreated', 'onFocusChanged', 'onRemoved' ]);
        this.navigationEvents = events('webNavigation', [
            'onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded',
            'onCompleted', 'onErrorOccurred', 'onCreatedNavigationTarget',
            'onHistoryStateUpdated', 'onReferenceFragmentUpdated',
            'onTabReplaced',
        ]);
        // On every tab's own web progress: see attachBrowser(). Progress
        // listeners are held weakly; this object keeps it alive.
        this.progressListener = {
            QueryInterface: XPCOMUtils.generateQI([
                Ci.nsIWebProgressListener,
                Ci.nsISupportsWeakReference,
            ]),
            onStateChange: (...args) => { this.onStateChange(...args); },
            onLocationChange: (...args) => { this.onLocationChange(...args); },
            onProgressChange() {},
            onStatusChange() {},
            onSecurityChange() {},
        };
        // The docShells listened to (see docShellOf()): a tab moved to
        // another window keeps its docShell, and so its listener.
        this.listenedDocShells = new WeakSet();
        this.windowWatcher = {
            observe: (subject, topic) => { this.onWindowWatcher(subject, topic); },
        };
        this.chromeObservers = new Set();
    }

    // Runtime parts which add to the browser windows' UI (api-ui.js) follow
    // them through these optional methods: onWindowAttached(win),
    // onWindowDetached(win), onTabSelected(tab), onTabNavigated(tab) (a new
    // document in the tab), onTabRemoved(tabId). A new observer is told of
    // the windows already attached.
    addChromeObserver(observer) {
        this.chromeObservers.add(observer);
        for ( const win of this.windows ) {
            this.notifyChrome('onWindowAttached', [ win ], observer);
        }
    }

    removeChromeObserver(observer) {
        this.chromeObservers.delete(observer);
    }

    notifyChrome(method, args, only = null) {
        for ( const observer of only !== null ? [ only ] : this.chromeObservers ) {
            if ( typeof observer[method] !== 'function' ) { continue; }
            try {
                observer[method](...args);
            } catch (ex) {
                Cu.reportError(ex);
            }
        }
    }

    start() {
        for ( const win of browserWindows() ) {
            this.attachWindow(win);
        }
        Services.ww.registerNotification(this.windowWatcher);
    }

    stop() {
        Services.ww.unregisterNotification(this.windowWatcher);
        for ( const win of Array.from(this.windows) ) {
            this.detachWindow(win);
        }
        this.browsers.clear();
    }

    /**************************************************************************/

    getId(browser) {
        let id = this.ids.get(browser);
        if ( id === undefined ) {
            id = this.nextId++;
            this.ids.set(browser, id);
            this.browsers.set(id, browser);
        }
        return id;
    }

    tabForBrowser(browser) {
        if ( browser === null || browser === undefined ) { return null; }
        let gBrowser;
        try {
            gBrowser = browser.ownerGlobal && browser.ownerGlobal.gBrowser;
        } catch {
        }
        if ( !gBrowser ) { return null; }
        if ( typeof gBrowser.getTabForBrowser === 'function' ) {
            // Basilisk returns undefined for a browser it no longer knows.
            return gBrowser.getTabForBrowser(browser) || null;
        }
        for ( const tab of gBrowser.tabs ) {
            if ( tab.linkedBrowser === browser ) { return tab; }
        }
        return null;
    }

    tabIdForBrowser(browser) {
        return this.tabForBrowser(browser) !== null ? this.getId(browser) : TAB_ID_NONE;
    }

    tabById(tabId) {
        const browser = this.browsers.get(tabId);
        return browser !== undefined ? this.tabForBrowser(browser) : null;
    }

    // The tab browser hosting a content window, if any.
    browserForContentWindow(win) {
        try {
            return win.top.QueryInterface(Ci.nsIInterfaceRequestor)
                .getInterface(Ci.nsIWebNavigation)
                .QueryInterface(Ci.nsIDocShell)
                .chromeEventHandler;
        } catch {
        }
        return null;
    }

    tabForContext(context) {
        if ( context.unloaded ) { return null; }
        return this.tabForBrowser(this.browserForContentWindow(context.window));
    }

    windowIdOf(win) {
        return outerWindowIdOf(win);
    }

    windowById(windowId, context = null) {
        if ( windowId === WINDOW_ID_CURRENT ) {
            return this.currentWindow(context);
        }
        for ( const win of browserWindows() ) {
            if ( this.windowIdOf(win) === windowId ) { return win; }
        }
        return null;
    }

    // The window a context means by "current": its own, else the last
    // focused browser window.
    currentWindow(context) {
        if ( context !== null ) {
            const tab = this.tabForContext(context);
            if ( tab !== null ) { return tab.ownerGlobal; }
        }
        return Services.wm.getMostRecentWindow('navigator:browser');
    }

    convertTab(tab) {
        const browser = tab.linkedBrowser;
        const win = tab.ownerGlobal;
        const pending = tab.hasAttribute('pending');
        const url = browser.currentURI ? browser.currentURI.spec : 'about:blank';
        let loading = false;
        try {
            loading = pending === false && browser.webProgress.isLoadingDocument;
        } catch {
        }
        return {
            id: this.getId(browser),
            index: Array.prototype.indexOf.call(win.gBrowser.tabs, tab),
            windowId: this.windowIdOf(win),
            active: tab.selected === true,
            highlighted: tab.selected === true,
            pinned: tab.pinned === true,
            hidden: tab.hidden === true,
            discarded: pending,
            status: loading ? 'loading' : 'complete',
            incognito: PrivateBrowsingUtils.isWindowPrivate(win),
            url,
            title: tab.label || url,
            favIconUrl: tab.image || undefined,
            width: browser.clientWidth,
            height: browser.clientHeight,
            lastAccessed: tab.lastAccessed || 0,
            audible: false,
            mutedInfo: { muted: tab.hasAttribute('muted') },
            cookieStoreId: 'firefox-default',
        };
    }

    convertWindow(win, populate = false) {
        const out = {
            id: this.windowIdOf(win),
            focused: Services.focus.activeWindow === win,
            top: win.screenY,
            left: win.screenX,
            width: win.outerWidth,
            height: win.outerHeight,
            incognito: PrivateBrowsingUtils.isWindowPrivate(win),
            type: win.toolbar.visible ? 'normal' : 'popup',
            state: windowStateOf(win),
            alwaysOnTop: false,
            title: win.document.title,
        };
        if ( populate ) {
            out.tabs = Array.from(win.gBrowser.tabs, tab => this.convertTab(tab));
        }
        return out;
    }

    // Extension URLs may be relative; privileged schemes are refused, as in
    // Firefox.
    checkURL(url) {
        const resolved = /^[a-z][a-z0-9+.-]*:/i.test(url)
            ? url
            : this.extension.getURL(url);
        if (
            this.extension.isOwnURL(resolved) ||
            /^(?:https?|ftp):/.test(resolved) ||
            resolved === 'about:blank' ||
            resolved === 'about:newtab'
        ) {
            return resolved;
        }
        throw new ExtensionError(`Illegal URL: ${url}`);
    }

    /**************************************************************************/

    // Windows and tab events

    attachWindow(win) {
        if ( this.windows.has(win) ) { return; }
        this.windows.add(win);
        const gBrowser = win.gBrowser;
        for ( const type of [ 'TabOpen', 'TabClose', 'TabSelect', 'TabMove', 'TabPinned', 'TabUnpinned' ] ) {
            gBrowser.tabContainer.addEventListener(type, this);
        }
        gBrowser.addEventListener('DOMContentLoaded', this, true);
        gBrowser.addEventListener('DOMTitleChanged', this, true);
        win.addEventListener('activate', this);
        win.addEventListener('deactivate', this);
        for ( const tab of gBrowser.tabs ) {
            this.getId(tab.linkedBrowser);
            this.attachBrowser(tab.linkedBrowser);
        }
        this.selectedTabIds.set(win, this.getId(gBrowser.selectedBrowser));
        this.notifyChrome('onWindowAttached', [ win ]);
    }

    detachWindow(win) {
        if ( this.windows.has(win) === false ) { return; }
        this.notifyChrome('onWindowDetached', [ win ]);
        this.windows.delete(win);
        const gBrowser = win.gBrowser;
        for ( const type of [ 'TabOpen', 'TabClose', 'TabSelect', 'TabMove', 'TabPinned', 'TabUnpinned' ] ) {
            gBrowser.tabContainer.removeEventListener(type, this);
        }
        gBrowser.removeEventListener('DOMContentLoaded', this, true);
        gBrowser.removeEventListener('DOMTitleChanged', this, true);
        win.removeEventListener('activate', this);
        win.removeEventListener('deactivate', this);
        for ( const tab of gBrowser.tabs ) {
            this.detachBrowser(tab.linkedBrowser);
        }
    }

    // The tabbrowser's own progress listeners hear only what its status
    // filter lets through: the start and end of a tab's whole load, never a
    // subframe's. Firefox's WebNavigation listens to the docShell itself;
    // so does this, on each tab: its frames' notifications reach it too.
    attachBrowser(browser) {
        const docShell = docShellOf(browser);
        if ( docShell === null || this.listenedDocShells.has(docShell.key) ) { return; }
        docShell.webProgress.addProgressListener(this.progressListener, PROGRESS_MASK);
        this.listenedDocShells.add(docShell.key);
    }

    detachBrowser(browser) {
        const docShell = docShellOf(browser);
        if ( docShell === null || this.listenedDocShells.delete(docShell.key) === false ) { return; }
        try {
            docShell.webProgress.removeProgressListener(this.progressListener);
        } catch {
        }
    }

    onWindowWatcher(win, topic) {
        if ( topic === 'domwindowopened' ) {
            whenWindowReady(win).then(ready => {
                if ( ready === false || isBrowserWindow(win) === false ) { return; }
                this.attachWindow(win);
                this.windowEvents.onCreated.fire(this.convertWindow(win));
            });
            return;
        }
        if ( topic !== 'domwindowclosed' || this.windows.has(win) === false ) { return; }
        const windowId = this.windowIdOf(win);
        for ( const tab of Array.from(win.gBrowser.tabs) ) {
            const tabId = this.getId(tab.linkedBrowser);
            this.tabEvents.onRemoved.fire(tabId, { windowId, isWindowClosing: true });
            this.notifyChrome('onTabRemoved', [ tabId ]);
            this.browsers.delete(tabId);
        }
        this.detachWindow(win);
        this.windowEvents.onRemoved.fire(windowId);
    }

    handleEvent(event) {
        switch ( event.type ) {
        case 'TabOpen':
            this.onTabOpen(event.target);
            break;
        case 'TabClose': {
            const tab = event.target;
            const tabId = this.getId(tab.linkedBrowser);
            this.tabEvents.onRemoved.fire(tabId, {
                windowId: this.windowIdOf(tab.ownerGlobal),
                isWindowClosing: false,
            });
            this.notifyChrome('onTabRemoved', [ tabId ]);
            this.browsers.delete(tabId);
            this.detachBrowser(tab.linkedBrowser);
            break;
        }
        case 'TabSelect':
            this.onTabSelect(event.target);
            break;
        case 'TabMove': {
            const tab = event.target;
            this.tabEvents.onMoved.fire(this.getId(tab.linkedBrowser), {
                windowId: this.windowIdOf(tab.ownerGlobal),
                fromIndex: event.detail,
                toIndex: Array.prototype.indexOf.call(tab.ownerGlobal.gBrowser.tabs, tab),
            });
            break;
        }
        case 'TabPinned':
        case 'TabUnpinned':
            this.fireUpdated(event.target, { pinned: event.type === 'TabPinned' });
            break;
        case 'DOMContentLoaded':
            this.onDOMContentLoaded(event.originalTarget);
            break;
        case 'DOMTitleChanged':
            this.onTitleChanged(event.originalTarget);
            break;
        case 'activate':
            this.onWindowFocus(event.currentTarget);
            break;
        case 'deactivate':
            dispatch(( ) => { this.onWindowFocus(Services.focus.activeWindow); });
            break;
        default:
            break;
        }
    }

    onTabOpen(tab) {
        const browser = tab.linkedBrowser;
        this.getId(browser);
        this.attachBrowser(browser);
        this.tabEvents.onCreated.fire(this.convertTab(tab));
        // window.opener is set once the opening script's window.open()
        // returns.
        this.openerPending.add(browser);
        dispatch(( ) => { this.checkOpener(browser, ''); });
    }

    // webNavigation.onCreatedNavigationTarget: a tab opened by a page.
    checkOpener(browser, url) {
        if ( this.openerPending.has(browser) === false ) { return; }
        this.openerPending.delete(browser);
        let opener = null;
        try {
            opener = browser.contentWindow && browser.contentWindow.opener;
        } catch {
        }
        if ( !opener ) { return; }
        const sourceTabId = this.tabIdForBrowser(this.browserForContentWindow(opener));
        if ( sourceTabId === TAB_ID_NONE ) { return; }
        this.navigationEvents.onCreatedNavigationTarget.fire({
            sourceTabId,
            sourceFrameId: frameIdOf(opener),
            tabId: this.getId(browser),
            windowId: this.windowIdOf(browser.ownerGlobal),
            url: url || browser.currentURI.spec,
            timeStamp: Date.now(),
        });
    }

    onTabSelect(tab) {
        const win = tab.ownerGlobal;
        const tabId = this.getId(tab.linkedBrowser);
        const previousTabId = this.selectedTabIds.get(win);
        this.selectedTabIds.set(win, tabId);
        const details = { tabId, windowId: this.windowIdOf(win) };
        if ( previousTabId !== undefined && previousTabId !== tabId ) {
            details.previousTabId = previousTabId;
        }
        this.notifyChrome('onTabSelected', [ tab ]);
        this.tabEvents.onActivated.fire(details);
    }

    onWindowFocus(win) {
        const windowId = win && this.windows.has(win) ? this.windowIdOf(win) : WINDOW_ID_NONE;
        if ( windowId === this.focusedWindowId ) { return; }
        this.focusedWindowId = windowId;
        this.windowEvents.onFocusChanged.fire(windowId);
    }

    fireUpdated(tab, changeInfo) {
        if ( tab === null ) { return; }
        this.tabEvents.onUpdated.fire(this.getId(tab.linkedBrowser), changeInfo, this.convertTab(tab));
    }

    onDOMContentLoaded(doc) {
        if ( !doc || doc.nodeType !== 9 /* DOCUMENT_NODE */ || doc.defaultView === null ) { return; }
        const win = doc.defaultView;
        const tabId = this.tabIdForBrowser(this.browserForContentWindow(win));
        if ( tabId === TAB_ID_NONE ) { return; }
        this.navigationEvents.onDOMContentLoaded.fire({
            tabId,
            url: doc.documentURI,
            frameId: frameIdOf(win),
            parentFrameId: parentFrameIdOf(win),
            timeStamp: Date.now(),
        });
    }

    onTitleChanged(doc) {
        if ( !doc || doc.nodeType !== 9 || doc.defaultView === null ) { return; }
        const win = doc.defaultView;
        if ( win.top !== win ) { return; }
        const tab = this.tabForBrowser(this.browserForContentWindow(win));
        if ( tab === null ) { return; }
        this.fireUpdated(tab, { title: doc.title });
    }

    /**************************************************************************/

    // Navigation, from each tab's progress notifications (all its frames,
    // see attachBrowser()).

    navigationDetails(webProgress, url) {
        let win;
        try {
            win = webProgress.DOMWindow;
        } catch {
            return null;
        }
        const browser = this.browserForContentWindow(win);
        const tabId = this.tabIdForBrowser(browser);
        if ( tabId === TAB_ID_NONE ) { return null; }
        return {
            browser,
            win,
            details: {
                tabId,
                url,
                frameId: frameIdOf(win),
                parentFrameId: parentFrameIdOf(win),
                timeStamp: Date.now(),
            },
        };
    }

    transitionOf(webProgress, request, isTopLevel) {
        let loadType = 0;
        try {
            loadType = webProgress.loadType;
        } catch {
        }
        const transitionQualifiers = [];
        let transitionType = isTopLevel ? 'link' : 'auto_subframe';
        if ( (loadType & Ci.nsIDocShell.LOAD_CMD_RELOAD) !== 0 ) {
            transitionType = 'reload';
        }
        if ( (loadType & Ci.nsIDocShell.LOAD_CMD_HISTORY) !== 0 ) {
            transitionQualifiers.push('forward_back');
        }
        try {
            if ( request.QueryInterface(Ci.nsIChannel).loadInfo.redirectChain.length !== 0 ) {
                transitionQualifiers.push('server_redirect');
            }
        } catch {
        }
        return { transitionType, transitionQualifiers };
    }

    onStateChange(webProgress, request, flags, status) {
        const isStart = (flags & wpl.STATE_START) !== 0;
        const isStop = (flags & wpl.STATE_STOP) !== 0;
        if ( isStart && (flags & wpl.STATE_IS_DOCUMENT) !== 0 ) {
            const url = requestURLOf(request);
            const nav = this.navigationDetails(webProgress, url);
            if ( nav === null ) { return; }
            this.navigationEvents.onBeforeNavigate.fire(nav.details);
            if ( nav.details.frameId === 0 ) {
                this.checkOpener(nav.browser, url);
                this.fireUpdated(this.tabForBrowser(nav.browser), { status: 'loading' });
            } else {
                // UXP reports no location change for a subframe's initial
                // navigation: its commit is reported here (as in Firefox).
                this.navigationEvents.onCommitted.fire(Object.assign(
                    nav.details,
                    this.transitionOf(webProgress, request, false)
                ));
            }
            return;
        }
        if ( isStop && (flags & wpl.STATE_IS_WINDOW) !== 0 ) {
            let win;
            try {
                win = webProgress.DOMWindow;
            } catch {
                return;
            }
            const nav = this.navigationDetails(webProgress, documentURLOf(win));
            if ( nav === null ) { return; }
            if ( Components.isSuccessCode(status) ) {
                this.navigationEvents.onCompleted.fire(nav.details);
            } else {
                nav.details.error = errorNameOf(status);
                this.navigationEvents.onErrorOccurred.fire(nav.details);
            }
            if ( nav.details.frameId === 0 ) {
                this.fireUpdated(this.tabForBrowser(nav.browser), { status: 'complete' });
            }
        }
    }

    onLocationChange(webProgress, request, location, flags) {
        const url = location ? location.spec : '';
        const nav = this.navigationDetails(webProgress, url);
        if ( nav === null ) { return; }
        const previous = this.locations.get(nav.win);
        this.locations.set(nav.win, location);
        const isTopLevel = nav.details.frameId === 0;
        if ( (flags & wpl.LOCATION_CHANGE_SAME_DOCUMENT) !== 0 ) {
            const pathChanged = !(previous && location && location.equalsExceptRef(previous));
            const hashChanged = !(previous && location && previous.ref === location.ref);
            let loadType = 0;
            try {
                loadType = webProgress.loadType;
            } catch {
            }
            let event = null;
            if ( pathChanged === false && hashChanged ) {
                event = this.navigationEvents.onReferenceFragmentUpdated;
            } else if ( (loadType & (Ci.nsIDocShell.LOAD_CMD_PUSHSTATE | Ci.nsIDocShell.LOAD_CMD_HISTORY)) !== 0 ) {
                event = this.navigationEvents.onHistoryStateUpdated;
            }
            if ( event !== null ) {
                event.fire(Object.assign(nav.details, this.transitionOf(webProgress, request, isTopLevel)));
            }
        } else if ( isTopLevel ) {
            // First: the extension then sets its toolbar state for the new
            // document.
            const tab = this.tabForBrowser(nav.browser);
            if ( tab !== null ) {
                this.notifyChrome('onTabNavigated', [ tab ]);
            }
            this.navigationEvents.onCommitted.fire(Object.assign(
                {},
                nav.details,
                this.transitionOf(webProgress, request, true)
            ));
        }
        if ( isTopLevel ) {
            this.fireUpdated(this.tabForBrowser(nav.browser), { url });
        }
    }

    framesOf(tabId) {
        const browser = this.browsers.get(tabId);
        if ( browser === undefined || this.tabForBrowser(browser) === null ) { return null; }
        const top = browser.contentWindow;
        if ( !top ) { return null; }
        const out = [];
        const walk = win => {
            out.push({
                frameId: frameIdOf(win),
                parentFrameId: parentFrameIdOf(win),
                url: documentURLOf(win),
                errorOccurred: false,
            });
            for ( let i = 0; i < win.frames.length; i++ ) {
                walk(win.frames[i]);
            }
        };
        walk(top);
        return out;
    }

    /**************************************************************************/

    // tabs.*

    query(context, info) {
        const current = this.currentWindow(context);
        const lastFocused = Services.wm.getMostRecentWindow('navigator:browser');
        const urls = info.url !== undefined ? new MatchPattern(info.url) : null;
        const title = typeof info.title === 'string'
            ? new RegExp(`^${info.title.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
            : null;
        const wantedWindowId = info.windowId === WINDOW_ID_CURRENT
            ? current && this.windowIdOf(current)
            : info.windowId;
        const flags = [ 'active', 'highlighted', 'pinned', 'hidden', 'discarded' ];
        const out = [];
        for ( const win of browserWindows() ) {
            if ( wantedWindowId !== undefined && this.windowIdOf(win) !== wantedWindowId ) { continue; }
            if ( info.currentWindow !== undefined && (win === current) !== info.currentWindow ) { continue; }
            if ( info.lastFocusedWindow !== undefined && (win === lastFocused) !== info.lastFocusedWindow ) { continue; }
            if ( info.windowType !== undefined && info.windowType !== (win.toolbar.visible ? 'normal' : 'popup') ) { continue; }
            for ( const tab of win.gBrowser.tabs ) {
                const t = this.convertTab(tab);
                if ( flags.some(f => info[f] !== undefined && t[f] !== info[f]) ) { continue; }
                if ( info.status !== undefined && t.status !== info.status ) { continue; }
                if ( info.index !== undefined && t.index !== info.index ) { continue; }
                if ( urls !== null && urls.matches(t.url) === false ) { continue; }
                if ( title !== null && title.test(t.title) === false ) { continue; }
                out.push(t);
            }
        }
        return out;
    }

    tabOrThrow(context, tabId) {
        const tab = tabId === undefined
            ? (( ) => {
                const win = this.currentWindow(context);
                return win ? win.gBrowser.selectedTab : null;
            })()
            : this.tabById(tabId);
        if ( tab === null ) {
            throw new ExtensionError(`Invalid tab ID: ${tabId}`);
        }
        return tab;
    }

    create(context, props) {
        const win = props.windowId !== undefined
            ? this.windowById(props.windowId, context)
            : this.currentWindow(context);
        if ( !win ) { throw new ExtensionError('No browser window'); }
        const url = props.url !== undefined
            ? this.checkURL(props.url)
            : win.BROWSER_NEW_TAB_URL || 'about:blank';
        const gBrowser = win.gBrowser;
        const tab = gBrowser.addTab(url, {});
        if ( typeof props.index === 'number' ) {
            gBrowser.moveTabTo(tab, Math.max(0, Math.min(props.index, gBrowser.tabs.length - 1)));
        }
        if ( props.pinned === true ) {
            gBrowser.pinTab(tab);
        }
        if ( props.active !== false ) {
            gBrowser.selectedTab = tab;
        }
        return this.convertTab(tab);
    }

    update(context, ...args) {
        const [ tabId, props ] = tabIdAndObject(args);
        const tab = this.tabOrThrow(context, tabId);
        const gBrowser = tab.ownerGlobal.gBrowser;
        if ( props.url !== undefined ) {
            tab.linkedBrowser.loadURI(this.checkURL(props.url));
        }
        if ( props.active === true ) {
            gBrowser.selectedTab = tab;
        }
        if ( props.pinned === true ) {
            gBrowser.pinTab(tab);
        } else if ( props.pinned === false ) {
            gBrowser.unpinTab(tab);
        }
        return this.convertTab(tab);
    }

    remove(tabIds) {
        for ( const tabId of [].concat(tabIds) ) {
            const tab = this.tabById(tabId);
            if ( tab === null ) {
                throw new ExtensionError(`Invalid tab ID: ${tabId}`);
            }
            tab.ownerGlobal.gBrowser.removeTab(tab);
        }
    }

    reload(context, ...args) {
        const [ tabId, props ] = tabIdAndObject(args);
        const tab = this.tabOrThrow(context, tabId);
        const nav = Ci.nsIWebNavigation;
        tab.linkedBrowser.reloadWithFlags(props.bypassCache === true
            ? nav.LOAD_FLAGS_BYPASS_CACHE | nav.LOAD_FLAGS_BYPASS_PROXY
            : nav.LOAD_FLAGS_NONE
        );
    }

    // Moves within a window; Firefox can also move tabs across windows.
    move(tabIds, props) {
        const out = [];
        let index = props.index;
        for ( const tabId of [].concat(tabIds) ) {
            const tab = this.tabById(tabId);
            if ( tab === null ) {
                throw new ExtensionError(`Invalid tab ID: ${tabId}`);
            }
            const gBrowser = tab.ownerGlobal.gBrowser;
            const last = gBrowser.tabs.length - 1;
            gBrowser.moveTabTo(tab, index === -1 || index > last ? last : index);
            if ( index !== -1 ) { index += 1; }
            out.push(this.convertTab(tab));
        }
        return out;
    }

    /**************************************************************************/

    // windows.*

    windowOrThrow(context, windowId) {
        const win = this.windowById(windowId, context);
        if ( win === null || win === undefined ) {
            throw new ExtensionError(`Invalid window ID: ${windowId}`);
        }
        return win;
    }

    async createWindow(context, data) {
        const urls = data.url === undefined
            ? []
            : [].concat(data.url).map(url => this.checkURL(url));
        const isPopup = /^(?:popup|panel|detached_panel)$/.test(data.type || '');
        const features = isPopup
            ? [ 'chrome', 'dialog=no', 'resizable', 'minimizable', 'scrollbars' ]
            : [ 'chrome', 'dialog=no', 'all' ];
        if ( data.incognito === true ) { features.push('private'); }
        const arg = Cc['@mozilla.org/supports-string;1'].createInstance(Ci.nsISupportsString);
        arg.data = urls.length !== 0 ? urls[0] : 'about:blank';
        const win = Services.ww.openWindow(null, BROWSER_CHROME_URL, '_blank', features.join(','), arg);
        if ( await whenWindowReady(win) === false ) {
            throw new ExtensionError('The window could not be created');
        }
        for ( const url of urls.slice(1) ) {
            win.gBrowser.addTab(url, {});
        }
        this.applyWindowGeometry(win, data);
        if ( data.focused !== false ) { win.focus(); }
        return this.convertWindow(win, true);
    }

    applyWindowGeometry(win, data) {
        if ( typeof data.left === 'number' || typeof data.top === 'number' ) {
            win.moveTo(
                typeof data.left === 'number' ? data.left : win.screenX,
                typeof data.top === 'number' ? data.top : win.screenY
            );
        }
        if ( typeof data.width === 'number' || typeof data.height === 'number' ) {
            win.resizeTo(
                typeof data.width === 'number' ? data.width : win.outerWidth,
                typeof data.height === 'number' ? data.height : win.outerHeight
            );
        }
        switch ( data.state ) {
        case 'minimized': win.minimize(); break;
        case 'maximized': win.maximize(); break;
        case 'normal': win.restore(); break;
        case 'fullscreen': win.fullScreen = true; break;
        default: break;
        }
    }

    updateWindow(context, windowId, info) {
        const win = this.windowOrThrow(context, windowId);
        this.applyWindowGeometry(win, info);
        if ( info.focused === true ) { win.focus(); }
        if ( info.drawAttention === true ) { win.getAttention(); }
        return this.convertWindow(win);
    }
};

/******************************************************************************/

const createTabsAPIs = function(extension) {
    const tracker = new TabTracker(extension);
    tracker.start();
    extension.tabTracker = tracker;
    extension.onShutdown(( ) => { tracker.stop(); });

    const populate = info => info instanceof Object && info.populate === true;

    return {
        build() {
            return {
                tabs: {
                    TAB_ID_NONE,
                    query: apiAsync((context, info) => tracker.query(context, info || {})),
                    get: apiAsync((context, tabId) => tracker.convertTab(tracker.tabOrThrow(context, tabId === undefined ? NaN : tabId))),
                    getCurrent: apiAsync(context => {
                        const tab = tracker.tabForContext(context);
                        return tab !== null ? tracker.convertTab(tab) : undefined;
                    }),
                    create: apiAsync((context, props) => tracker.create(context, props || {})),
                    update: apiAsync((context, ...args) => tracker.update(context, ...args)),
                    remove: apiAsync((context, tabIds) => { tracker.remove(tabIds); }),
                    reload: apiAsync((context, ...args) => { tracker.reload(context, ...args); }),
                    move: apiAsync((context, tabIds, props) => tracker.move(tabIds, props || {})),
                    ...tracker.tabEvents,
                },
                windows: {
                    WINDOW_ID_NONE,
                    WINDOW_ID_CURRENT,
                    get: apiAsync((context, windowId, info) =>
                        tracker.convertWindow(tracker.windowOrThrow(context, windowId), populate(info))
                    ),
                    getCurrent: apiAsync((context, info) =>
                        tracker.convertWindow(tracker.windowOrThrow(context, WINDOW_ID_CURRENT), populate(info))
                    ),
                    getLastFocused: apiAsync((context, info) => {
                        const win = Services.wm.getMostRecentWindow('navigator:browser');
                        if ( win === null ) { throw new ExtensionError('No browser window'); }
                        return tracker.convertWindow(win, populate(info));
                    }),
                    getAll: apiAsync((context, info) =>
                        browserWindows().map(win => tracker.convertWindow(win, populate(info)))
                    ),
                    create: apiAsync((context, data) => tracker.createWindow(context, data || {})),
                    update: apiAsync((context, windowId, info) => tracker.updateWindow(context, windowId, info || {})),
                    remove: apiAsync((context, windowId) => { tracker.windowOrThrow(context, windowId).close(); }),
                    ...tracker.windowEvents,
                },
                webNavigation: {
                    getFrame: apiAsync((context, details) => {
                        const frames = tracker.framesOf(details.tabId) || [];
                        const frame = frames.find(f => f.frameId === details.frameId);
                        return frame !== undefined ? frame : null;
                    }),
                    getAllFrames: apiAsync((context, details) => tracker.framesOf(details.tabId)),
                    ...tracker.navigationEvents,
                },
            };
        },
    };
};

/******************************************************************************/

return { createTabsAPIs, errorNameOf };

})();

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

// The extension itself: identity, moz-extension:// origin, permissions,
// locales, background page, and the contexts into which the `browser` API
// is injected -- extension pages here, content scripts in api-content.js.
//
// UXP still ships Firefox 52's substituting moz-extension: protocol handler
// and its JS AddonPolicyService. Registering the same callbacks Firefox's
// own WebExtensions runtime registered gives extension pages the genuine
// moz-extension://<uuid>/ origin and extension principal, so upstream uBO
// runs its Firefox code paths.
//
// context.js and api-*.js are loaded into this module's global, the way
// Firefox loaded its ext-*.js scripts: one compartment for the whole
// runtime, no cross-compartment calls between its parts.

/* exported EXPORTED_SYMBOLS, Extension */

'use strict';

var EXPORTED_SYMBOLS = [ 'Extension' ];

// `var`: shared with the scripts loaded below.
var { classes: Cc, interfaces: Ci, utils: Cu, results: Cr } = Components;
var { Services } = Cu.import('resource://gre/modules/Services.jsm', {});
var { XPCOMUtils } = Cu.import('resource://gre/modules/XPCOMUtils.jsm', {});
var { NetUtil } = Cu.import('resource://gre/modules/NetUtil.jsm', {});
var { setTimeout, clearTimeout } = Cu.import('resource://gre/modules/Timer.jsm', {});

Cu.importGlobalProperties([ 'URL', 'indexedDB' ]);

{
    const base = __URI__.slice(0, __URI__.lastIndexOf('/') + 1);
    const scripts = [
        'context.js',
        'api-core.js',
        'api-tabs.js',
        'api-webrequest.js',
        'api-content.js',
        'api-ui.js',
    ];
    for ( const script of scripts ) {
        Services.scriptloader.loadSubScript(`${base}${script}`, this, 'UTF-8');
    }
}

/******************************************************************************/

const PREF_UUID = 'extensions.ublock0.uuid';
const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';
const RTL_LANGUAGES = new Set([ 'ar', 'ckb', 'dv', 'fa', 'he', 'ps', 'sd', 'ug', 'ur', 'yi' ]);

const appShell = Cc['@mozilla.org/appshell/appShellService;1']
    .getService(Ci.nsIAppShellService);

/******************************************************************************/

// Run `fn` as a separate task, the way messages between extension contexts
// are delivered in Firefox.
var dispatch = function(fn) {
    Services.tm.mainThread.dispatch(fn, Ci.nsIThread.DISPATCH_NORMAL);
};

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// WebExtension match patterns (https://mdn.io/Match_patterns).
var MatchPattern = class {
    constructor(patterns) {
        this.matchers = [];
        for ( const pattern of [].concat(patterns) ) {
            const matcher = MatchPattern.compile(pattern);
            if ( matcher !== null ) { this.matchers.push(matcher); }
        }
    }
    matches(url) {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (ex) {
            return false;
        }
        return this.matchesURL(parsed);
    }
    // `url`: an already parsed URL object.
    matchesURL(url) {
        return this.matchers.some(matcher => matcher(url));
    }
    static compile(pattern) {
        if ( pattern === '<all_urls>' ) {
            return url => MatchPattern.ALL_URLS_SCHEMES.has(url.protocol.slice(0, -1));
        }
        // A scheme without an authority (`abp:*`, `data:*`): the rest of
        // the URL is matched as a whole.
        const opaque = /^([a-z][a-z0-9+.-]*):(?!\/\/)(.*)$/.exec(pattern);
        if ( opaque !== null ) {
            const [ , scheme, rest ] = opaque;
            const reRest = new RegExp(`^${rest.split('*').map(escapeRegex).join('.*')}$`);
            return url => url.protocol === `${scheme}:` &&
                reRest.test(url.href.slice(scheme.length + 1));
        }
        const match = /^(\*|[a-z][a-z0-9+.-]*):\/\/(\*|\*\.[^/*]+|[^/*]*)(\/.*)$/.exec(pattern);
        if ( match === null ) { return null; }
        const [ , scheme, host, path ] = match;
        const schemes = scheme === '*'
            ? MatchPattern.WILDCARD_SCHEMES
            : new Set([ scheme ]);
        const reHost = host === '*'
            ? null
            : host.startsWith('*.')
                ? new RegExp(`(?:^|\\.)${escapeRegex(host.slice(2))}$`)
                : new RegExp(`^${escapeRegex(host)}$`);
        const rePath = new RegExp(`^${path.split('*').map(escapeRegex).join('.*')}$`);
        return url => {
            if ( schemes.has(url.protocol.slice(0, -1)) === false ) { return false; }
            if ( reHost !== null && reHost.test(url.hostname) === false ) { return false; }
            return rePath.test(url.pathname + url.search);
        };
    }
};
MatchPattern.ALL_URLS_SCHEMES = new Set([ 'http', 'https', 'ws', 'wss', 'ftp', 'file' ]);
MatchPattern.WILDCARD_SCHEMES = new Set([ 'http', 'https', 'ws', 'wss' ]);

/******************************************************************************/

const uuidForExtension = function() {
    let uuid = '';
    try {
        uuid = Services.prefs.getCharPref(PREF_UUID);
    } catch (ex) {
    }
    if ( /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid) === false ) {
        uuid = Cc['@mozilla.org/uuid-generator;1']
            .getService(Ci.nsIUUIDGenerator)
            .generateUUID().toString().slice(1, -1);
        Services.prefs.setCharPref(PREF_UUID, uuid);
    }
    return uuid;
};

const getUILocale = function() {
    try {
        return Cc['@mozilla.org/chrome/chrome-registry;1']
            .getService(Ci.nsIXULChromeRegistry)
            .getSelectedLocale('global');
    } catch (ex) {
    }
    try {
        return Services.prefs.getCharPref('general.useragent.locale');
    } catch (ex) {
    }
    return 'en-US';
};

// Legacy uBO waited for the hidden window too: creating a windowless browser
// earlier in the startup sequence can break the browser's appearance on
// Windows.
const whenHiddenWindowReady = async function(isCancelled) {
    let delay = 5;
    for (;;) {
        let doc = null;
        try {
            doc = appShell.hiddenDOMWindow && appShell.hiddenDOMWindow.document;
        } catch (ex) {
        }
        if ( doc && doc.readyState === 'complete' ) { return true; }
        if ( isCancelled() ) { return false; }
        await new Promise(resolve => { setTimeout(resolve, delay); });
        delay = Math.min(delay * 2, 500);
    }
};

/******************************************************************************/

// `var`: shared with the scripts loaded above.
var windowUtilsOf = win => win.QueryInterface(Ci.nsIInterfaceRequestor)
    .getInterface(Ci.nsIDOMWindowUtils);

var outerWindowIdOf = function(win) {
    try {
        return windowUtilsOf(win).outerWindowID;
    } catch (ex) {
    }
    return 0;
};

var logMessage = message => {
    Services.console.logStringMessage(`uBlock0 UXP: ${message}`);
};

/******************************************************************************/

// UXP stops any page script that runs past dom.max_script_run_time (15 s),
// without asking (dom.always_stop_slow_scripts), and then blocks every
// script of that page. Firefox runs extension background pages in their own
// process, where they are never stopped. On UXP, uBO compiling its filter
// lists at first install runs a ~16 s task; reloading them later, ~9 s.
//
// So while uBO boots, the limit is relaxed -- on the default branch: in
// memory only, and a value the user set takes precedence -- until uBO has
// built its filters, BOOT_WINDOW_MS at most. Afterwards UXP's limit applies;
// if it still stops the background page (a list update on a slow machine),
// the extension restarts the page, with a new boot window. Repeated stops
// keep the limit relaxed for the rest of the session.

const SLOW_SCRIPT_PREF = 'dom.max_script_run_time';
const BOOT_SCRIPT_RUN_TIME = 120;
const BOOT_WINDOW_MS = 180000;
const RESTARTS_BEFORE_STAYING_RELAXED = 3;
const RESTART_PERIOD_MS = 600000;

const SlowScriptLimit = class {
    constructor() {
        this.saved = undefined;
        this.timer = null;
        this.permanent = false;
    }

    relaxForBoot() {
        this.relax();
        if ( this.permanent ) { return; }
        clearTimeout(this.timer);
        this.timer = setTimeout(( ) => { this.restore(); }, BOOT_WINDOW_MS);
    }

    stayRelaxed() {
        this.permanent = true;
        clearTimeout(this.timer);
        this.timer = null;
        this.relax();
    }

    endBoot() {
        if ( this.permanent === false ) {
            this.restore();
        }
    }

    relax() {
        const branch = Services.prefs.getDefaultBranch('');
        if ( this.saved === undefined ) {
            try {
                this.saved = branch.getIntPref(SLOW_SCRIPT_PREF);
            } catch (ex) {
                this.saved = null;
            }
            if ( Services.prefs.prefHasUserValue(SLOW_SCRIPT_PREF) ) {
                logMessage(`${SLOW_SCRIPT_PREF} is set by the user, uBO may be stopped while it loads filters`);
            }
        }
        branch.setIntPref(SLOW_SCRIPT_PREF, BOOT_SCRIPT_RUN_TIME);
    }

    restore() {
        clearTimeout(this.timer);
        this.timer = null;
        if ( this.saved === undefined ) { return; }
        // 10 s is Gecko's fallback when the pref has no default value.
        Services.prefs.getDefaultBranch('').setIntPref(
            SLOW_SCRIPT_PREF,
            this.saved !== null ? this.saved : 10
        );
        this.saved = undefined;
    }
};

/******************************************************************************/

// moz-extension: for this extension, served the way Firefox serves it.
//
// UXP's moz-extension: handler substitutes the package's jar:file: URL, and
// its channels report that jar:file: URI. UXP's script loader takes a
// module's base URL from it (Firefox reports the moz-extension: URL there;
// UXP does so for resource: only), so every `import` resolved to a jar:file:
// URL, and a module which a page both loads with <script type="module"> and
// imports -- every uBO page does so with i18n.js -- ran twice, once per URL.
// This handler stands in for UXP's for the session (UXP's is restored at
// shutdown): our own files stream through channels which keep their
// moz-extension: URL, CSS localized as by Firefox. URL parsing, other
// extensions' URLs and substitutions remain UXP's handler's. Which files
// web pages may load (web_accessible_resources): see WebAccessiblePolicy.

const MOZ_EXTENSION_CONTRACT = '@mozilla.org/network/protocol;1?name=moz-extension';

const MIME_TYPES = new Map([
    [ 'css', 'text/css' ],
    [ 'dat', 'text/plain' ],
    [ 'gif', 'image/gif' ],
    [ 'html', 'text/html' ],
    [ 'ico', 'image/x-icon' ],
    [ 'jpg', 'image/jpeg' ],
    [ 'js', 'application/javascript' ],
    [ 'json', 'application/json' ],
    [ 'md', 'text/plain' ],
    [ 'png', 'image/png' ],
    [ 'svg', 'image/svg+xml' ],
    [ 'ttf', 'font/ttf' ],
    [ 'txt', 'text/plain' ],
    [ 'wasm', 'application/wasm' ],
    [ 'woff', 'font/woff' ],
    [ 'woff2', 'font/woff2' ],
    [ 'xml', 'text/xml' ],
]);
const TEXT_TYPE = /^(?:text\/|application\/(?:javascript|json)$|image\/svg)/;

const ExtensionProtocol = class {
    constructor(extension) {
        this.extension = extension;
        this.registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
        this.classID = Components.ID(Cc['@mozilla.org/uuid-generator;1']
            .getService(Ci.nsIUUIDGenerator)
            .generateUUID().toString());
        this.originalClassID = null;
        this.original = null;
        this.QueryInterface = XPCOMUtils.generateQI([
            Ci.nsIProtocolHandler,
            Ci.nsISubstitutingProtocolHandler,
            Ci.nsIFactory,
        ]);
    }

    register() {
        this.original = Services.io.getProtocolHandler('moz-extension')
            .QueryInterface(Ci.nsISubstitutingProtocolHandler);
        this.original.setSubstitution(this.extension.uuid, this.extension.rootURI);
        this.originalClassID = this.registrar.contractIDToCID(MOZ_EXTENSION_CONTRACT);
        this.registrar.registerFactory(
            this.classID,
            'uBlock0 moz-extension protocol',
            MOZ_EXTENSION_CONTRACT,
            this
        );
    }

    unregister() {
        this.registrar.registerFactory(this.originalClassID, '', MOZ_EXTENSION_CONTRACT, null);
        this.registrar.unregisterFactory(this.classID, this);
        this.original.setSubstitution(this.extension.uuid, null);
    }

    // nsIFactory
    createInstance(outer, iid) {
        if ( outer !== null ) { throw Components.Exception('', Cr.NS_ERROR_NO_AGGREGATION); }
        return this.QueryInterface(iid);
    }

    lockFactory() {
    }

    // nsIProtocolHandler
    get scheme() {
        return 'moz-extension';
    }

    get defaultPort() {
        return this.original.defaultPort;
    }

    // Static: UXP takes per-URL flags from native handlers only. As in
    // Firefox for web-accessible resources, loadable and fetchable by
    // anyone; WebAccessiblePolicy restricts the other files.
    get protocolFlags() {
        const p = Ci.nsIProtocolHandler;
        return p.URI_STD | p.URI_IS_LOCAL_RESOURCE |
            p.URI_LOADABLE_BY_ANYONE | (p.URI_FETCHABLE_BY_ANYONE || 0);
    }

    allowPort(port, scheme) {
        return this.original.allowPort(port, scheme);
    }

    newURI(spec, charset, baseURI) {
        return this.original.newURI(spec, charset, baseURI);
    }

    newChannel(uri) {
        return this.newChannel2(uri, null);
    }

    newChannel2(uri, loadInfo) {
        if ( uri.host !== this.extension.uuid ) {
            return this.original.newChannel2(uri, loadInfo);
        }
        const filePath = uri.QueryInterface(Ci.nsIURL).filePath;
        const source = NetUtil.newChannel({
            uri: Services.io.newURI(filePath.slice(1), null, this.extension.rootURI),
            loadUsingSystemPrincipal: true,
        });
        const match = /\.([a-z0-9]+)$/i.exec(filePath);
        const type = match !== null && MIME_TYPES.get(match[1].toLowerCase()) ||
            'application/octet-stream';
        let stream;
        try {
            stream = source.open2();
        } catch (ex) {
            // A file not in the package (uBO looks for optional ones): the
            // load fails, as with UXP's handler, without a script error.
            Components.returnCode = ex.result || Cr.NS_ERROR_FILE_NOT_FOUND;
            return null;
        }
        if ( type === 'text/css' ) {
            stream = this.localizedStream(stream);
        }
        const channel = Cc['@mozilla.org/network/input-stream-channel;1']
            .createInstance(Ci.nsIInputStreamChannel);
        channel.setURI(uri);
        channel.contentStream = stream;
        const result = channel.QueryInterface(Ci.nsIChannel);
        if ( loadInfo !== null ) {
            result.loadInfo = loadInfo;
        }
        result.contentType = type;
        if ( TEXT_TYPE.test(type) ) {
            result.contentCharset = 'UTF-8';
        }
        return result;
    }

    // __MSG_name__ in style sheets, as Firefox localizes them.
    localizedStream(stream) {
        let text;
        try {
            text = NetUtil.readInputStreamToString(stream, stream.available(), { charset: 'UTF-8' });
        } finally {
            stream.close();
        }
        const bytes = unescape(encodeURIComponent(this.extension.localizeString(text)));
        const out = Cc['@mozilla.org/io/string-input-stream;1']
            .createInstance(Ci.nsIStringInputStream);
        out.setData(bytes, bytes.length);
        return out;
    }

    // nsISubstitutingProtocolHandler
    setSubstitution(root, baseURI) {
        this.original.setSubstitution(root, baseURI);
    }

    getSubstitution(root) {
        return this.original.getSubstitution(root);
    }

    hasSubstitution(root) {
        return this.original.hasSubstitution(root);
    }

    resolveURI(uri) {
        return this.original.resolveURI(uri);
    }
};

/******************************************************************************/

// Which of the extension's files others may load: web_accessible_resources
// only, as in Firefox (where the protocol handler's per-URL flags say so).
// The browser, the extension's pages and its content scripts may load any.

const WebAccessiblePolicy = class {
    constructor(extension) {
        this.extension = extension;
        this.registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
        this.categories = Cc['@mozilla.org/categorymanager;1'].getService(Ci.nsICategoryManager);
        this.classID = Components.ID(Cc['@mozilla.org/uuid-generator;1']
            .getService(Ci.nsIUUIDGenerator)
            .generateUUID().toString());
        this.contractID = '@ublock0.uxp/web-accessible-policy;1';
        this.QueryInterface = XPCOMUtils.generateQI([ Ci.nsIContentPolicy, Ci.nsIFactory ]);
    }

    register() {
        this.registrar.registerFactory(
            this.classID,
            'uBlock0 web-accessible resources',
            this.contractID,
            this
        );
        this.categories.addCategoryEntry('content-policy', this.contractID, this.contractID, false, true);
    }

    unregister() {
        this.categories.deleteCategoryEntry('content-policy', this.contractID, false);
        this.registrar.unregisterFactory(this.classID, this);
    }

    // nsIFactory
    createInstance(outer, iid) {
        if ( outer !== null ) { throw Components.Exception('', Cr.NS_ERROR_NO_AGGREGATION); }
        return this.QueryInterface(iid);
    }

    lockFactory() {
    }

    // A content script's expanded principal includes the extension's.
    isPrivileged(requestOrigin, principal) {
        const { origin } = this.extension;
        if ( principal ) {
            if ( Services.scriptSecurityManager.isSystemPrincipal(principal) ) { return true; }
            const requester = principal.originNoSuffix;
            return requester === origin ||
                requester.startsWith('[Expanded Principal') && requester.includes(origin);
        }
        return !requestOrigin || requestOrigin.prePath === origin;
    }

    // nsIContentPolicy
    shouldLoad(contentType, location, requestOrigin, context, mimeTypeGuess, extra, requestPrincipal) {
        const { ACCEPT, REJECT_REQUEST } = Ci.nsIContentPolicy;
        if ( location.schemeIs('moz-extension') === false ) { return ACCEPT; }
        if ( location.host !== this.extension.uuid ) { return ACCEPT; }
        if ( this.extension.webAccessible.matches(location.spec) ) { return ACCEPT; }
        return this.isPrivileged(requestOrigin, requestPrincipal) ? ACCEPT : REJECT_REQUEST;
    }

    shouldProcess() {
        return Ci.nsIContentPolicy.ACCEPT;
    }
};

/******************************************************************************/

// The background page lives in a windowless browser, inside a content
// frame -- the same arrangement Firefox uses for WebExtension background
// pages.

const BackgroundPage = class {
    constructor(extension) {
        this.extension = extension;
        this.windowless = null;
        this.progressListener = null;
        this.frame = null;
        this.stopped = false;
    }

    get window() {
        return this.frame !== null ? this.frame.contentWindow : null;
    }

    get innerWindowID() {
        const own = this.window;
        if ( own === null ) { return 0; }
        try {
            return windowUtilsOf(own).currentInnerWindowID;
        } catch (ex) {
        }
        return 0;
    }

    isWindow(win) {
        const own = this.window;
        if ( own === null || win === null ) { return false; }
        const id = outerWindowIdOf(own);
        return id !== 0 && id === outerWindowIdOf(win);
    }

    async start() {
        const ready = await whenHiddenWindowReady(( ) => this.stopped);
        if ( ready === false ) { return; }
        this.windowless = appShell.createWindowlessBrowser(true);
        await this.loadHostDocument();
        if ( this.stopped ) { return; }
        const doc = this.windowless.document;
        const frame = doc.createElementNS(XUL_NS, 'iframe');
        frame.setAttribute('type', 'content');
        frame.setAttribute('disablehistory', 'true');
        frame.setAttribute('src', this.extension.getURL(this.extension.manifest.background.page));
        this.frame = frame;
        doc.documentElement.appendChild(frame);
    }

    loadHostDocument() {
        return new Promise(resolve => {
            this.windowless.QueryInterface(Ci.nsIInterfaceRequestor);
            const webProgress = this.windowless.getInterface(Ci.nsIWebProgress);
            // Held here: web progress listeners are referenced weakly.
            this.progressListener = {
                QueryInterface: XPCOMUtils.generateQI([
                    Ci.nsIWebProgressListener,
                    Ci.nsISupportsWeakReference,
                ]),
                onStateChange: (progress, request, flags) => {
                    if ( !request ) { return; }
                    if ( (flags & Ci.nsIWebProgressListener.STATE_STOP) === 0 ) { return; }
                    webProgress.removeProgressListener(this.progressListener);
                    this.progressListener = null;
                    resolve();
                },
                onLocationChange() {},
                onProgressChange() {},
                onStatusChange() {},
                onSecurityChange() {},
            };
            webProgress.addProgressListener(
                this.progressListener,
                Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT
            );
            this.windowless.document.location =
                `data:application/vnd.mozilla.xul+xml;charset=utf-8,<window id='${this.extension.uuid}'/>`;
        });
    }

    stop() {
        this.stopped = true;
        this.frame = null;
        this.progressListener = null;
        if ( this.windowless !== null ) {
            this.windowless.close();
            this.windowless = null;
        }
    }
};

/******************************************************************************/

var Extension = class {
    constructor(data, reason, hooks) {
        this.id = data.id;
        this.version = data.version;
        this.rootURI = data.resourceURI;
        this.startupReason = reason;
        this.previousVersion = data.oldVersion;
        this.hooks = hooks;
        this.uuid = '';
        this.baseURI = null;
        this.origin = '';
        this.manifest = null;
        this.manifestLocalized = undefined;
        this.locales = null;
        this.hostPermissions = null;
        this.webAccessible = null;
        this.contexts = new Map();
        this.shutdownCallbacks = [];
        this.background = null;
        this.backgroundLoads = 0;
        this.backgroundRestarts = [];
        this.slowScriptLimit = new SlowScriptLimit();
        this.coreAPIs = null;
        this.apiModules = [];
        this.tabTracker = null;
        this.webRequest = null;
        this.messaging = null;
        this.shutdownStarted = false;
        this.consoleListener = {
            observe: message => { this.onConsoleMessage(message); },
            QueryInterface: XPCOMUtils.generateQI([ Ci.nsIConsoleListener ]),
        };
    }

    async startup() {
        this.manifest = JSON.parse(this.readPackageFile('manifest.json'));
        this.locales = this.loadLocales();
        this.uuid = uuidForExtension();
        this.baseURI = Services.io.newURI(`moz-extension://${this.uuid}/`, null, null);
        this.origin = `moz-extension://${this.uuid}`;
        this.hostPermissions = new MatchPattern(
            (this.manifest.permissions || []).filter(p => p === '<all_urls>' || p.includes('://'))
        );
        this.webAccessible = new MatchPattern(
            (this.manifest.web_accessible_resources || []).map(path =>
                `${this.origin}/${path.replace(/^\//, '')}`
            )
        );
        this.registerOrigin();
        // Created in dependency order (webRequest uses the tab tracker,
        // content scripts the tab tracker and messaging, the browser UI the
        // tab tracker); merged core first, so implementations override its
        // placeholders.
        const tabs = createTabsAPIs(this);
        const webRequest = createWebRequestAPIs(this);
        this.coreAPIs = createCoreAPIs(this);
        const content = createContentAPIs(this);
        const ui = createUIAPIs(this);
        this.apiModules = [ this.coreAPIs, tabs, webRequest, content, ui ];
        Services.obs.addObserver(this, 'document-element-inserted', false);
        Services.obs.addObserver(this, 'inner-window-destroyed', false);
        Services.console.registerListener(this.consoleListener);
        await this.startBackground();
    }

    shutdown() {
        if ( this.shutdownStarted ) { return; }
        this.shutdownStarted = true;
        Services.obs.removeObserver(this, 'document-element-inserted');
        Services.obs.removeObserver(this, 'inner-window-destroyed');
        Services.console.unregisterListener(this.consoleListener);
        this.slowScriptLimit.restore();
        for ( const context of Array.from(this.contexts.values()) ) {
            context.unload();
        }
        this.contexts.clear();
        if ( this.background !== null ) {
            this.background.stop();
            this.background = null;
        }
        for ( const callback of this.shutdownCallbacks.reverse() ) {
            try {
                callback();
            } catch (ex) {
                Cu.reportError(ex);
            }
        }
        this.shutdownCallbacks = [];
    }

    onShutdown(callback) {
        this.shutdownCallbacks.push(callback);
    }

    /**************************************************************************/

    // See SlowScriptLimit.

    startBackground() {
        this.slowScriptLimit.relaxForBoot();
        this.webRequest.startPriming();
        this.background = new BackgroundPage(this);
        return this.background.start();
    }

    // uBO calls webRequest.handlerBehaviorChanged() right after it has
    // (re)built its filtering engines.
    onFiltersReady() {
        this.slowScriptLimit.endBoot();
    }

    onConsoleMessage(message) {
        if ( message instanceof Ci.nsIScriptError === false ) { return; }
        if ( /^(?:Error: )?Script terminated by timeout/.test(message.errorMessage) === false ) { return; }
        if ( this.background === null || message.innerWindowID === 0 ) { return; }
        if ( message.innerWindowID !== this.background.innerWindowID ) { return; }
        dispatch(( ) => { this.restartBackground(); });
    }

    restartBackground() {
        if ( this.shutdownStarted || this.background === null ) { return; }
        const now = Date.now();
        this.backgroundRestarts = this.backgroundRestarts.filter(t => now - t < RESTART_PERIOD_MS);
        this.backgroundRestarts.push(now);
        const count = this.backgroundRestarts.length;
        if ( count > 2 * RESTARTS_BEFORE_STAYING_RELAXED ) {
            logMessage(`the background page keeps being stopped (${SLOW_SCRIPT_PREF}); not restarting it again`);
            return;
        }
        if ( count >= RESTARTS_BEFORE_STAYING_RELAXED ) {
            this.slowScriptLimit.stayRelaxed();
        }
        logMessage(`the background page ran past ${SLOW_SCRIPT_PREF} and was stopped; restarting it`);
        this.background.stop();
        this.startBackground().catch(reason => { Cu.reportError(reason); });
    }

    reload() {
        this.hooks.reload();
    }

    /**************************************************************************/

    registerOrigin() {
        const protocol = new ExtensionProtocol(this);
        protocol.register();
        const webAccessiblePolicy = new WebAccessiblePolicy(this);
        webAccessiblePolicy.register();

        const policy = Cc['@mozilla.org/addons/policy-service;1']
            .getService(Ci.nsIAddonPolicyService).wrappedJSObject;
        // Global callbacks: chain to whatever was registered before.
        const ownHost = uri => uri.host === this.uuid;
        const previousAddonId = policy.setExtensionURIToAddonIdCallback(uri => {
            if ( ownHost(uri) ) { return this.id; }
            return previousAddonId ? previousAddonId(uri) : '';
        });
        const previousLoadable = policy.setExtensionURILoadCallback(uri => {
            if ( ownHost(uri) ) { return this.webAccessible.matches(uri.spec); }
            return previousLoadable ? previousLoadable(uri) : false;
        });
        // Per add-on callbacks. Host permissions never cover file: URLs (as in
        // Firefox).
        policy.setAddonLoadURICallback(this.id, uri => {
            if ( uri.schemeIs('file') ) { return false; }
            return this.hostPermissions.matches(uri.spec);
        });
        policy.setAddonHasPermissionCallback(this.id, permission =>
            (this.manifest.permissions || []).includes(permission)
        );
        policy.setAddonLocalizeCallback(this.id, s => this.localizeString(s));

        this.onShutdown(( ) => {
            policy.setExtensionURIToAddonIdCallback(previousAddonId);
            policy.setExtensionURILoadCallback(previousLoadable);
            policy.setAddonLoadURICallback(this.id, null);
            policy.setAddonHasPermissionCallback(this.id, null);
            policy.setAddonLocalizeCallback(this.id, null);
            webAccessiblePolicy.unregister();
            protocol.unregister();
        });
    }

    getURL(path = '') {
        return this.baseURI.resolve(String(path));
    }

    isOwnURL(url) {
        return typeof url === 'string' && url.startsWith(`${this.origin}/`);
    }

    readPackageFile(path) {
        const uri = Services.io.newURI(path, null, this.rootURI);
        const channel = NetUtil.newChannel({ uri, loadUsingSystemPrincipal: true });
        const stream = typeof channel.open2 === 'function' ? channel.open2() : channel.open();
        try {
            return NetUtil.readInputStreamToString(stream, stream.available(), { charset: 'UTF-8' });
        } finally {
            stream.close();
        }
    }

    /**************************************************************************/

    // _locales/<locale>/messages.json, Chrome/Firefox lookup rules: the UI
    // locale with its region, then without, then default_locale.

    loadLocales() {
        const uiLocale = getUILocale();
        const defaultLocale = this.manifest.default_locale || 'en';
        const [ language, region ] = uiLocale.split(/[-_]/);
        const candidates = region !== undefined
            ? [ `${language}_${region.toUpperCase()}`, language ]
            : [ language ];
        let selected = defaultLocale;
        let messages = null;
        for ( const candidate of candidates ) {
            messages = this.readLocale(candidate);
            if ( messages !== null ) {
                selected = candidate;
                break;
            }
        }
        const defaults = this.readLocale(defaultLocale) || new Map();
        return {
            uiLocale,
            selected,
            rtl: RTL_LANGUAGES.has(language),
            messages: messages || defaults,
            defaults,
        };
    }

    readLocale(locale) {
        let json;
        try {
            json = JSON.parse(this.readPackageFile(`_locales/${locale}/messages.json`));
        } catch (ex) {
            return null;
        }
        const out = new Map();
        for ( const [ key, entry ] of Object.entries(json) ) {
            let message = entry.message;
            if ( entry.placeholders instanceof Object ) {
                const placeholders = new Map();
                for ( const [ name, placeholder ] of Object.entries(entry.placeholders) ) {
                    placeholders.set(name.toLowerCase(), placeholder.content);
                }
                message = message.replace(/\$([A-Za-z0-9@_]+)\$/g, (match, name) => {
                    const content = placeholders.get(name.toLowerCase());
                    return content !== undefined ? content : match;
                });
            }
            out.set(key.toLowerCase(), message);
        }
        return out;
    }

    localize(name, substitutions) {
        const key = String(name).toLowerCase();
        const { rtl } = this.locales;
        switch ( key ) {
        case '@@ui_locale': return this.locales.uiLocale.replace(/-/g, '_');
        case '@@bidi_dir': return rtl ? 'rtl' : 'ltr';
        case '@@bidi_reversed_dir': return rtl ? 'ltr' : 'rtl';
        case '@@bidi_start_edge': return rtl ? 'right' : 'left';
        case '@@bidi_end_edge': return rtl ? 'left' : 'right';
        case '@@extension_id': return this.uuid;
        }
        let message = this.locales.messages.get(key);
        if ( message === undefined ) {
            message = this.locales.defaults.get(key);
        }
        if ( message === undefined ) { return ''; }
        const values = substitutions === undefined || substitutions === null
            ? []
            : [].concat(substitutions).map(String);
        // $1..$n are substitutions; in a run of `$`, the first one is dropped.
        return message.replace(/\$(?:([1-9]\d*)|(\$+))/g, (match, index, dollars) => {
            if ( index === undefined ) { return dollars; }
            const i = parseInt(index, 10) - 1;
            return i < values.length ? values[i] : '';
        });
    }

    localizeString(s) {
        return String(s).replace(/__MSG_([A-Za-z0-9@_]+?)__/g, (match, name) =>
            this.localize(name)
        );
    }

    localizedManifest() {
        if ( this.manifestLocalized === undefined ) {
            this.manifestLocalized = JSON.parse(this.localizeString(JSON.stringify(this.manifest)));
        }
        return this.manifestLocalized;
    }

    /**************************************************************************/

    // The API modules' trees merged into one; a later module's members
    // replace an earlier one's. Namespaces are the plain objects: API
    // members are EventManagers, PageValues, or tagged with a symbol.
    // Content scripts get the trees of the modules with a buildContent().
    buildAPI(context) {
        const builder = context.isContentScript ? 'buildContent' : 'build';
        const isNamespace = v => v !== null && typeof v === 'object' &&
            Array.isArray(v) === false &&
            v instanceof EventManager === false &&
            v instanceof PageValue === false &&
            Object.getOwnPropertySymbols(v).length === 0;
        const merge = (target, source) => {
            for ( const [ key, value ] of Object.entries(source) ) {
                if ( isNamespace(value) && isNamespace(target[key]) ) {
                    target[key] = merge(Object.assign({}, target[key]), value);
                } else {
                    target[key] = value;
                }
            }
            return target;
        };
        return this.apiModules
            .filter(module => typeof module[builder] === 'function')
            .reduce((tree, module) => merge(tree, module[builder](context)), {});
    }

    // Extension pages get the API before any of their scripts runs.

    observe(subject, topic, data) {
        switch ( topic ) {
        case 'document-element-inserted':
            this.onDocumentElementInserted(subject);
            break;
        case 'inner-window-destroyed':
            this.unloadContext(subject.QueryInterface(Ci.nsISupportsPRUint64).data);
            break;
        default:
            break;
        }
    }

    onDocumentElementInserted(doc) {
        const win = doc.defaultView;
        if ( win === null ) { return; }
        if ( this.isOwnURL(doc.documentURI) === false ) { return; }
        if ( doc.nodePrincipal.originNoSuffix !== this.origin ) { return; }
        const viewType = this.background !== null && this.background.isWindow(win)
            ? 'background'
            : 'tab';
        const context = new Context(this, win, viewType);
        this.contexts.set(context.innerWindowID, context);
        // An unload listener also keeps the page out of the bfcache, so a
        // context is never left half-alive behind a navigation.
        win.addEventListener('unload', ( ) => {
            this.unloadContext(context.innerWindowID);
        }, { once: true });
        try {
            injectAPI(context, this.buildAPI(context));
        } catch (ex) {
            Cu.reportError(ex);
            return;
        }
        // runtime.onInstalled/onStartup: once, not again after a restart.
        if ( viewType === 'background' && this.backgroundLoads++ === 0 ) {
            win.addEventListener('load', ( ) => {
                this.coreAPIs.onBackgroundLoaded(this.startupReason);
            }, { once: true });
        }
    }

    unloadContext(innerWindowID) {
        const context = this.contexts.get(innerWindowID);
        if ( context === undefined ) { return; }
        this.contexts.delete(innerWindowID);
        context.unload();
    }
};

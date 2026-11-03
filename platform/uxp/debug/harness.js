/*******************************************************************************

    uBlock Origin for UXP - debug harness
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

// Shipped only in debug builds (tools/make-uxp.mjs --debug). Driven by prefs
// under extensions.ublock0.uxpTest., which tools/uxp-test.mjs writes into a
// throwaway profile:
//   scenario  ''         mirror the console to <profile>/uxp-test/console.log
//             'probe'    also probe the platform
//             'boot'     ... check that uBO boots completely
//             'network'  ... check network filtering, from browser launch on
//             'cosmetic' ... check cosmetic filters, scriptlets, and the
//                        content-script APIs
//             'ui'       ... check the toolbar button, popup, context menu
//                        and keyboard shortcuts
//             'filtering' ... check what only Firefox gives uBO: HTML
//                        filtering and replace=, CNAME uncloaking, redirect=
//                        and web-accessible resources, csp=, permissions=,
//                        header=, strict blocking, privacy settings
//             'uninstall' ... remove the add-on, check what it left behind
//             'uninstall-disabled' ... the same, disabling it first
//             'update'   ... check what this browser's update checker makes
//                        of the release's update manifest
//                        (updateManifest, updateExpected)
//             'stop-busy' ... disable the add-on while pages load, while
//                        it boots and while it filters; re-enable it
//                        (keepConsoleLog: the next instance appends)
//             and write <scenario>.json
//   autoQuit  true    quit the application once the scenario is done
// Without autoQuit, a manually installed debug build never quits the browser.

/* global indexedDB */
/* exported harness */

'use strict';

// `var` so that loadSubScript() exposes it to bootstrap.js.
var harness = (( ) => {

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;
const { Services } = Cu.import('resource://gre/modules/Services.jsm', {});
const { XPCOMUtils } = Cu.import('resource://gre/modules/XPCOMUtils.jsm', {});
const { NetUtil } = Cu.import('resource://gre/modules/NetUtil.jsm', {});
const { setTimeout, clearTimeout } = Cu.import('resource://gre/modules/Timer.jsm', {});

Cu.importGlobalProperties([ 'indexedDB' ]);

const prefs = Services.prefs.getBranch('extensions.ublock0.uxpTest.');
const appShell = Cc['@mozilla.org/appshell/appShellService;1']
    .getService(Ci.nsIAppShellService);

const SCENARIO_TIMEOUT = 240000;
const PREF_MANAGED_STORAGE = 'extensions.ublock0.managedStorage';
// Module scripts report their resolved jar:file: URL, not the chrome:// one.
const OWN_SOURCES = /^(?:chrome:\/\/ublock0\/|moz-extension:\/\/|resource:\/\/ublock0-probe\/|jar:file:.+\.xpi!\/)/;

let addonData = null;
let outDir = null;
let host = null;
let extension = null;
const consoleLines = [];

/******************************************************************************/

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

const getPref = function(name, fallback) {
    try {
        switch ( prefs.getPrefType(name) ) {
        case prefs.PREF_BOOL: return prefs.getBoolPref(name);
        case prefs.PREF_INT: return prefs.getIntPref(name);
        case prefs.PREF_STRING: return prefs.getCharPref(name);
        }
    } catch {
    }
    return fallback;
};

const readAnyPref = function(name) {
    try {
        switch ( Services.prefs.getPrefType(name) ) {
        case Services.prefs.PREF_BOOL: return Services.prefs.getBoolPref(name);
        case Services.prefs.PREF_INT: return Services.prefs.getIntPref(name);
        case Services.prefs.PREF_STRING: return Services.prefs.getCharPref(name);
        }
    } catch {
    }
    return null;
};

// The browser's own value, without the user's; null if it has none.
const readDefaultPref = function(name) {
    const branch = Services.prefs.getDefaultBranch('');
    try {
        switch ( branch.getPrefType(name) ) {
        case branch.PREF_BOOL: return branch.getBoolPref(name);
        case branch.PREF_INT: return branch.getIntPref(name);
        case branch.PREF_STRING: return branch.getCharPref(name);
        }
    } catch {
    }
    return null;
};

const writeText = function(name, text, append = false) {
    const file = outDir.clone();
    file.append(name);
    const stream = Cc['@mozilla.org/network/file-output-stream;1']
        .createInstance(Ci.nsIFileOutputStream);
    // PR_WRONLY | PR_CREATE_FILE | (PR_APPEND or PR_TRUNCATE)
    stream.init(file, 0x02 | 0x08 | (append ? 0x10 : 0x20), 0o644, 0);
    const converter = Cc['@mozilla.org/intl/converter-output-stream;1']
        .createInstance(Ci.nsIConverterOutputStream);
    converter.init(stream, 'UTF-8', 0, 0);
    converter.writeString(text);
    converter.close();
};

// A local file's bytes, as a binary string (a TestServer body).
const readBytes = function(filePath) {
    const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
    file.initWithPath(filePath);
    const stream = Cc['@mozilla.org/network/file-input-stream;1']
        .createInstance(Ci.nsIFileInputStream);
    stream.init(file, 0x01, 0, 0); // PR_RDONLY
    try {
        return NetUtil.readInputStreamToString(stream, stream.available());
    } finally {
        stream.close();
    }
};

/******************************************************************************/

// Console mirroring: nsIConsoleService carries script errors and warnings,
// the console API (console.log() & co.) is a separate observer topic.

const record = function(kind, text, source = '', keep = true) {
    if ( keep ) {
        consoleLines.push({ kind, text, source });
    }
    const time = new Date().toISOString().slice(11, 23);
    const where = source !== '' ? ` @ ${source}` : '';
    try {
        writeText('console.log', `${time} [${kind}] ${text}${where}\n`, true);
    } catch {
    }
};

const log = function(text) {
    record('harness', text);
};

const recordConsoleMessage = function(message, keep = true) {
    if ( message instanceof Ci.nsIScriptError ) {
        const flags = message.flags;
        const kind = (flags & Ci.nsIScriptError.warningFlag) !== 0
            ? 'warn'
            : (flags & Ci.nsIScriptError.infoFlag) !== 0 ? 'info' : 'error';
        const source = message.sourceName
            ? `${message.sourceName}:${message.lineNumber}:${message.columnNumber}`
            : '';
        record(kind, `${message.errorMessage} [${message.category}]`, source, keep);
        return;
    }
    record('message', message.message, '', keep);
};

const consoleListener = {
    observe(message) {
        recordConsoleMessage(message);
    },
    QueryInterface: XPCOMUtils.generateQI([ Ci.nsIConsoleListener ]),
};

const stringify = function(value) {
    if ( typeof value === 'string' ) { return value; }
    if ( value && typeof value.message === 'string' && typeof value.stack === 'string' ) {
        return `${value.name}: ${value.message}`;
    }
    try {
        const json = JSON.stringify(value);
        if ( json !== undefined ) { return json; }
    } catch {
    }
    return String(value);
};

const consoleAPIObserver = {
    observe(subject) {
        const event = subject.wrappedJSObject;
        const text = Array.from(event.arguments || [], stringify).join(' ');
        const source = event.filename ? `${event.filename}:${event.lineNumber}` : '';
        record(`console.${event.level}`, text, source);
    },
};

/******************************************************************************/

// Probe tables. Each entry is an expression that is truthy when supported.

const has = path => `typeof ${path} !== 'undefined'`;

// Parsed with new Function(), never executed.
const SYNTAX_PROBES = {
    'optional chaining': 'a?.b',
    'nullish coalescing': 'a ?? b',
    'logical assignment': 'a ||= b; a &&= b; a ??= b',
    'numeric separators': '1_000',
    'BigInt literal': '1n',
    'optional catch binding': 'try {} catch {}',
    'object rest/spread': 'const { a, ...r } = { ...b }',
    'async iteration': 'async function f() { for await (const x of y) {} }',
    'async generator': 'async function* g() {}',
    'dynamic import()': 'import("./x.js")',
    'class public fields': 'class A { x = 1; static y = 2; }',
    'class private fields': 'class A { #x = 1; m() { return this.#x; } }',
    'class private methods': 'class A { #m() {} n() { this.#m(); } }',
    'class static block': 'class A { static { } }',
    'private brand check': 'class A { #x; static h(o) { return #x in o; } }',
    'regex named groups': '/(?<y>a)/',
    'regex lookbehind': '/(?<=a)b/',
    'regex dotAll flag': '/./s',
    'regex unicode property escapes': '/\\p{L}/u',
    'regex d flag': '/a/d',
    'regex v flag': '/[\\p{L}--[a-z]]/v',
};

const BUILTIN_PROBES = Object.fromEntries([
    'globalThis', 'Array.prototype.at', 'Array.prototype.flat',
    'Array.prototype.findLast', 'Array.prototype.toSorted',
    'Array.prototype.with', 'Array.fromAsync', 'Object.fromEntries',
    'Object.hasOwn', 'Object.groupBy', 'Map.groupBy',
    'String.prototype.replaceAll', 'String.prototype.at',
    'String.prototype.matchAll', 'String.prototype.isWellFormed',
    'Promise.allSettled', 'Promise.any', 'Promise.withResolvers',
    'AggregateError', 'WeakRef', 'FinalizationRegistry',
    'Set.prototype.union', 'Iterator.prototype.map', 'structuredClone',
    'queueMicrotask', 'Intl.Segmenter', 'Intl.ListFormat',
    'Intl.RelativeTimeFormat', 'Intl.DisplayNames', 'Intl.Locale', 'BigInt',
    'WebAssembly', 'Symbol.asyncIterator',
].map(path => [ path, has(path) ]).concat([
    [ 'Error cause', `new Error('', { cause: 1 }).cause === 1` ],
]));

const DOM_PROBES = Object.fromEntries([
    'fetch', 'AbortController', 'AbortSignal.timeout', 'AbortSignal.any',
    'TextEncoder', 'TextDecoder', 'TextDecoderStream', 'CompressionStream',
    'DecompressionStream', 'ReadableStream', 'WritableStream',
    'TransformStream', 'Blob.prototype.text', 'Blob.prototype.arrayBuffer',
    'URL', 'URL.canParse', 'URLSearchParams', 'crypto.getRandomValues',
    'crypto.randomUUID', 'crypto.subtle', 'indexedDB', 'Worker',
    'SharedWorker', 'WebAssembly.instantiateStreaming',
    'requestIdleCallback', 'IntersectionObserver', 'ResizeObserver',
    'MutationObserver', 'BroadcastChannel', 'CSS.supports', 'CSS.escape',
    'Element.prototype.attachShadow', 'Element.prototype.closest',
    'Element.prototype.toggleAttribute', 'Element.prototype.replaceChildren',
    'Element.prototype.checkVisibility', 'Element.prototype.getAnimations',
    'HTMLDialogElement', 'HTMLTemplateElement', 'navigator.clipboard',
    'navigator.locks', 'CSSStyleSheet',
].map(path => [ path, has(path) ]).concat([
    [ 'adoptedStyleSheets', `'adoptedStyleSheets' in Document.prototype` ],
    [ 'module scripts', `'noModule' in HTMLScriptElement.prototype` ],
    [ 'selector :has()', `CSS.supports('selector(a:has(b))')` ],
    [ 'selector :is()', `CSS.supports('selector(:is(a))')` ],
    [ 'selector :where()', `CSS.supports('selector(:where(a))')` ],
    [ 'CSS nesting', `CSS.supports('selector(&)')` ],
    [ 'CSS color-mix()', `CSS.supports('color', 'color-mix(in srgb, red, blue)')` ],
    [ 'display: contents', `CSS.supports('display', 'contents')` ],
]));

const XPCOM_INTERFACES = [
    'nsITraceableChannel', 'nsIHttpChannel', 'nsIHttpChannelInternal',
    'nsIProxiedChannel', 'nsIUploadChannel2', 'nsILoadInfo', 'nsILoadContext',
    'nsIChannelEventSink', 'nsIClassifiedChannel', 'nsIDNSService',
    'nsIDNSRecord', 'nsIContentPolicy', 'nsIWebProgressListener',
    'nsIWebNavigation', 'nsIWindowlessBrowser', 'nsIStyleSheetService',
    'nsIDOMWindowUtils', 'nsIMessageListenerManager', 'nsIFrameScriptLoader',
    'nsIProcessScriptLoader', 'nsIProtocolHandler',
    'nsISubstitutingProtocolHandler', 'nsIResProtocolHandler',
    'nsIAddonPolicyService', 'nsIStreamListenerTee', 'nsIStorageStream',
    'mozIStorageService', 'nsIEffectiveTLDService', 'nsIIDNService',
    'nsIUUIDGenerator', 'nsICryptoHash', 'nsIXULStore',
    'nsIScriptSecurityManager', 'nsIContentSecurityPolicy',
    'nsIEventListenerService', 'nsIWebRequestListener',
];

const XPCOM_CONSTANTS = [
    'nsIDNSService.RESOLVE_CANONICAL_NAME',
    'nsIContentPolicy.TYPE_FETCH', 'nsIContentPolicy.TYPE_BEACON',
    'nsIContentPolicy.TYPE_WEBSOCKET', 'nsIContentPolicy.TYPE_IMAGESET',
    'nsIContentPolicy.TYPE_WEB_MANIFEST', 'nsIContentPolicy.TYPE_MEDIA',
    'nsIContentPolicy.TYPE_FONT', 'nsIContentPolicy.TYPE_PING',
    'nsIContentPolicy.TYPE_CSP_REPORT', 'nsIContentPolicy.TYPE_SAVEAS_DOWNLOAD',
    'nsIDOMWindowUtils.USER_SHEET', 'nsIDOMWindowUtils.AUTHOR_SHEET',
];

const XPCOM_CONTRACTS = [
    '@mozilla.org/network/protocol;1?name=moz-extension',
    '@mozilla.org/addons/policy-service;1',
    '@mozilla.org/network/dns-service;1',
    '@mozilla.org/content/style-sheet-service;1',
    '@mozilla.org/network/stream-listener-tee;1',
    '@mozilla.org/storage/service;1',
    '@mozilla.org/network/effective-tld-service;1',
    '@mozilla.org/browser/sessionstore;1',
];

const CU_FUNCTIONS = [
    'Sandbox', 'evalInSandbox', 'exportFunction', 'cloneInto',
    'createObjectIn', 'waiveXrays', 'unwaiveXrays', 'isXrayWrapper',
    'getObjectPrincipal', 'importGlobalProperties', 'unload',
];

const MODULES = [
    'resource://gre/modules/WebRequest.jsm',
    'resource://gre/modules/WebRequestCommon.jsm',
    'resource://gre/modules/MatchPattern.jsm',
    'resource://gre/modules/WebNavigation.jsm',
    'resource://gre/modules/WebNavigationFrames.jsm',
    'resource://gre/modules/ExtensionUtils.jsm',
    'resource://gre/modules/Extension.jsm',
    'resource://gre/modules/ExtensionContent.jsm',
    'resource://gre/modules/E10SUtils.jsm',
    'resource://gre/modules/Sqlite.jsm',
    'resource://gre/modules/osfile.jsm',
    'resource://gre/modules/PrivateBrowsingUtils.jsm',
    'resource://gre/modules/AddonManager.jsm',
    'resource://gre/modules/BrowserUtils.jsm',
    'resource://gre/modules/PromiseUtils.jsm',
    'resource://gre/modules/AsyncShutdown.jsm',
    'resource://gre/modules/FileUtils.jsm',
    'resource://gre/modules/CustomizableUI.jsm',
    'resource:///modules/CustomizableUI.jsm',
    'resource:///modules/RecentWindow.jsm',
    'resource:///modules/sessionstore/SessionStore.jsm',
];

const PREFS = [
    'dom.moduleScripts.enabled', 'javascript.options.wasm',
    'dom.workers.enabled', 'dom.webcomponents.enabled',
    'dom.webcomponents.shadowdom.enabled', 'dom.indexedDB.enabled',
    'browser.tabs.remote.autostart', 'dom.ipc.processCount',
    'network.prefetch-next', 'network.dns.disablePrefetch',
    'network.predictor.enabled', 'browser.send_pings',
    'media.peerconnection.enabled', 'general.useragent.compatMode.firefox',
];

// Every upstream page: loading each one makes the engine parse its module
// graph, so unsupported syntax anywhere in upstream shows up as an error.
const PAGES = [
    'background.html', 'popup-fenix.html', 'dashboard.html', 'settings.html',
    '3p-filters.html', '1p-filters.html', 'dyna-rules.html', 'whitelist.html',
    'advanced-settings.html', 'about.html', 'support.html', 'logger-ui.html',
    'asset-viewer.html', 'code-viewer.html', 'cloud-ui.html',
    'document-blocked.html', 'devtools.html', 'no-dashboard.html', 'blank.html',
    'web_accessible_resources/epicker-ui.html',
    'web_accessible_resources/dom-inspector.html',
    'web_accessible_resources/click2load.html',
    'web_accessible_resources/noop.html',
];

/******************************************************************************/

const evaluateIn = function(win, table) {
    const out = {};
    for ( const [ name, expr ] of Object.entries(table) ) {
        try {
            out[name] = Boolean(new win.Function(`return (${expr});`)());
        } catch {
            out[name] = false;
        }
    }
    return out;
};

const parseIn = function(win, table) {
    const out = {};
    for ( const [ name, source ] of Object.entries(table) ) {
        try {
            new win.Function(source); // compiled, never run
            out[name] = true;
        } catch {
            out[name] = false;
        }
    }
    return out;
};

const resourceExists = function(url) {
    try {
        const channel = NetUtil.newChannel({ uri: url, loadUsingSystemPrincipal: true });
        const stream = typeof channel.open2 === 'function'
            ? channel.open2()
            : channel.open();
        stream.close();
        return true;
    } catch {
        return false;
    }
};

const probeXPCOM = function() {
    const constants = {};
    for ( const path of XPCOM_CONSTANTS ) {
        const [ iface, name ] = path.split('.');
        constants[path] = Ci[iface] !== undefined && Ci[iface][name] !== undefined
            ? Ci[iface][name]
            : null;
    }
    return {
        interfaces: Object.fromEntries(XPCOM_INTERFACES.map(name => [ name, Ci[name] !== undefined ])),
        constants,
        contracts: Object.fromEntries(XPCOM_CONTRACTS.map(name => [ name, name in Cc ])),
        cuFunctions: Object.fromEntries(CU_FUNCTIONS.map(name => [ name, typeof Cu[name] === 'function' ])),
        modules: Object.fromEntries(MODULES.map(url => [ url, resourceExists(url) ])),
    };
};

const probeEnvironment = function(win) {
    const appinfo = Services.appinfo;
    let remoteTabs = null;
    try {
        remoteTabs = appinfo.browserTabsRemoteAutostart;
    } catch {
    }
    return {
        appName: appinfo.name,
        appVersion: appinfo.version,
        appID: appinfo.ID,
        platformVersion: appinfo.platformVersion,
        platformBuildID: appinfo.platformBuildID,
        os: appinfo.OS,
        abi: appinfo.XPCOMABI,
        processType: appinfo.processType,
        browserTabsRemoteAutostart: remoteTabs,
        userAgent: win.navigator.userAgent,
        languages: Array.from(win.navigator.languages || []),
        prefs: Object.fromEntries(PREFS.map(name => [ name, readAnyPref(name) ])),
    };
};

// moz-extension:// is the origin upstream checks to enable its Firefox code
// paths (vapi-common.js), so whether UXP still has a handler for it matters.
const probeMozExtension = function() {
    const out = {
        contract: '@mozilla.org/network/protocol;1?name=moz-extension' in Cc,
    };
    try {
        const handler = Services.io.getProtocolHandler('moz-extension');
        out.scheme = handler.scheme;
        out.substituting = Ci.nsISubstitutingProtocolHandler !== undefined &&
            handler instanceof Ci.nsISubstitutingProtocolHandler;
        // Throws NS_ERROR_NOT_AVAILABLE when flags are computed per URI.
        try {
            out.protocolFlags = handler.protocolFlags;
        } catch {
            out.protocolFlags = 'dynamic';
        }
    } catch (ex) {
        out.error = String(ex);
    }
    // Firefox's moz-extension handler asks this service which URIs web
    // content may load (web_accessible_resources).
    try {
        const policy = Cc['@mozilla.org/addons/policy-service;1']
            .getService(Ci.nsIAddonPolicyService);
        const impl = policy.wrappedJSObject;
        if ( impl ) {
            const names = new Set();
            for ( let o = impl; o && o !== Object.prototype; o = Object.getPrototypeOf(o) ) {
                for ( const name of Object.getOwnPropertyNames(o) ) {
                    if ( typeof impl[name] === 'function' ) { names.add(name); }
                }
            }
            out.policyService = Array.from(names).sort();
        } else {
            out.policyService = 'native';
        }
    } catch (ex) {
        out.policyService = `error: ${ex}`;
    }
    return out;
};

/******************************************************************************/

// A chrome windowless browser hosting one XUL document, into which pages are
// loaded as iframes -- the same setup legacy uBO used for its background page.

const createHost = function() {
    return new Promise(resolve => {
        const browser = appShell.createWindowlessBrowser(true);
        browser.QueryInterface(Ci.nsIInterfaceRequestor);
        const webProgress = browser.getInterface(Ci.nsIWebProgress);
        const listener = {
            QueryInterface: XPCOMUtils.generateQI([
                Ci.nsIWebProgressListener,
                Ci.nsISupportsWeakReference,
            ]),
            onStateChange(progress, request, flags) {
                if ( !request ) { return; }
                if ( (flags & Ci.nsIWebProgressListener.STATE_STOP) === 0 ) { return; }
                webProgress.removeProgressListener(listener);
                host.listener = null;
                resolve();
            },
            onLocationChange() {},
            onProgressChange() {},
            onStatusChange() {},
            onSecurityChange() {},
        };
        // The progress listener is held weakly: keep it alive here.
        host = { browser, listener };
        webProgress.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT);
        browser.document.location =
            `data:application/vnd.mozilla.xul+xml;charset=utf-8,<window id='ublock0-probe'/>`;
    });
};

const destroyHost = function() {
    if ( host === null ) { return; }
    if ( typeof host.browser.close === 'function' ) {
        host.browser.close();
    }
    host = null;
};

// Polls readyState: the iframe's load event never fired in this setup. Gives
// up after 2 s stuck at 'interactive', or 8 s overall.
const loadPage = function(url) {
    return new Promise(resolve => {
        const doc = host.browser.document;
        const iframe = doc.createElementNS('http://www.w3.org/1999/xhtml', 'iframe');
        iframe.setAttribute('src', url);
        doc.documentElement.appendChild(iframe);
        const started = Date.now();
        let interactiveSince = 0;
        const poll = ( ) => {
            let readyState = 'none';
            try {
                const pageDoc = iframe.contentDocument;
                if ( pageDoc !== null && pageDoc.documentURI === url ) {
                    readyState = pageDoc.readyState;
                }
            } catch {
            }
            const now = Date.now();
            if ( readyState === 'interactive' && interactiveSince === 0 ) {
                interactiveSince = now;
            }
            if (
                readyState === 'complete' ||
                interactiveSince !== 0 && now - interactiveSince > 2000 ||
                now - started > 8000
            ) {
                resolve({ iframe, readyState });
                return;
            }
            setTimeout(poll, 50);
        };
        poll();
    });
};

// Load a page, let its modules settle, collect the console output it caused.
const probePage = async function(url) {
    const first = consoleLines.length;
    const { iframe, readyState } = await loadPage(url);
    await sleep(1000);
    const messages = consoleLines.slice(first)
        .filter(line => line.kind === 'error' || line.kind.startsWith('console.error'))
        .filter(line => OWN_SOURCES.test(line.source) || OWN_SOURCES.test(line.text))
        .map(line => `${line.text} @ ${line.source}`);
    let principal = null;
    try {
        const p = iframe.contentDocument.nodePrincipal;
        principal = Services.scriptSecurityManager.isSystemPrincipal(p) ? 'system' : p.origin;
    } catch {
    }
    return { url, readyState, principal, iframe, messages };
};

const pageResult = r => ({
    url: r.url,
    readyState: r.readyState,
    principal: r.principal,
    errors: r.messages,
});

const probePages = async function(report) {
    const results = [];
    let bgWindow = null;
    for ( const page of PAGES ) {
        const result = await probePage(`chrome://ublock0/content/${page}`);
        if ( page === 'background.html' && result.readyState !== 'none' ) {
            bgWindow = result.iframe.contentWindow;
        } else {
            result.iframe.remove();
        }
        results.push(pageResult(result));
    }

    // Same background page through other schemes, for the scheme decision.
    const resProtocol = Services.io.getProtocolHandler('resource')
        .QueryInterface(Ci.nsIResProtocolHandler);
    resProtocol.setSubstitution('ublock0-probe', addonData.resourceURI);
    const viaResource = await probePage('resource://ublock0-probe/background.html');
    viaResource.iframe.remove();
    resProtocol.setSubstitution('ublock0-probe', null);
    results.push(pageResult(viaResource));

    if ( report.mozExtension.substituting ) {
        const handler = Services.io.getProtocolHandler('moz-extension')
            .QueryInterface(Ci.nsISubstitutingProtocolHandler);
        const uuid = Cc['@mozilla.org/uuid-generator;1']
            .getService(Ci.nsIUUIDGenerator)
            .generateUUID().toString().slice(1, -1);
        handler.setSubstitution(uuid, addonData.resourceURI);
        const viaMozExt = await probePage(`moz-extension://${uuid}/background.html`);
        viaMozExt.iframe.remove();
        handler.setSubstitution(uuid, null);
        results.push(pageResult(viaMozExt));
    }

    return { results, bgWindow };
};

/******************************************************************************/

const runProbes = async function() {
    const report = { mozExtension: probeMozExtension(), xpcom: probeXPCOM() };
    await createHost();
    const pages = await probePages(report);
    const win = pages.bgWindow || appShell.hiddenDOMWindow;
    report.probedIn = pages.bgWindow ? 'chrome://ublock0/content/background.html' : 'hiddenDOMWindow';
    report.environment = probeEnvironment(win);
    report.syntax = parseIn(win, SYNTAX_PROBES);
    report.builtins = evaluateIn(win, BUILTIN_PROBES);
    report.dom = evaluateIn(win, DOM_PROBES);
    report.pages = pages.results;
    destroyHost();

    const unsupported = table => Object.keys(table).filter(k => table[k] === false);
    const env = report.environment;
    // Without a `browser` object every page fails with "X is undefined";
    // anything else (syntax, module loading, ...) is worth a look.
    const expected = /^TypeError: [\w.$]+ is undefined /;
    const unexpected = new Set();
    for ( const page of report.pages ) {
        for ( const message of page.errors ) {
            if ( expected.test(message) === false ) { unexpected.add(message); }
        }
    }
    report.summary = {
        app: `${env.appName} ${env.appVersion} (UXP ${env.platformVersion})`,
        userAgent: env.userAgent,
        mozExtension: report.mozExtension,
        unsupportedSyntax: unsupported(report.syntax),
        unsupportedBuiltins: unsupported(report.builtins),
        unsupportedDOM: unsupported(report.dom),
        missingInterfaces: unsupported(report.xpcom.interfaces),
        missingConstants: Object.keys(report.xpcom.constants)
            .filter(k => report.xpcom.constants[k] === null),
        missingContracts: unsupported(report.xpcom.contracts),
        missingCuFunctions: unsupported(report.xpcom.cuFunctions),
        modulesPresent: Object.keys(report.xpcom.modules).filter(k => report.xpcom.modules[k]),
        pagesNotComplete: report.pages
            .filter(p => p.readyState !== 'complete')
            .map(p => `${p.url} (${p.readyState})`),
        unexpectedPageErrors: Array.from(unexpected),
        backgroundPageBySchemes: report.pages
            .filter(p => p.url.endsWith('/background.html'))
            .map(p => `${p.url} -> ${p.readyState}, principal ${p.principal}, ${p.errors.length} errors`),
    };
    return report;
};

/******************************************************************************/

// Boot: the background page boots upstream uBO completely (filter lists
// compiled), and an extension page in a tab gets its data from the
// background page through runtime ports.

const waitFor = async function(fn, timeout, what) {
    const deadline = Date.now() + timeout;
    for (;;) {
        let value = null;
        try {
            value = fn();
        } catch {
        }
        if ( value ) { return value; }
        if ( Date.now() > deadline ) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await sleep(250);
    }
};

// Page data, read through Xray waivers, as plain chrome data.
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const openTab = async function(url) {
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    const tab = win.gBrowser.addTab(url);
    win.gBrowser.selectedTab = tab;
    const doc = await waitFor(( ) => {
        const d = tab.linkedBrowser.contentDocument;
        return d && d.documentURI === url && d.readyState === 'complete' ? d : null;
    }, 60000, url);
    return { tab, doc, close: ( ) => { win.gBrowser.removeTab(tab); } };
};

// Runs each part of a scenario on its own: a failure goes into
// report.errors and does not hide the next parts.
const sectionRunner = report => async (name, fn) => {
    try {
        await fn();
    } catch (ex) {
        report.errors = report.errors || {};
        report.errors[name] = String(ex);
    }
};

// Whether the page's own script can load the image at `url`: 'loaded',
// 'error' or 'timeout'. A load started from here would be the browser's.
const pageLoadsImage = function(doc, url) {
    const key = `load${Math.random().toString(36).slice(2)}`;
    const script = doc.createElement('script');
    script.textContent = `{
        const img = new Image();
        img.onload = ( ) => { document.documentElement.dataset.${key} = 'loaded'; };
        img.onerror = ( ) => { document.documentElement.dataset.${key} = 'error'; };
        img.src = ${JSON.stringify(url)};
    }`;
    doc.body.appendChild(script);
    return waitFor(( ) => doc.documentElement.dataset[key], 5000, url).catch(( ) => 'timeout');
};

const ownErrors = lines => lines
    .filter(line => line.kind === 'error' || line.kind === 'console.error')
    .filter(line => OWN_SOURCES.test(line.source))
    .map(line => `${line.text} @ ${line.source}`);

// The extension, its background page, and uBO once it reports "all ready"
// (allReadyAfter starts as '?', see background.js).
const whenUBOReady = async function() {
    const ext = await waitFor(( ) => extension, 30000, 'the extension');
    const bgWindow = await waitFor(( ) => ext.background && ext.background.window, 60000, 'the background page');
    const µb = await waitFor(( ) => {
        const µb = Cu.waiveXrays(bgWindow).µBlock;
        return µb && µb.readyToFilter === true &&
            µb.supportStats.allReadyAfter !== '?' ? µb : null;
    }, 180000, 'uBO to report "all ready"');
    return { ext, bgWindow, µb };
};

const runBoot = async function() {
    const report = {};
    let failure = null;
    try {
        const { ext, bgWindow, µb } = await whenUBOReady();
        report.uuid = ext.uuid;
        const doc = bgWindow.document;
        report.background = `${doc.documentURI} (principal ${doc.nodePrincipal.origin})`;
        // The runtime relaxes it during boot only (Extension.jsm).
        await sleep(1000);
        report.scriptRunTimeAfterBoot = readAnyPref('dom.max_script_run_time');
        report.supportStats = plain(µb.supportStats);
        report.readyToFilter = µb.readyToFilter;
        report.lists = {};
        for ( const key of plain(µb.selectedFilterLists) ) {
            const entry = µb.availableFilterLists[key];
            report.lists[key] = entry
                ? `${entry.entryUsedCount} of ${entry.entryCount} filters in use`
                : 'missing from availableFilterLists';
        }

        const url = ext.getURL('3p-filters.html');
        const page = await openTab(url);
        report.dashboard = { url, principal: page.doc.nodePrincipal.origin };
        try {
            report.dashboard.listEntries = await waitFor(
                ( ) => page.doc.querySelectorAll('.listEntry[data-key]').length,
                15000, 'lists rendered in 3p-filters.html'
            );
        } catch {
            report.dashboard.listEntries = 0;
        }
        report.contexts = Array.from(ext.contexts.values(), c => `${c.viewType}: ${c.url}`);
        await sleep(500);
        page.close();
    } catch (ex) {
        failure = String(ex);
    }

    // The whole session: the add-on boots before the scenario starts.
    const lines = consoleLines;
    report.summary = {
        app: `${Services.appinfo.name} ${Services.appinfo.version}`,
        background: report.background,
        allReadyAfter: report.supportStats && report.supportStats.allReadyAfter,
        cacheBackend: report.supportStats && report.supportStats.cacheBackend,
        readyToFilter: report.readyToFilter,
        scriptRunTimeAfterBoot: report.scriptRunTimeAfterBoot,
        backgroundRestarts: lines.filter(l => l.text.includes('was stopped; restarting it')).length,
        wasm: lines.some(l => l.text.includes('WASM modules ready')) ? 'enabled' : 'not enabled',
        filterLists: Object.entries(report.lists || {}).map(([ k, v ]) => `${k}: ${v}`),
        dashboard: report.dashboard
            ? `${report.dashboard.listEntries} filter lists rendered, principal ${report.dashboard.principal}`
            : undefined,
        contexts: report.contexts || [],
        ownErrors: ownErrors(lines),
        ubologTail: lines
            .filter(l => l.kind === 'console.info' && l.text.startsWith('[uBO]'))
            .slice(-15)
            .map(l => l.text.slice(0, 200)),
    };
    if ( failure !== null ) {
        report.error = failure;
    }
    return report;
};

/******************************************************************************/

// Network: a test page opened while uBO is still booting must not leak any
// blocked request; uBO must attribute the page's requests to its tab, block
// in subframes, and close a blocked popup.

const NETWORK_FILTERS = [
    '||127.0.0.1^*/uxp-blocked/',
    '||localhost^*/uxp-blocked/',
    '||localhost^*/popup.html$popup',
];

// Each test document records what loaded into body[data-results].
const recorderScript = expected => `
const results = {};
const save = ( ) => { document.body.dataset.results = JSON.stringify(results); };
for ( const img of document.images ) {
    const mark = ok => { results[img.id] = ok; save(); };
    if ( img.complete ) { mark(img.naturalWidth > 0); } else {
        img.onload = ( ) => { mark(true); };
        img.onerror = ( ) => { mark(false); };
    }
}
${expected}
save();`;

const testRoutes = function(path, port) {
    const html = body => ({ type: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8">${body}</html>` });
    const svg = color => ({
        type: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${color}"/></svg>`,
    });
    switch ( path ) {
    case '/page.html':
        return html(`<title>uxp-test</title>
<script src="/ok/script.js"></script>
<script src="/uxp-blocked/ad.js"></script>
</head><body>
<img id="okImage" src="/ok/image.svg"><img id="adImage" src="/uxp-blocked/ad.svg">
<iframe id="frame" src="http://localhost:${port}/frame.html"></iframe>
<script>${recorderScript(`
results.okScript = window.okScript === true;
results.adScript = window.adScript === true;
for ( const path of [ '/ok/xhr.txt', '/uxp-blocked/xhr.txt' ] ) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', path);
    xhr.onload = ( ) => { results[path] = xhr.status; save(); };
    xhr.onerror = ( ) => { results[path] = 'error'; save(); };
    xhr.send();
}
setTimeout(( ) => { window.open('http://localhost:${port}/popup.html'); }, 500);`)}</script></body>`);
    case '/frame.html':
        return html(`</head><body><img id="okImage" src="/ok/frame-image.svg"><img id="adImage" src="/uxp-blocked/frame-ad.svg">
<script>${recorderScript('')}</script></body>`);
    case '/popup.html':
        return html('<title>popup</title></head><body>popup</body>');
    case '/ok/script.js':
        return { type: 'application/javascript', body: 'window.okScript = true;' };
    case '/uxp-blocked/ad.js':
        return { type: 'application/javascript', body: 'window.adScript = true;' };
    case '/ok/image.svg':
    case '/ok/frame-image.svg':
        return svg('green');
    case '/uxp-blocked/ad.svg':
    case '/uxp-blocked/frame-ad.svg':
        return svg('red');
    case '/ok/xhr.txt':
    case '/uxp-blocked/xhr.txt':
        return { type: 'text/plain', body: 'xhr' };
    default:
        return null;
    }
};

// A minimal HTTP/1.1 server on the loopback interface. It records every
// request it receives: a blocked resource must never show up there.
const TestServer = class {
    constructor(routes) {
        this.routes = routes;
        this.requests = [];
        this.socket = null;
        this.port = 0;
    }

    start() {
        this.socket = Cc['@mozilla.org/network/server-socket;1']
            .createInstance(Ci.nsIServerSocket);
        this.socket.init(-1, true, -1);
        this.port = this.socket.port;
        this.socket.asyncListen({
            onSocketAccepted: (server, transport) => { this.serve(transport); },
            onStopListening() {},
        });
    }

    stop() {
        if ( this.socket === null ) { return; }
        this.socket.close();
        this.socket = null;
    }

    serve(transport) {
        const input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
        const output = transport.openOutputStream(Ci.nsITransport.OPEN_BLOCKING, 0, 0);
        let received = '';
        const reader = {
            onInputStreamReady: stream => {
                try {
                    const scriptable = Cc['@mozilla.org/scriptableinputstream;1']
                        .createInstance(Ci.nsIScriptableInputStream);
                    scriptable.init(stream);
                    received += scriptable.read(stream.available());
                } catch {
                    input.close();
                    output.close();
                    return;
                }
                if ( received.includes('\r\n\r\n') === false ) {
                    input.asyncWait(reader, 0, 0, Services.tm.mainThread);
                    return;
                }
                this.respond(received, input, output);
            },
        };
        input.asyncWait(reader, 0, 0, Services.tm.mainThread);
    }

    // A route may answer late (delayMs), or send the first half of its body
    // and the rest splitDelayMs later: requests and streams in flight.
    respond(request, input, output) {
        const path = request.split('\r\n', 1)[0].split(' ')[1] || '/';
        const host = (/^host:\s*(\S+)/im.exec(request) || [ '', '' ])[1];
        this.requests.push(`${host.replace(/:\d+$/, '')}${path}`);
        const route = this.routes(path.replace(/\?.*$/, ''), this.port);
        // A body is a binary string: one character per byte.
        const body = route !== null ? route.body : 'not found';
        const head = [
            `HTTP/1.1 ${route !== null ? '200 OK' : '404 Not Found'}`,
            `Content-Type: ${route !== null ? route.type : 'text/plain'}`,
            `Content-Length: ${body.length}`,
            'Cache-Control: no-store',
            'Connection: close',
            ...(route !== null && route.headers || []),
            '',
            '',
        ].join('\r\n');
        const send = text => { output.write(text, text.length); };
        const end = ( ) => {
            output.close();
            input.close();
        };
        const { delayMs = 0, splitDelayMs = 0 } = route || {};
        const answer = ( ) => {
            if ( splitDelayMs === 0 ) {
                send(head + body);
                end();
                return;
            }
            const half = body.length >> 1;
            send(head + body.slice(0, half));
            setTimeout(( ) => {
                send(body.slice(half));
                end();
            }, splitDelayMs);
        };
        if ( delayMs === 0 ) {
            answer();
        } else {
            setTimeout(answer, delayMs);
        }
    }
};

const openTabs = function() {
    const out = [];
    const windows = Services.wm.getEnumerator('navigator:browser');
    while ( windows.hasMoreElements() ) {
        for ( const tab of windows.getNext().gBrowser.tabs ) {
            out.push(tab);
        }
    }
    return out;
};

const runNetwork = async function() {
    const report = {};
    let failure = null;
    const server = new TestServer(testRoutes);
    server.start();
    try {
        // Opened right away, while uBO is still booting.
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        const tab = win.gBrowser.addTab(`http://127.0.0.1:${server.port}/page.html`, {});
        win.gBrowser.selectedTab = tab;
        const openedAt = Date.now();
        const { ext, µb } = await whenUBOReady();
        report.uboReadyAfterPageOpened = `${Date.now() - openedAt} ms`;
        const doc = await waitFor(( ) => {
            const d = tab.linkedBrowser.contentDocument;
            if ( !d || d.readyState !== 'complete' || !d.body || !d.body.dataset.results ) { return null; }
            return Object.keys(JSON.parse(d.body.dataset.results)).length >= 6 ? d : null;
        }, 60000, 'the test page results');
        report.page = JSON.parse(doc.body.dataset.results);
        const frameDoc = doc.getElementById('frame').contentDocument;
        report.frame = frameDoc && frameDoc.body && frameDoc.body.dataset.results
            ? JSON.parse(frameDoc.body.dataset.results)
            : null;
        await sleep(3000);
        report.popupTabsLeft = openTabs()
            .filter(t => t.linkedBrowser.currentURI.spec.includes('/popup.html')).length;
        const tabId = ext.tabTracker.getId(tab.linkedBrowser);
        const tabContext = µb.tabContextManager.lookup(tabId);
        report.tabAttribution = `tab ${tabId}: uBO's context URL ${tabContext ? tabContext.rawURL : 'none'}`;
        const pageStore = µb.pageStoreFromTabId(tabId);
        report.pageStoreCounts = pageStore ? plain(pageStore.counts) : null;
    } catch (ex) {
        failure = String(ex);
    }
    server.stop();
    const leaks = server.requests.filter(p => p.includes('/uxp-blocked/'));
    report.summary = {
        app: `${Services.appinfo.name} ${Services.appinfo.version}`,
        uboReadyAfterPageOpened: report.uboReadyAfterPageOpened,
        noLeaksAtLaunch: leaks.length === 0 ? 'PASS' : `FAIL: ${leaks.join(', ')}`,
        page: report.page,
        frame: report.frame,
        popupClosed: report.popupTabsLeft === 0 ? 'PASS' : `FAIL (${report.popupTabsLeft} left)`,
        tabAttribution: report.tabAttribution,
        pageStoreCounts: report.pageStoreCounts,
        serverRequests: server.requests,
        ownErrors: ownErrors(consoleLines),
    };
    if ( failure !== null ) {
        report.error = failure;
    }
    return report;
};

/******************************************************************************/

// Cosmetic: uBO's specific, generic and procedural cosmetic filters hide
// their targets in a page, its subframe and its about:blank frames, despite
// the page's own `!important` styles (user-origin CSS); its scriptlet runs
// before the page's first script; the content-script APIs behave as in
// Firefox.
//
// Served from a name resolving to the loopback server (Gecko's
// network.dns.localDomains): EasyList turns generic cosmetic filtering off on
// 127.0.0.1 and localhost (`@@://127.0.0.1$generichide`).

const COSMETIC_HOST = 'uxp-cosmetic.test';

const COSMETIC_FILTERS = [
    `${COSMETIC_HOST}##.uxp-ad`,
    '##.uxp-generic-ad',
    `${COSMETIC_HOST}##.uxp-proc:has-text(sponsored)`,
    `${COSMETIC_HOST}##+js(set-constant, uxpScriptletValue, true)`,
];

const cosmeticRoutes = function(path) {
    // Every document records what its first script sees of the scriptlet.
    const html = (title, body) => ({
        type: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>.uxp-ad, .uxp-generic-ad, .uxp-proc, .uxp-ok { display: block !important; }</style>
<script>document.documentElement.dataset.scriptlet = String(window.uxpScriptletValue);</script>
</head><body>${body}</body></html>`,
    });
    const ad = '<div id="specific" class="uxp-ad">ad</div>';
    switch ( path ) {
    case '/cosmetic.html':
        return html('uxp-cosmetic', `<div id="ok" class="uxp-ok">ok</div>
${ad}
<div id="generic" class="uxp-generic-ad">ad</div>
<div id="procedural" class="uxp-proc">sponsored</div>
<div id="procOk" class="uxp-proc">article</div>
<iframe id="frame" src="/cosmetic-frame.html"></iframe>
<iframe id="blankWritten"></iframe>
<iframe id="blankDOM"></iframe>
<script>
{
    const doc = document.getElementById('blankWritten').contentDocument;
    doc.open();
    doc.write('<!doctype html><html><body>${ad}</body></html>');
    doc.close();
}
// Gecko replaces a new frame's initial about:blank document once it loads.
{
    const frame = document.getElementById('blankDOM');
    frame.addEventListener('load', ( ) => {
        frame.contentDocument.body.innerHTML = '${ad}';
    }, { once: true });
}
</script>`);
    case '/cosmetic-frame.html':
        return html('uxp-cosmetic-frame', `<div id="ok" class="uxp-ok">ok</div>${ad}`);
    default:
        return null;
    }
};

const COSMETIC_EXPECTED = {
    page: {
        ok: 'shown',
        specific: 'hidden',
        generic: 'hidden',
        procedural: 'hidden',
        proceduralOther: 'shown',
        scriptlet: 'true',
    },
    frame: { ok: 'shown', specific: 'hidden', scriptlet: 'true' },
    aboutBlankWritten: { specific: 'hidden' },
    aboutBlankDOM: { specific: 'hidden' },
};

const cosmeticState = function(doc) {
    const display = (d, id) => {
        const el = d && d.getElementById(id);
        if ( !el ) { return 'missing'; }
        return d.defaultView.getComputedStyle(el).display === 'none' ? 'hidden' : 'shown';
    };
    const frameDoc = id => {
        const frame = doc.getElementById(id);
        return frame ? frame.contentDocument : null;
    };
    const frame = frameDoc('frame');
    return {
        page: {
            ok: display(doc, 'ok'),
            specific: display(doc, 'specific'),
            generic: display(doc, 'generic'),
            procedural: display(doc, 'procedural'),
            proceduralOther: display(doc, 'procOk'),
            scriptlet: doc.documentElement.dataset.scriptlet,
        },
        frame: {
            ok: display(frame, 'ok'),
            specific: display(frame, 'specific'),
            scriptlet: frame && frame.documentElement
                ? frame.documentElement.dataset.scriptlet
                : 'missing',
        },
        aboutBlankWritten: { specific: display(frameDoc('blankWritten'), 'specific') },
        aboutBlankDOM: { specific: display(frameDoc('blankDOM'), 'specific') },
    };
};

const API_EXPECTED = {
    executeScriptCode: { value: [ 'uxp-cosmetic' ] },
    executeScriptAllFrames: 4,
    executeScriptFile: { value: [ false ] },
    sendMessageNoReceiver: { error: 'Could not establish connection. Receiving end does not exist.' },
    sendMessage: { value: { echo: 42, senderId: 'uBlock0@raymondhill.net' } },
    connect: { value: { echo: 7, name: 'uxp-test' } },
    insertCSS: 'none',
    removeCSS: 'block',
    callback: '1 tab(s)',
    callbackLastError: { tab: 'undefined', lastError: 'Invalid tab ID: -1' },
    lastErrorAfterCallback: 'undefined',
};

// What each content script has done: style sheets inserted, and the state of
// uBO's content-side components (null: disabled by uBO).
const contentScriptStates = ext => Array.from(ext.contexts.values())
    .filter(c => c.isContentScript && c.unloaded === false)
    .map(c => {
        const vAPI = Cu.waiveXrays(c.sandbox).vAPI;
        const state = v => v === null ? 'off' : v === undefined ? 'none' : 'on';
        // typeof: `instanceof Object` does not hold across compartments.
        const parts = typeof vAPI === 'object' && vAPI !== null
            ? [ 'bootstrap', 'domFilterer', 'domSurveyor', 'domWatcher' ]
                .map(name => `${name} ${state(vAPI[name])}`).join(', ')
            : 'no vAPI';
        return `${c.url} (frame ${c.frameId}): ${c.sheets.length} sheet(s); ${parts}`;
    });

const verdicts = (actual, expected) => Object.fromEntries(
    Object.keys(expected).map(key => {
        const json = JSON.stringify(actual[key]);
        return [ key, json === JSON.stringify(expected[key]) ? 'PASS' : `FAIL: ${json}` ];
    })
);

// Calls the background page's browser.* API as the page itself would, e.g.
// 'privacy.network.networkPredictionEnabled.get'; settles with { value } or
// { error }.
const callBackground = function(bgWindow, path, ...args) {
    const page = Cu.waiveXrays(bgWindow);
    const names = path.split('.');
    const method = names.pop();
    const target = names.reduce((object, name) => object[name], page.browser);
    return new Promise(resolve => {
        try {
            target[method](...args.map(a => Cu.cloneInto(a, page))).then(
                Cu.exportFunction(value => { resolve({ value: plain(value) }); }, page),
                Cu.exportFunction(error => { resolve({ error: String(error && error.message) }); }, page)
            );
        } catch (ex) {
            resolve({ error: String(ex && ex.message || ex) });
        }
    });
};

const checkContentAPIs = async function(bgWindow, tabId, doc) {
    const page = Cu.waiveXrays(bgWindow);
    const call = (path, ...args) => callBackground(bgWindow, path, ...args);
    const out = {};
    out.executeScriptCode = await call('tabs.executeScript', tabId, { code: 'document.title' });
    out.executeScriptAllFrames = await call('tabs.executeScript', tabId, {
        code: 'location.href',
        allFrames: true,
        matchAboutBlank: true,
    });
    // uBO's own check: runs in the sandbox of the declared content scripts.
    out.executeScriptFile = await call('tabs.executeScript', tabId, {
        file: '/js/scriptlets/should-inject-contentscript.js',
    });
    out.sendMessageNoReceiver = await call('tabs.sendMessage', tabId, { ping: 1 });
    await call('tabs.executeScript', tabId, { code: `
        browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
            sendResponse({ echo: message.ping, senderId: sender.id });
        });
        browser.runtime.onConnect.addListener(port => {
            port.onMessage.addListener(message => {
                port.postMessage({ echo: message.ping, name: port.name });
            });
        });
        0;` });
    out.sendMessage = await call('tabs.sendMessage', tabId, { ping: 42 });
    out.connect = await new Promise(resolve => {
        const port = page.browser.tabs.connect(tabId, Cu.cloneInto({ name: 'uxp-test' }, page));
        port.onMessage.addListener(Cu.exportFunction(message => {
            resolve({ value: plain(message) });
            port.disconnect();
        }, page));
        port.onDisconnect.addListener(Cu.exportFunction(( ) => {
            resolve({ error: 'disconnected' });
        }, page));
        port.postMessage(Cu.cloneInto({ ping: 7 }, page));
        setTimeout(( ) => { resolve({ error: 'timed out' }); }, 5000);
    });
    // A user-origin sheet beats the page's `!important`, and goes away.
    const css = { code: '#ok { display: none !important; }', cssOrigin: 'user' };
    const okDisplay = ( ) => doc.defaultView.getComputedStyle(doc.getElementById('ok')).display;
    await call('tabs.insertCSS', tabId, css);
    out.insertCSS = okDisplay();
    await call('tabs.removeCSS', tabId, css);
    out.removeCSS = okDisplay();
    // Chrome's callback form, and runtime.lastError.
    out.callback = await new Promise(resolve => {
        page.chrome.tabs.query(
            Cu.cloneInto({ active: true, currentWindow: true }, page),
            Cu.exportFunction(tabs => { resolve(`${tabs.length} tab(s)`); }, page)
        );
    });
    out.callbackLastError = await new Promise(resolve => {
        page.chrome.tabs.get(-1, Cu.exportFunction(tab => {
            const error = page.chrome.runtime.lastError;
            resolve({ tab: String(tab), lastError: error ? String(error.message) : 'none' });
        }, page));
    });
    out.lastErrorAfterCallback = String(page.chrome.runtime.lastError);
    return out;
};

const runCosmetic = async function() {
    const report = {};
    let failure = null;
    const server = new TestServer(cosmeticRoutes);
    server.start();
    try {
        const { ext, bgWindow, µb } = await whenUBOReady();
        // Navigation events of the test tab, as uBO receives them.
        report.navigation = [];
        const recorder = {
            unloaded: false,
            callOnUnload() {},
            forgetOnUnload() {},
            cloneOut: value => value,
            callPage: (fn, args) => fn(...args),
        };
        for ( const name of [ 'onBeforeNavigate', 'onCommitted' ] ) {
            ext.tabTracker.navigationEvents[name].addListener(recorder, details => {
                report.navigation.push(`${name} frame ${details.frameId}: ${details.url}`);
            });
        }
        // The notifications content scripts start from, for the test page's
        // documents (about:blank ones have the page's principal).
        report.documents = [];
        const documentObserver = {
            observe(subject, topic) {
                const doc = topic === 'document-element-inserted' ? subject : subject.document;
                if ( !doc || doc.nodePrincipal.origin.includes(COSMETIC_HOST) === false ) { return; }
                const win = doc.defaultView;
                const utils = win && win.QueryInterface(Ci.nsIInterfaceRequestor)
                    .getInterface(Ci.nsIDOMWindowUtils);
                report.documents.push([
                    topic,
                    utils ? `frame ${win.top === win ? 0 : utils.outerWindowID}` : 'no window',
                    utils ? `inner ${utils.currentInnerWindowID}` : '',
                    doc.documentURI,
                    doc.documentElement ? '' : '(no root yet)',
                ].join(' '));
            },
        };
        const documentTopics = [ 'document-element-inserted', 'content-document-global-created' ];
        for ( const topic of documentTopics ) {
            Services.obs.addObserver(documentObserver, topic, false);
        }
        const page = await openTab(`http://${COSMETIC_HOST}:${server.port}/cosmetic.html`);
        const { doc } = page;
        // Content scripts work asynchronously: wait for the expected state,
        // then report what there is.
        const expected = JSON.stringify(COSMETIC_EXPECTED);
        try {
            await waitFor(( ) => JSON.stringify(cosmeticState(doc)) === expected, 15000, 'the cosmetic filters');
        } catch {
        }
        for ( const topic of documentTopics ) {
            Services.obs.removeObserver(documentObserver, topic);
        }
        report.cosmetic = cosmeticState(doc);
        report.requestIdleCallback = typeof Cu.waiveXrays(doc.defaultView).requestIdleCallback;
        report.contentScripts = contentScriptStates(ext);
        const tabId = ext.tabTracker.getId(page.tab.linkedBrowser);
        // The frames uBO knows of in the tab: it filters only those.
        const pageStore = µb.pageStoreFromTabId(tabId);
        report.uboFrames = pageStore
            ? Array.from(pageStore.frames, ([ frameId, frame ]) => `${frameId}: ${frame.rawURL}`)
            : null;
        report.api = await checkContentAPIs(bgWindow, tabId, doc);
        page.close();
    } catch (ex) {
        failure = String(ex);
    }
    server.stop();
    const api = report.api && Object.assign({}, report.api, {
        executeScriptAllFrames: report.api.executeScriptAllFrames.value
            ? report.api.executeScriptAllFrames.value.length
            : report.api.executeScriptAllFrames,
    });
    report.summary = {
        app: `${Services.appinfo.name} ${Services.appinfo.version}`,
        cosmetic: report.cosmetic && verdicts(report.cosmetic, COSMETIC_EXPECTED),
        api: api && verdicts(api, API_EXPECTED),
        requestIdleCallback: report.requestIdleCallback,
        contentScripts: report.contentScripts,
        uboFrames: report.uboFrames,
        ownErrors: ownErrors(consoleLines),
    };
    if ( failure !== null ) {
        report.error = failure;
    }
    return report;
};

/******************************************************************************/

// UI: the toolbar button with uBO's badge; its popup, opened from the
// button and closed by the popup itself; the context menu (uBO's items,
// "Block element" starting the element picker); a keyboard shortcut set
// through commands.update(); the Options button in about:addons and
// runtime.openOptionsPage(), each opening uBO's dashboard in a tab.
// Screenshots of the toolbar and the popup go next to the report.

const UI_FILTERS = [ '||127.0.0.1^*/uxp-blocked/' ];

const uiRoutes = function(path, port) {
    if ( path !== '/ui.html' ) { return testRoutes(path, port); }
    return {
        type: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><meta charset="utf-8"><title>uxp-ui</title></head><body>
<img id="okImage" src="/ok/image.svg"><img id="adImage" src="/uxp-blocked/ad.svg">
<p><a id="subscribe" href="abp:subscribe?location=https%3A%2F%2Fexample.com%2Flist.txt&amp;title=Example">subscribe</a></p>
<div id="target" style="width: 200px; height: 100px; background: #ccc">target</div>
</body></html>`,
    };
};

// A PNG of `rect` in `target` (a chrome or a content window), drawn with
// the privileges of the browser window `win`.
const saveScreenshot = function(win, target, rect, name) {
    const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    canvas.width = Math.max(1, Math.ceil(rect.width));
    canvas.height = Math.max(1, Math.ceil(rect.height));
    canvas.getContext('2d').drawWindow(
        target, rect.left, rect.top, rect.width, rect.height, 'rgb(255,255,255)'
    );
    const bytes = win.atob(canvas.toDataURL('image/png').split(',')[1]);
    const file = outDir.clone();
    file.append(name);
    const stream = Cc['@mozilla.org/network/file-output-stream;1']
        .createInstance(Ci.nsIFileOutputStream);
    stream.init(file, 0x02 | 0x08 | 0x20, 0o644, 0);
    const binary = Cc['@mozilla.org/binaryoutputstream;1']
        .createInstance(Ci.nsIBinaryOutputStream);
    binary.setOutputStream(stream);
    binary.writeBytes(bytes, bytes.length);
    stream.close();
    return file.path;
};

// Opens the content area's context menu on `element`; resolves with the
// labels of uBO's items in it ("menu > item" inside a submenu).
const openContextMenu = async function(win, element) {
    const menu = win.document.getElementById('contentAreaContextMenu');
    const shown = new Promise(resolve => {
        menu.addEventListener('popupshown', resolve, { once: true });
    });
    const rect = element.getBoundingClientRect();
    element.ownerDocument.defaultView
        .QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIDOMWindowUtils)
        .sendMouseEvent('contextmenu', rect.left + 5, rect.top + 5, 2, 1, 0);
    await Promise.race([ shown, sleep(5000) ]);
    const labels = [];
    const items = [];
    for ( const node of menu.querySelectorAll('[data-ublock0-menu] menuitem, menuitem[data-ublock0-menu], menu[data-ublock0-menu]') ) {
        if ( node.localName === 'menu' ) { continue; }
        const parent = node.parentNode.parentNode;
        labels.push(parent.localName === 'menu'
            ? `${parent.getAttribute('label')} > ${node.getAttribute('label')}`
            : node.getAttribute('label'));
        items.push(node);
    }
    return { menu, labels, items };
};

const runUI = async function() {
    const report = {};
    const checks = {};
    let failure = null;
    const server = new TestServer(uiRoutes);
    server.start();
    try {
        const { ext, bgWindow, µb } = await whenUBOReady();
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        const page = await openTab(`http://127.0.0.1:${server.port}/ui.html`);
        const tabId = ext.tabTracker.getId(page.tab.linkedBrowser);

        // Toolbar button and badge
        const button = await waitFor(
            ( ) => win.document.querySelector('[id="uBlock0-legacy-button"], [id="ublock0-button"]'),
            10000, 'the toolbar button'
        );
        const badge = await waitFor(( ) => button.getAttribute('badge'), 10000, 'the badge')
            .catch(( ) => '');
        report.button = {
            id: button.id,
            parent: button.parentNode ? button.parentNode.id : null,
            label: button.getAttribute('label'),
            badge,
            icon: button.style.getPropertyValue('--ublock0-icon'),
        };
        report.badgeFromAPI = (await callBackground(bgWindow, 'browserAction.getBadgeText', { tabId })).value;
        const pageStore = µb.pageStoreFromTabId(tabId);
        report.blockedOnPage = pageStore ? pageStore.counts.blocked.any : null;
        const navbar = win.document.getElementById('nav-bar');
        report.toolbarScreenshot = saveScreenshot(win, win, navbar.getBoundingClientRect(), 'toolbar.png');

        const section = sectionRunner(report);

        // Basilisk moves the view into a panelmultiview's anonymous content,
        // which document.querySelector() does not search.
        const findPopupBrowser = ( ) => {
            const selector = '.ublock0-popup-browser';
            const view = win.document.getElementById('ublock0-panel');
            return win.document.querySelector(selector) || view && view.querySelector(selector);
        };

        await section('popup', async ( ) => {
            button.doCommand();
            const popupBrowser = await waitFor(findPopupBrowser, 5000, 'the popup'
            ).catch(ex => {
                const view = win.document.getElementById('ublock0-panel');
                report.popupDebug = {
                    view: view ? `in ${view.parentNode && view.parentNode.id}` : 'none',
                    panels: Array.from(win.document.querySelectorAll('panel'))
                        .filter(p => p.state !== 'closed')
                        .map(p => `${p.id || p.className}: ${p.state}`),
                };
                throw ex;
            });
            const popupDoc = await waitFor(( ) => {
                const d = popupBrowser.contentDocument;
                if ( !d || d.readyState !== 'complete' || !d.body ) { return null; }
                if ( d.body.classList.contains('loading') ) { return null; }
                const hostname = d.getElementById('hostname');
                return hostname && hostname.textContent.trim() !== '' ? d : null;
            // uBO may be busy updating its lists after a first install.
            }, 30000, 'the popup page');
            await sleep(500);
            const popupRect = popupBrowser.getBoundingClientRect();
            report.popup = {
                url: popupDoc.documentURI,
                width: Math.round(popupRect.width),
                height: Math.round(popupRect.height),
                // uBO puts soft hyphens in hostnames, as line break points.
                hostname: popupDoc.getElementById('hostname').textContent.replace(/­/g, '').trim(),
                layout: popupDoc.documentElement.className,
            };
            report.popupScreenshot = saveScreenshot(win, popupDoc.defaultView, {
                left: 0, top: 0, width: popupRect.width, height: popupRect.height,
            }, 'popup.png');
            Cu.waiveXrays(popupDoc.defaultView).vAPI.closePopup();
            report.popupClosedItself = await waitFor(
                ( ) => findPopupBrowser() === null,
                5000, 'the popup to close'
            ).catch(( ) => false);
            report.browserWindowStillOpen = win.closed === false;
        });

        // A popup left open would take the context menu's clicks.
        for ( const panel of win.document.querySelectorAll('panel') ) {
            if ( panel.state === 'open' ) { panel.hidePopup(); }
        }

        // Context menu: on a link to subscribe to a list, then on an element
        await section('menus', async ( ) => {
            const onLink = await openContextMenu(win, page.doc.getElementById('subscribe'));
            report.menuOnSubscribeLink = onLink.labels;
            onLink.menu.hidePopup();
            await sleep(300);
            const onElement = await openContextMenu(win, page.doc.getElementById('target'));
            report.menuOnElement = onElement.labels;
            if ( onElement.items.length !== 0 ) {
                onElement.items[0].doCommand();
            }
            onElement.menu.hidePopup();
            const frameURLs = ( ) => Array.from(page.doc.querySelectorAll('iframe'),
                f => f.contentDocument ? f.contentDocument.documentURI : 'no document'
            );
            report.pickerStarted = await waitFor(
                ( ) => frameURLs().some(url => url.includes('/epicker-ui.html')),
                10000, 'the element picker'
            ).catch(( ) => false);
            report.pageFrames = frameURLs();
        });

        // Keyboard shortcut
        await section('shortcut', async ( ) => {
            report.commands = (await callBackground(bgWindow, 'commands.getAll')).value;
            report.shortcutUpdate = await callBackground(bgWindow, 'commands.update', {
                name: 'launch-logger',
                shortcut: 'Alt+Shift+L',
            });
            const key = win.document.querySelector('#ublock0-commands > key');
            report.shortcutKey = key
                ? `${key.getAttribute('modifiers')} ${key.getAttribute('key')}`
                : 'none';
            if ( key ) { key.doCommand(); }
            const loggerTab = await waitFor(
                ( ) => openTabs().find(t => t.linkedBrowser.currentURI.spec.includes('logger-ui.html')),
                10000, 'the logger'
            ).catch(( ) => null);
            report.loggerOpened = loggerTab !== null;
            if ( loggerTab !== null ) {
                const loggerWindow = loggerTab.ownerGlobal;
                if ( loggerWindow.gBrowser.tabs.length === 1 ) {
                    loggerWindow.close();
                } else {
                    loggerWindow.gBrowser.removeTab(loggerTab);
                }
            }
            await callBackground(bgWindow, 'commands.reset', 'launch-logger');
            report.shortcutAfterReset = win.document.getElementById('ublock0-commands') === null
                ? 'none'
                : 'still there';
        });

        // Options: about:addons' Options button opens the dashboard in a
        // tab, and so does runtime.openOptionsPage(). The dashboard keeps
        // its pane in the URL's fragment.
        await section('options', async ( ) => {
            const { AddonManager } = Cu.import('resource://gre/modules/AddonManager.jsm', {});
            const dashboardURL = ext.getURL('dashboard.html');
            const dashboardTabs = ( ) => openTabs().filter(t =>
                t.linkedBrowser.currentURI.specIgnoringRef === dashboardURL
            );
            // A selected dashboard tab whose page has uBO's API.
            const dashboardOpened = ( ) => waitFor(( ) => {
                const tab = dashboardTabs().find(t => t.ownerGlobal.gBrowser.selectedTab === t);
                const d = tab && tab.linkedBrowser.contentDocument;
                return d && d.readyState === 'complete' &&
                    typeof Cu.waiveXrays(d.defaultView).vAPI === 'object';
            }, 15000, 'the dashboard').catch(( ) => false);
            const closeDashboards = ( ) => {
                for ( const tab of dashboardTabs() ) {
                    tab.ownerGlobal.gBrowser.removeTab(tab);
                }
            };
            const addon = await new Promise(resolve => { AddonManager.getAddonByID(ext.id, resolve); });
            report.addonOptions = {
                inTab: addon.optionsType === AddonManager.OPTIONS_TYPE_TAB,
                isDashboard: addon.optionsURL === dashboardURL,
                type: addon.optionsType,
                url: addon.optionsURL,
            };
            const options = report.options = {};
            win.BrowserOpenAddonsMgr('addons://list/extension');
            // A generous wait: uBO's first update cycle runs about now, and
            // compiling a fresh list blocks the main thread for seconds.
            const manager = await waitFor(( ) => {
                const tab = openTabs().find(t => t.linkedBrowser.currentURI.spec.startsWith('about:addons'));
                const w = tab && tab.linkedBrowser.contentWindow;
                const view = w && w.gViewController && w.gViewController.currentViewObj;
                const item = view && typeof view.getListItemForID === 'function'
                    ? view.getListItemForID(ext.id)
                    : null;
                return item ? { tab, doc: w.document, item } : null;
            }, 30000, 'the Add-ons Manager');
            const optionsButton = manager.doc.getAnonymousElementByAttribute(
                manager.item, 'anonid', 'preferences-btn'
            );
            options.button = optionsButton === null ? 'none' : optionsButton.hidden ? 'hidden' : 'shown';
            optionsButton.doCommand();
            options.fromAddonsManager = await dashboardOpened();
            closeDashboards();
            manager.tab.ownerGlobal.gBrowser.removeTab(manager.tab);
            options.openOptionsPage = await callBackground(bgWindow, 'runtime.openOptionsPage');
            options.fromAPI = await dashboardOpened();
            closeDashboards();
        });
        page.close();
    } catch (ex) {
        failure = String(ex);
    }
    server.stop();
    const pass = (ok, value) => ok ? 'PASS' : `FAIL: ${JSON.stringify(value)}`;
    const { button, popup } = report;
    checks.button = pass(button && /^nav-bar/.test(button.parent || ''), button && button.parent);
    checks.badge = pass(button && /^[1-9]\d*$/.test(button.badge) && button.badge === report.badgeFromAPI,
        button && [ button.badge, report.badgeFromAPI ]);
    checks.popup = pass(popup && popup.hostname === '127.0.0.1' && popup.width > 100 && popup.height > 100, popup);
    checks.popupClosedItself = pass(report.popupClosedItself === true && report.browserWindowStillOpen, report.popupClosedItself);
    checks.menuOnSubscribeLink = pass((report.menuOnSubscribeLink || []).length === 2, report.menuOnSubscribeLink);
    checks.menuOnElement = pass((report.menuOnElement || []).length === 1, report.menuOnElement);
    checks.pickerStarted = pass(report.pickerStarted === true, report.pickerStarted);
    checks.commands = pass(Array.isArray(report.commands) && report.commands.length === 8, report.commands);
    checks.shortcut = pass(report.shortcutKey === 'alt,shift L' && report.loggerOpened, [ report.shortcutKey, report.loggerOpened ]);
    checks.shortcutReset = pass(report.shortcutAfterReset === 'none', report.shortcutAfterReset);
    const { addonOptions, options = {} } = report;
    checks.addonOptions = pass(addonOptions && addonOptions.inTab && addonOptions.isDashboard && options.button === 'shown',
        [ addonOptions, options.button ]);
    checks.optionsButton = pass(options.fromAddonsManager === true, options.fromAddonsManager);
    checks.openOptionsPage = pass(options.openOptionsPage && options.openOptionsPage.error === undefined &&
        options.fromAPI === true, [ options.openOptionsPage, options.fromAPI ]);
    report.summary = {
        app: `${Services.appinfo.name} ${Services.appinfo.version}`,
        checks,
        button: report.button,
        popup: report.popup,
        options: report.options,
        menuOnSubscribeLink: report.menuOnSubscribeLink,
        menuOnElement: report.menuOnElement,
        sectionErrors: report.errors,
        popupDebug: report.popupDebug,
        pageFrames: report.pageFrames,
        screenshots: [ report.toolbarScreenshot, report.popupScreenshot ].filter(Boolean),
        ownErrors: ownErrors(consoleLines),
    };
    if ( failure !== null ) {
        report.error = failure;
    }
    return report;
};

/******************************************************************************/

// Filtering: what uBO does only on Firefox, on pages served as
// uxp-filtering.test (see the cosmetic scenario for why not 127.0.0.1).
// HTML filtering, also of a gzip-encoded page, and replace=, both through
// webRequest.filterResponseData(); redirect= to a web-accessible resource,
// and a page loading those with and without uBO's secret; header=; csp=
// and permissions=; strict blocking to document-blocked.html; dns.resolve(),
// and CNAME uncloaking of a real public hostname (skipped when its CNAME
// cannot be looked up); the privacy settings uBO controls.

const FILTERING_HOST = 'uxp-filtering.test';
// A public hostname whose CNAME chain ends on Akamai's akamaiedge.net.
const CNAME_HOST = 'www.microsoft.com';
const CNAME_DOMAIN = 'akamaiedge.net';

const FILTERING_FILTERS = [
    `${FILTERING_HOST}##^#uxp-html-removed`,
    `${FILTERING_HOST}##^script:has-text(uxpInlineAd)`,
    `||${FILTERING_HOST}^*/replace.js$script,replace=/uxpBefore/uxpAfter/`,
    `||${FILTERING_HOST}^*/redirect.js$script,redirect=noop.js`,
    `||${FILTERING_HOST}^*/header.js$script,header=x-uxp-test:blocked`,
    `||${FILTERING_HOST}^*/csp.html$csp=script-src 'none'`,
    `||${FILTERING_HOST}^*/permissions.html$permissions=geolocation=()`,
    `||${FILTERING_HOST}^*/strict.html$document`,
    `||${CNAME_DOMAIN}^$image`,
];
// replace= takes trusted filters only.
const FILTERING_USER_SETTINGS = [ [ 'userFiltersTrusted', 'true' ] ];

// `text` (ASCII) gzip-compressed, as a binary string, by Gecko's own
// converter; null where there is none.
const gzipOf = function(text) {
    let converter;
    try {
        converter = Cc['@mozilla.org/streamconv;1?from=uncompressed&to=gzip']
            .createInstance(Ci.nsIStreamConverter);
    } catch {
        return null;
    }
    const chunks = [];
    converter.asyncConvertData('uncompressed', 'gzip', {
        onStartRequest() {},
        onDataAvailable(...args) {
            const [ stream, , count ] = args.slice(-3);
            const binary = Cc['@mozilla.org/binaryinputstream;1']
                .createInstance(Ci.nsIBinaryInputStream);
            binary.setInputStream(stream);
            chunks.push(binary.readBytes(count));
        },
        onStopRequest() {},
        QueryInterface: XPCOMUtils.generateQI([ Ci.nsIStreamListener, Ci.nsIRequestObserver ]),
    }, null);
    const input = Cc['@mozilla.org/io/string-input-stream;1']
        .createInstance(Ci.nsIStringInputStream);
    input.setData(text, text.length);
    converter.onStartRequest(null, null);
    converter.onDataAvailable(null, null, input, 0, text.length);
    converter.onStopRequest(null, null, Components.results.NS_OK);
    return chunks.join('');
};

const GZIP_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>uxp-gzip</title></head>' +
    '<body><div id="uxp-html-removed">removed</div><div id="uxp-html-kept">kept</div></body></html>';

const filteringRoutes = function(path) {
    const html = body => ({ type: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8">${body}</html>` });
    const script = (body, headers) => ({ type: 'application/javascript', body, headers });
    const dataset = 'document.documentElement.dataset';
    switch ( path ) {
    case '/filtering.html':
        return html(`<title>uxp-filtering</title>
<script>window.uxpInlineAd = true;</script>
<script src="/replace.js"></script>
<script src="/redirect.js" onload="${dataset}.redirect = 'loaded'" onerror="${dataset}.redirect = 'error'"></script>
<script src="/header.js" onload="${dataset}.header = 'loaded'" onerror="${dataset}.header = 'error'"></script>
</head><body>
<div id="uxp-html-removed">removed</div><div id="uxp-html-kept">kept</div>
<script>
${dataset}.results = JSON.stringify({
    htmlRemoved: document.getElementById('uxp-html-removed') === null,
    htmlKept: document.getElementById('uxp-html-kept') !== null,
    // Not spelled out here: this script would match the has-text() filter.
    inlineScriptRan: window['uxpInline' + 'Ad'] === true,
    replaced: window.uxpReplaced,
    redirectedScriptRan: window.uxpRedirectedScriptRan === true,
    headerScriptRan: window.uxpHeaderScriptRan === true,
});
</script></body>`);
    case '/gzip.html': {
        const gzipped = gzipOf(GZIP_PAGE);
        return gzipped === null
            ? { type: 'text/html; charset=utf-8', body: GZIP_PAGE }
            : { type: 'text/html; charset=utf-8', body: gzipped, headers: [ 'Content-Encoding: gzip' ] };
    }
    case '/cname.html':
        return html(`</head><body><img src="https://${CNAME_HOST}/favicon.ico"
onload="${dataset}.cname = 'loaded'" onerror="${dataset}.cname = 'error'"></body>`);
    case '/csp.html':
        return html(`</head><body><script>${dataset}.scriptRan = 'true';</script></body>`);
    case '/permissions.html':
    case '/strict.html':
        return html('</head><body>uxp</body>');
    case '/replace.js':
        return script("window.uxpReplaced = 'uxpBefore';");
    case '/redirect.js':
        return script('window.uxpRedirectedScriptRan = true;');
    case '/header.js':
        return script('window.uxpHeaderScriptRan = true;', [ 'X-Uxp-Test: blocked' ]);
    default:
        return null;
    }
};

// Response headers as webRequest listeners see them once uBO's
// onHeadersReceived has changed them: from an onResponseStarted listener in
// uBO's own page.
const recordResponseHeaders = function(bgWindow, host) {
    const page = Cu.waiveXrays(bgWindow);
    const seen = new Map();
    const listener = Cu.exportFunction(details => {
        const { url, responseHeaders } = Cu.waiveXrays(details);
        const match = /^https?:\/\/([^/:]+)(?::\d+)?(\/[^?#]*)/.exec(url);
        if ( match === null || match[1] !== host ) { return; }
        seen.set(match[2], plain(responseHeaders));
    }, page);
    page.browser.webRequest.onResponseStarted.addListener(
        listener,
        Cu.cloneInto({ urls: [ 'http://*/*' ] }, page),
        Cu.cloneInto([ 'responseHeaders' ], page)
    );
    return {
        get(path, name) {
            const found = (seen.get(path) || []).find(h => h.name.toLowerCase() === name);
            return found ? found.value : null;
        },
        stop() {
            page.browser.webRequest.onResponseStarted.removeListener(listener);
        },
    };
};

const runFiltering = async function() {
    const report = {};
    const checks = {};
    const section = sectionRunner(report);
    let failure = null;
    let headers = null;
    const server = new TestServer(filteringRoutes);
    server.start();
    const base = `http://${FILTERING_HOST}:${server.port}`;
    try {
        const { ext, bgWindow, µb } = await whenUBOReady();
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        headers = recordResponseHeaders(bgWindow, FILTERING_HOST);

        // HTML filtering, replace=, redirect=, header=; web-accessible
        // resources loaded by the page itself
        await section('page', async ( ) => {
            const page = await openTab(`${base}/filtering.html`);
            const data = page.doc.documentElement.dataset;
            report.page = Object.assign(JSON.parse(data.results || '{}'), {
                redirect: data.redirect,
                header: data.header,
            });
            const secret = Cu.waiveXrays(bgWindow).vAPI.warSecret.short();
            report.webAccessible = {
                withSecret: await pageLoadsImage(page.doc, ext.getURL(`web_accessible_resources/1x1.gif?secret=${secret}`)),
                withoutSecret: await pageLoadsImage(page.doc, ext.getURL('web_accessible_resources/1x1.gif')),
                notWebAccessible: await pageLoadsImage(page.doc, ext.getURL('img/icon_16.png')),
            };
            page.close();
        });

        await section('gzip', async ( ) => {
            const page = await openTab(`${base}/gzip.html`);
            report.gzip = {
                encoded: gzipOf('uxp') !== null,
                htmlRemoved: page.doc.getElementById('uxp-html-removed') === null,
                htmlKept: page.doc.getElementById('uxp-html-kept') !== null,
            };
            page.close();
        });

        await section('headers', async ( ) => {
            const csp = await openTab(`${base}/csp.html`);
            report.csp = {
                scriptRan: csp.doc.documentElement.dataset.scriptRan === 'true',
                header: headers.get('/csp.html', 'content-security-policy'),
            };
            csp.close();
            const permissions = await openTab(`${base}/permissions.html`);
            report.permissions = { header: headers.get('/permissions.html', 'permissions-policy') };
            permissions.close();
        });

        // Strict blocking: uBO puts its warning page in the tab instead.
        await section('strict', async ( ) => {
            const tab = win.gBrowser.addTab(`${base}/strict.html`);
            win.gBrowser.selectedTab = tab;
            const doc = await waitFor(( ) => {
                const d = tab.linkedBrowser.contentDocument;
                const shown = d && d.readyState === 'complete' && d.getElementById('theURL');
                return shown && shown.textContent.includes('strict.html') ? d : null;
            }, 15000, 'document-blocked.html');
            report.strict = {
                page: doc.documentURI.replace(/\?.*$/, ''),
                isDocumentBlocked: doc.documentURI.startsWith(ext.getURL('document-blocked.html?')),
                extensionPrincipal: doc.nodePrincipal.originNoSuffix === ext.origin,
            };
            win.gBrowser.removeTab(tab);
        });

        await section('dns', async ( ) => {
            report.dns = {
                localhost: await callBackground(bgWindow, 'dns.resolve', 'localhost'),
                unknownHost: await callBackground(bgWindow, 'dns.resolve', 'uxp-no-such-host.invalid'),
                cname: await callBackground(bgWindow, 'dns.resolve', CNAME_HOST, [ 'canonical_name' ]),
            };
        });

        // CNAME uncloaking: the image's hostname is not filtered, its CNAME is.
        await section('cname', async ( ) => {
            const record = report.dns && report.dns.cname && report.dns.cname.value;
            report.cname = { canonicalName: record && record.canonicalName || null };
            if ( (report.cname.canonicalName || '').endsWith(`.${CNAME_DOMAIN}`) === false ) { return; }
            const page = await openTab(`${base}/cname.html`);
            report.cname.image = page.doc.documentElement.dataset.cname || 'not settled';
            report.cname.uboCanonicalName =
                Cu.waiveXrays(bgWindow).vAPI.net.canonicalNameFromHostname(CNAME_HOST) || null;
            // uBO counts its requests a moment after it has filtered them.
            const tabId = ext.tabTracker.getId(page.tab.linkedBrowser);
            report.cname.blockedOnPage = await waitFor(( ) => {
                const pageStore = µb.pageStoreFromTabId(tabId);
                return pageStore ? pageStore.counts.blocked.any : null;
            }, 5000, 'the blocked count').catch(( ) => 0);
            page.close();
        });

        // A stream filter for no request fails, with an event.
        await section('streamFilter', async ( ) => {
            const page = Cu.waiveXrays(bgWindow);
            const filter = Cu.waiveXrays(page.browser.webRequest.filterResponseData('uxp-no-such-request'));
            report.streamFilterError = await new Promise(resolve => {
                const timer = setTimeout(( ) => {
                    resolve({ status: filter.status, error: 'no error event' });
                }, 5000);
                filter.onerror = Cu.exportFunction(( ) => {
                    clearTimeout(timer);
                    resolve({ status: filter.status, error: filter.error });
                }, page);
            });
        });

        await section('privacy', async ( ) => {
            report.privacyPrefs = Object.fromEntries([
                'network.prefetch-next', 'network.dns.disablePrefetch',
                'network.http.speculative-parallel-limit', 'network.predictor.enabled',
                'browser.send_pings',
            ].map(name => [ name, readAnyPref(name) ]));
            const get = name => callBackground(bgWindow, `privacy.${name}.get`, {})
                .then(r => r.error !== undefined ? r : r.value);
            report.privacyAPI = {
                networkPredictionEnabled: await get('network.networkPredictionEnabled'),
                hyperlinkAuditingEnabled: await get('websites.hyperlinkAuditingEnabled'),
            };
            report.privacyStored = Object.keys(JSON.parse(readAnyPref('extensions.ublock0.privacySettings') || '{}'));
            // A setting set, then cleared: its pref comes back to what it was.
            const referrers = 'websites.referrersEnabled';
            const pref = 'network.http.sendRefererHeader';
            report.privacyClear = { before: await get(referrers) };
            report.privacyClear.set = (await callBackground(bgWindow, `privacy.${referrers}.set`, { value: false })).value;
            report.privacyClear.prefWhenSet = readAnyPref(pref);
            report.privacyClear.cleared = (await callBackground(bgWindow, `privacy.${referrers}.clear`, {})).value;
            report.privacyClear.prefUserSetAfter = Services.prefs.prefHasUserValue(pref);
            report.privacyClear.after = await get(referrers);
        });

        // Last, as it restarts the extension: stopping it gives the user's
        // values back (as when it is disabled), starting it applies uBO's
        // again.
        headers.stop();
        headers = null;
        await section('privacyRestore', async ( ) => {
            // One of the prefs uBO sets, whose default in this browser is
            // not what uBO sets.
            const [ pref, uboValue ] = [
                [ 'network.prefetch-next', false ],
                [ 'network.dns.disablePrefetch', true ],
                [ 'network.predictor.enabled', false ],
                [ 'network.http.speculative-parallel-limit', 0 ],
            ].find(([ name, value ]) => {
                const defaultValue = readDefaultPref(name);
                return defaultValue !== null && defaultValue !== value;
            }) || [];
            if ( pref === undefined ) {
                report.privacyRestore = { skipped: 'every pref already defaults to what uBO sets' };
                return;
            }
            const changes = [];
            const observer = {
                observe: ( ) => { changes.push(readAnyPref(pref)); },
            };
            Services.prefs.addObserver(pref, observer, false);
            try {
                const before = extension;
                Cu.waiveXrays(bgWindow).browser.runtime.reload();
                await waitFor(( ) => extension !== null && extension !== before, 30000, 'the extension to restart');
                await whenUBOReady();
            } finally {
                Services.prefs.removeObserver(pref, observer);
            }
            report.privacyRestore = {
                pref,
                defaultValue: readDefaultPref(pref),
                uboValue,
                changes,
                final: readAnyPref(pref),
            };
        });
    } catch (ex) {
        failure = String(ex);
    }
    if ( headers !== null ) { headers.stop(); }
    server.stop();

    const pass = (ok, value) => ok ? 'PASS' : `FAIL: ${JSON.stringify(value)}`;
    const served = path => server.requests.some(r => r.endsWith(path));
    const page = report.page || {};
    checks.htmlFiltering = pass(page.htmlRemoved === true && page.htmlKept === true && page.inlineScriptRan === false, page);
    const gzip = report.gzip || {};
    checks.htmlFilteringGzip = gzip.encoded === false
        ? 'SKIP: no gzip converter'
        : pass(gzip.htmlRemoved === true && gzip.htmlKept === true, gzip);
    checks.replace = pass(page.replaced === 'uxpAfter', page.replaced);
    checks.redirect = pass(page.redirect === 'loaded' && page.redirectedScriptRan === false && served('/redirect.js') === false,
        [ page.redirect, page.redirectedScriptRan, served('/redirect.js') ]);
    const war = report.webAccessible || {};
    checks.webAccessible = pass(war.withSecret === 'loaded' && war.withoutSecret === 'error' && war.notWebAccessible === 'error', war);
    checks.header = pass(page.header === 'error' && page.headerScriptRan === false, [ page.header, page.headerScriptRan ]);
    const csp = report.csp || {};
    checks.csp = pass(csp.scriptRan === false && /script-src 'none'/.test(csp.header || ''), csp);
    const permissions = report.permissions || {};
    checks.permissions = pass(/geolocation=\(\)/.test(permissions.header || ''), permissions);
    const strict = report.strict || {};
    checks.strictBlocking = pass(strict.isDocumentBlocked === true && strict.extensionPrincipal === true && served('/strict.html') === false,
        [ strict, served('/strict.html') ]);
    const dns = report.dns || {};
    checks.dns = pass(
        dns.localhost && dns.localhost.value && dns.localhost.value.addresses.length !== 0 &&
        dns.unknownHost && dns.unknownHost.error === 'NS_ERROR_UNKNOWN_HOST',
        [ dns.localhost, dns.unknownHost ]);
    const cname = report.cname || {};
    checks.cnameUncloaking = cname.image === undefined
        ? `SKIP: no ${CNAME_DOMAIN} CNAME for ${CNAME_HOST} here (${JSON.stringify(dns.cname)})`
        : pass(cname.image === 'error' && (cname.uboCanonicalName || '').endsWith(CNAME_DOMAIN) && cname.blockedOnPage >= 1, cname);
    const streamError = report.streamFilterError || {};
    checks.streamFilterError = pass(streamError.status === 'failed' && streamError.error === 'Invalid request ID', streamError);
    const prefs = report.privacyPrefs || {};
    const api = report.privacyAPI || {};
    const controlledOff = s => s !== undefined && s.value === false && s.levelOfControl === 'controlled_by_this_extension';
    checks.privacySettings = pass(
        prefs['network.prefetch-next'] === false && prefs['network.dns.disablePrefetch'] === true &&
        prefs['network.http.speculative-parallel-limit'] === 0 && prefs['network.predictor.enabled'] !== true &&
        prefs['browser.send_pings'] === false &&
        controlledOff(api.networkPredictionEnabled) && controlledOff(api.hyperlinkAuditingEnabled),
        [ prefs, api ]);
    const clear = report.privacyClear || {};
    checks.privacyClear = pass(
        clear.set === true && clear.prefWhenSet === 0 && clear.cleared === true &&
        clear.prefUserSetAfter === false && clear.after !== undefined && clear.after.value === true &&
        clear.after.levelOfControl === 'controllable_by_this_extension',
        clear);
    // The pref goes back to the browser's default, then to uBO's value.
    const restore = report.privacyRestore || {};
    checks.privacyRestore = restore.skipped !== undefined
        ? `SKIP: ${restore.skipped}`
        : pass(
            Array.isArray(restore.changes) && restore.changes.includes(restore.defaultValue) &&
            restore.final === restore.uboValue,
            restore);
    report.summary = {
        app: `${Services.appinfo.name} ${Services.appinfo.version}`,
        checks,
        page: report.page,
        webAccessible: report.webAccessible,
        csp: report.csp,
        permissions: report.permissions,
        strict: report.strict,
        cname: report.cname,
        privacyStored: report.privacyStored,
        privacyRestore: report.privacyRestore,
        sectionErrors: report.errors,
        serverRequests: server.requests,
        ownErrors: ownErrors(consoleLines),
    };
    if ( failure !== null ) {
        report.error = failure;
    }
    return report;
};

/******************************************************************************/

// Uninstall: what uBO leaves behind once removed -- as with Firefox's
// WebExtensions, nothing but the admin's managed storage. The add-on
// removes itself; this code runs on from its unloaded scope, without the
// console mirror (bootstrap.js stops the harness).

const UBO_PRIVACY_PREFS = [
    'network.prefetch-next', 'network.dns.disablePrefetch',
    'network.http.speculative-parallel-limit', 'network.predictor.enabled',
    'browser.send_pings',
];

// Whether the browser's own (chrome) origin has an IndexedDB database of
// that name. Opening a missing one creates it: it is deleted again.
// (Aborting its creation instead makes Gecko report an internal error.)
const databaseExists = name => new Promise(resolve => {
    let created = false;
    const request = indexedDB.open(name);
    request.onupgradeneeded = event => {
        created = event.oldVersion === 0;
    };
    request.onsuccess = ( ) => {
        request.result.close();
        if ( created === false ) {
            resolve(true);
            return;
        }
        const deletion = indexedDB.deleteDatabase(name);
        deletion.onsuccess = deletion.onerror = ( ) => { resolve(false); };
    };
    request.onerror = event => {
        event.preventDefault();
        resolve(false);
    };
});

// What the add-on keeps in the profile.
const leftovers = async function(addonId, uuid) {
    const originStorage = [];
    const dir = Services.dirsvc.get('ProfD', Ci.nsIFile);
    dir.append('storage');
    dir.append('default');
    if ( dir.exists() ) {
        const entries = dir.directoryEntries;
        while ( entries.hasMoreElements() ) {
            const entry = entries.getNext().QueryInterface(Ci.nsIFile);
            if ( entry.leafName.startsWith(`moz-extension+++${uuid}`) ) {
                originStorage.push(entry.leafName);
            }
        }
    }
    let buttonPlacement = null;
    try {
        const { CustomizableUI } = Cu.import('resource:///modules/CustomizableUI.jsm', {});
        buttonPlacement = CustomizableUI.getPlacementOfWidget('ublock0-button', false, true);
    } catch {
        const doc = 'chrome://browser/content/browser.xul';
        const store = Cc['@mozilla.org/xul/xulstore;1'].getService(Ci.nsIXULStore);
        const ids = store.getIDsEnumerator(doc);
        while ( ids.hasMore() ) {
            const id = ids.getNext();
            if ( store.getValue(doc, id, 'currentset').includes('uBlock0-legacy-button') ) {
                buttonPlacement = { toolbar: id };
            }
        }
    }
    return {
        prefs: Services.prefs.getChildList('extensions.ublock0.', {})
            .filter(name => Services.prefs.prefHasUserValue(name))
            .sort(),
        originStorage,
        storageLocal: await databaseExists(`uxp-webext-storage:${addonId}`),
        buttonPlacement,
        privacyPrefsSet: UBO_PRIVACY_PREFS.filter(name => Services.prefs.prefHasUserValue(name)),
    };
};

// disableFirst: removed while disabled, when the runtime is not loaded.
const runUninstall = async function(disableFirst) {
    const report = {};
    const checks = {};
    let failure = null;
    try {
        const { ext } = await whenUBOReady();
        const { id, uuid } = ext;
        await sleep(2000);
        report.before = await leftovers(id, uuid);
        const { AddonManager } = Cu.import('resource://gre/modules/AddonManager.jsm', {});
        const addon = await new Promise(resolve => { AddonManager.getAddonByID(id, resolve); });
        const uninstallStarted = Date.now();
        if ( disableFirst ) {
            addon.userDisabled = true;
            await sleep(1000);
            report.afterDisable = await leftovers(id, uuid);
        }
        addon.uninstall();
        // QuotaManager clears the origin's storage asynchronously.
        const deadline = Date.now() + 10000;
        do {
            await sleep(500);
            report.after = await leftovers(id, uuid);
        } while ( report.after.originStorage.length !== 0 && Date.now() < deadline );
        report.addonGone = await new Promise(resolve => {
            AddonManager.getAddonByID(id, found => { resolve(found === null); });
        });
        report.errorsDuringUninstall = (Services.console.getMessageArray() || [])
            .filter(m => m instanceof Ci.nsIScriptError && m.timeStamp >= uninstallStarted &&
                (m.flags & Ci.nsIScriptError.warningFlag) === 0)
            .map(m => `+${m.timeStamp - uninstallStarted} ms [${m.category}, window ${m.innerWindowID}] ` +
                `${m.errorMessage} @ ${m.sourceName}:${m.lineNumber}`);
    } catch (ex) {
        failure = String(ex);
    }
    const pass = (ok, value) => ok ? 'PASS' : `FAIL: ${JSON.stringify(value)}`;
    const { before = {}, after = {} } = report;
    checks.somethingToRemove = pass(
        (before.prefs || []).includes('extensions.ublock0.uuid') &&
        (before.originStorage || []).length !== 0 &&
        before.storageLocal === true && before.buttonPlacement !== null,
        before);
    // As in Firefox: disabled, the data stays; the privacy prefs are the
    // user's again.
    if ( disableFirst ) {
        const disabled = report.afterDisable || {};
        checks.disableKeepsData = pass(
            (disabled.prefs || []).includes('extensions.ublock0.uuid') &&
            (disabled.originStorage || []).length !== 0 && disabled.storageLocal === true &&
            Array.isArray(disabled.privacyPrefsSet) && disabled.privacyPrefsSet.length === 0,
            disabled);
    }
    checks.addonRemoved = pass(report.addonGone === true, report.addonGone);
    checks.prefs = pass(
        JSON.stringify(after.prefs) === JSON.stringify([ 'extensions.ublock0.managedStorage' ]),
        after.prefs);
    checks.originStorage = pass(Array.isArray(after.originStorage) && after.originStorage.length === 0, after.originStorage);
    checks.storageLocal = pass(after.storageLocal === false, after.storageLocal);
    checks.buttonPlacement = pass(after.buttonPlacement === null, after.buttonPlacement);
    checks.privacyPrefs = pass(Array.isArray(after.privacyPrefsSet) && after.privacyPrefsSet.length === 0, after.privacyPrefsSet);
    checks.noErrors = pass(Array.isArray(report.errorsDuringUninstall) && report.errorsDuringUninstall.length === 0,
        report.errorsDuringUninstall);
    report.summary = {
        app: `${Services.appinfo.name} ${Services.appinfo.version}`,
        checks,
        before,
        afterDisable: report.afterDisable,
        after,
        errorsDuringUninstall: report.errorsDuringUninstall,
    };
    if ( failure !== null ) {
        report.error = failure;
    }
    return report;
};

/******************************************************************************/

// The release's update manifest (tools/make-uxp.mjs writes it), read by this
// browser's own update checker as if from GitHub: what it offers here.
const runUpdate = async function() {
    const report = {};
    const checks = {};
    let failure = null;
    const expected = JSON.parse(getPref('updateExpected', '{}'));
    let manifest = '';
    const server = new TestServer(path =>
        path === '/update.rdf' ? { type: 'text/xml', body: manifest } : null
    );
    try {
        const { ext } = await whenUBOReady();
        manifest = readBytes(getPref('updateManifest', ''));
        server.start();
        const { AddonManager } = Cu.import('resource://gre/modules/AddonManager.jsm', {});
        const { AddonUpdateChecker } = Cu.import('resource://gre/modules/addons/AddonUpdateChecker.jsm', {});
        const updates = await new Promise((resolve, reject) => {
            AddonUpdateChecker.checkForUpdates(ext.id, null, `http://127.0.0.1:${server.port}/update.rdf`, {
                onUpdateCheckComplete: resolve,
                onUpdateCheckError: status => { reject(new Error(`update check error ${status}`)); },
            });
        });
        const describe = update => ({
            version: update.version,
            updateURL: update.updateURL || null,
            updateHash: update.updateHash || null,
            apps: Array.from(update.targetApplications, app => `${app.id} ${app.minVersion} - ${app.maxVersion}`),
        });
        report.updates = Array.from(updates, describe);
        const offered = AddonUpdateChecker.getNewestCompatibleUpdate(updates);
        report.offered = offered ? describe(offered) : null;
        const addon = await new Promise(resolve => { AddonManager.getAddonByID(ext.id, resolve); });
        report.installed = { version: addon.version, updateURL: addon.updateURL || null };
    } catch (ex) {
        failure = String(ex);
    } finally {
        server.stop();
    }
    const pass = (ok, value) => ok ? 'PASS' : `FAIL: ${JSON.stringify(value)}`;
    const { updates = [], offered = null, installed = {} } = report;
    checks.parsed = pass(updates.length !== 0 && updates.every(u => u.version === expected.version), updates);
    checks.offered = pass(offered !== null && offered.version === expected.version, offered);
    // The release's own asset, under the tag of its version.
    const link = offered !== null ? offered.updateURL : null;
    checks.downloadLink = pass(link !== null && link.startsWith('https://github.com/') &&
        link.endsWith(`/releases/download/${expected.version}/${expected.file}`), link);
    const hash = offered !== null ? offered.updateHash : null;
    checks.hash = pass(hash === expected.hash, hash);
    checks.debugBuildNeverUpdates = pass(installed.updateURL === null, installed);
    report.summary = {
        app: `${Services.appinfo.name} ${Services.appinfo.version}`,
        checks,
        offered,
        installed,
        updates,
    };
    if ( failure !== null ) {
        report.error = failure;
    }
    return report;
};

/******************************************************************************/

// Stop while busy: uBO disabled while a page loads, once while it boots
// (the runtime holds the page's requests for uBO's answer), once while it
// filters (its HTML filter reading the page's document, half arrived). The
// pages must still finish, whole, the runtime must log nothing once
// stopped, and uBO must block again once re-enabled. The add-on that comes
// back runs no scenario: this harness drives on to the end.

const STOP_HOST = 'uxp-stop.test';
const STOP_FILTERS = [
    `||${STOP_HOST}^*/uxp-blocked/`,
    `${STOP_HOST}##^#uxp-stop-removed`,
];
const RUNTIME_SOURCE = /^chrome:\/\/ublock0\/content\/uxp\/|\/bootstrap\.js$/;
const UBO_SOURCE = /^moz-extension:\/\//;

const stopRoutes = function(path) {
    const svg = color => ({
        type: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${color}"/></svg>`,
    });
    switch ( path ) {
    // Its two halves arrive 3 s apart; its slow image and XHR, 3 s late.
    case '/busy.html':
        return {
            type: 'text/html; charset=utf-8',
            body: `<!doctype html><html><head><meta charset="utf-8"><title>busy</title></head><body>
<img id="okImage" src="/ok/image.svg"><img id="adImage" src="/uxp-blocked/ad.svg"><img id="slowImage" src="/slow/image.svg">
<div id="uxp-stop-removed">removed by an HTML filter</div>
<script>${recorderScript(`
const xhr = new XMLHttpRequest();
xhr.open('GET', '/slow/xhr.txt');
xhr.onload = ( ) => { results.slowXHR = xhr.status; save(); };
xhr.onerror = ( ) => { results.slowXHR = 'error'; save(); };
xhr.send();`)}</script>
<p id="filler">${'uxp '.repeat(8192)}</p><p id="tail">end</p></body></html>`,
            splitDelayMs: 3000,
        };
    case '/probe.html':
        return {
            type: 'text/html; charset=utf-8',
            body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
<img id="okImage" src="/ok/probe.svg"><img id="adImage" src="/uxp-blocked/probe.svg">
<script>${recorderScript('')}</script></body></html>`,
        };
    case '/ok/image.svg':
    case '/ok/probe.svg':
        return svg('green');
    case '/uxp-blocked/ad.svg':
    case '/uxp-blocked/probe.svg':
        return svg('red');
    case '/slow/image.svg':
        return { ...svg('blue'), delayMs: 3000 };
    case '/slow/xhr.txt':
        return { type: 'text/plain', body: 'slow', delayMs: 3000 };
    default:
        return null;
    }
};

// Errors logged since `since` by the runtime, and by uBO's own pages.
const errorsSince = function(since) {
    const out = { runtime: [], ubo: [] };
    for ( const m of Services.console.getMessageArray() || [] ) {
        if ( m instanceof Ci.nsIScriptError === false ) { continue; }
        if ( m.timeStamp < since || (m.flags & Ci.nsIScriptError.warningFlag) !== 0 ) { continue; }
        const text = `+${m.timeStamp - since} ms ${m.errorMessage} @ ${m.sourceName}:${m.lineNumber}`;
        if ( RUNTIME_SOURCE.test(m.sourceName) ) {
            out.runtime.push(text);
        } else if ( UBO_SOURCE.test(m.sourceName) ) {
            out.ubo.push(text);
        }
    }
    return out;
};

// A tab's test document once loaded, all its resources settled.
const finishedPage = async function(tab, timeout) {
    const doc = await waitFor(( ) => {
        const d = tab.linkedBrowser.contentDocument;
        return d && d.documentURI.startsWith('http') && d.readyState === 'complete' ? d : null;
    }, timeout, 'the page to finish loading').catch(( ) => null);
    if ( doc === null ) { return { finished: false }; }
    const results = ( ) => doc.body && doc.body.dataset.results ? JSON.parse(doc.body.dataset.results) : {};
    if ( doc.getElementById('slowImage') !== null ) {
        await waitFor(( ) => results().slowXHR !== undefined, 5000, 'the slow XHR').catch(( ) => null);
    }
    return {
        finished: true,
        whole: doc.getElementById('okImage') !== null &&
            (doc.getElementById('filler') === null || doc.getElementById('tail') !== null),
        htmlFiltered: doc.getElementById('slowImage') !== null && doc.getElementById('uxp-stop-removed') === null,
        results: results(),
    };
};

// Whether the add-on that came back blocks: probe pages until one loads
// without its blocked image ever reaching the server.
const probeBlocking = async function(win, server, timeout) {
    const started = Date.now();
    const adRequests = ( ) => server.requests.filter(r => r.endsWith('/uxp-blocked/probe.svg')).length;
    for ( let attempt = 1; Date.now() - started < timeout; attempt++ ) {
        const before = adRequests();
        const tab = win.gBrowser.addTab(`http://${STOP_HOST}:${server.port}/probe.html?n=${attempt}`);
        const page = await finishedPage(tab, Math.max(timeout - (Date.now() - started), 1000));
        win.gBrowser.removeTab(tab);
        if ( page.finished && adRequests() === before ) {
            return { blocked: true, afterMs: Date.now() - started, attempts: attempt };
        }
        await sleep(2000);
    }
    return { blocked: false, afterMs: Date.now() - started, leaked: adRequests() };
};

const runStopBusy = async function() {
    const report = {};
    const checks = {};
    let failure = null;
    const server = new TestServer(stopRoutes);
    server.start();
    try {
        const { AddonManager } = Cu.import('resource://gre/modules/AddonManager.jsm', {});
        const addon = await new Promise(resolve => { AddonManager.getAddonByID(addonData.id, resolve); });
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        const busyURL = n => `http://${STOP_HOST}:${server.port}/busy.html?n=${n}`;
        // The add-on that comes back: no scenario of its own, the same log.
        prefs.setCharPref('scenario', '');
        prefs.setBoolPref('keepConsoleLog', true);

        // Stopped while booting: uBO holds the page's requests.
        const ext = await waitFor(( ) => extension, 30000, 'the extension');
        const tab1 = win.gBrowser.addTab(busyURL(1));
        await sleep(2000);
        report.booting = {};
        try {
            report.booting.uboWasReady = Cu.waiveXrays(ext.background.window).µBlock.readyToFilter === true;
        } catch {
            report.booting.uboWasReady = false;
        }
        let stoppedAt = Date.now();
        addon.userDisabled = true;
        report.booting.page = await finishedPage(tab1, 20000);
        await sleep(2000);
        report.booting.errors = errorsSince(stoppedAt);
        win.gBrowser.removeTab(tab1);

        addon.userDisabled = false;
        report.restart1 = await probeBlocking(win, server, 90000);

        // Stopped while filtering: the document half read by uBO's HTML
        // filter, an image and an XHR in flight.
        const tab2 = win.gBrowser.addTab(busyURL(2));
        await sleep(1500);
        stoppedAt = Date.now();
        addon.userDisabled = true;
        report.filtering = { page: await finishedPage(tab2, 20000) };
        await sleep(2000);
        report.filtering.errors = errorsSince(stoppedAt);
        win.gBrowser.removeTab(tab2);

        addon.userDisabled = false;
        report.restart2 = await probeBlocking(win, server, 90000);
    } catch (ex) {
        failure = String(ex);
    } finally {
        server.stop();
    }
    const pass = (ok, value) => ok ? 'PASS' : `FAIL: ${JSON.stringify(value)}`;
    const { booting = {}, filtering = {}, restart1 = {}, restart2 = {} } = report;
    const page1 = booting.page || {}, page2 = filtering.page || {};
    checks.bootingWasBooting = pass(booting.uboWasReady === false, booting.uboWasReady);
    checks.bootingPageFinished = pass(page1.finished === true && page1.whole === true, page1);
    checks.bootingNoRuntimeErrors = pass(booting.errors !== undefined && booting.errors.runtime.length === 0,
        booting.errors && booting.errors.runtime);
    checks.restart1Blocks = pass(restart1.blocked === true, restart1);
    checks.filteringPageFinished = pass(page2.finished === true && page2.whole === true, page2);
    checks.filteringNoRuntimeErrors = pass(filtering.errors !== undefined && filtering.errors.runtime.length === 0,
        filtering.errors && filtering.errors.runtime);
    checks.restart2Blocks = pass(restart2.blocked === true, restart2);
    report.summary = {
        app: `${Services.appinfo.name} ${Services.appinfo.version}`,
        checks,
        booting,
        restart1,
        filtering,
        restart2,
    };
    if ( failure !== null ) {
        report.error = failure;
    }
    return report;
};

/******************************************************************************/

const whenBrowserReady = async function() {
    const deadline = Date.now() + 60000;
    while ( Date.now() < deadline ) {
        let ready = false;
        try {
            const hiddenDoc = appShell.hiddenDOMWindow && appShell.hiddenDOMWindow.document;
            const win = Services.wm.getMostRecentWindow('navigator:browser');
            ready = hiddenDoc && hiddenDoc.readyState === 'complete' &&
                win && win.document.readyState === 'complete';
        } catch {
        }
        if ( ready ) { break; }
        await sleep(250);
    }
    await sleep(1000);
};

const scenarios = {
    probe: runProbes,
    boot: runBoot,
    network: runNetwork,
    cosmetic: runCosmetic,
    ui: runUI,
    filtering: runFiltering,
    uninstall: ( ) => runUninstall(false),
    'uninstall-disabled': ( ) => runUninstall(true),
    update: runUpdate,
    'stop-busy': runStopBusy,
};

// Filters and user settings given to uBO through managed storage.
const SCENARIO_FILTERS = {
    network: NETWORK_FILTERS,
    cosmetic: COSMETIC_FILTERS,
    ui: UI_FILTERS,
    filtering: FILTERING_FILTERS,
    'stop-busy': STOP_FILTERS,
};
const SCENARIO_USER_SETTINGS = {
    filtering: FILTERING_USER_SETTINGS,
};

// Test pages served under a name of their own (network.dns.localDomains).
const SCENARIO_HOSTS = {
    cosmetic: COSMETIC_HOST,
    filtering: FILTERING_HOST,
    'stop-busy': STOP_HOST,
};

const runScenario = async function(name) {
    const started = Date.now();
    // Read now: the uninstall scenario removes uBO's prefs, these included.
    const linger = getPref('lingerSeconds', 0);
    const autoQuit = getPref('autoQuit', false);
    log(`scenario "${name}": waiting for the browser window`);
    await whenBrowserReady();
    log(`scenario "${name}": running`);
    let result;
    try {
        result = await Promise.race([
            scenarios[name](),
            sleep(SCENARIO_TIMEOUT).then(( ) => {
                throw new Error(`timed out after ${SCENARIO_TIMEOUT} ms`);
            }),
        ]);
    } catch (ex) {
        result = { error: String(ex), stack: ex && ex.stack };
    }
    result.elapsedMs = Date.now() - started;
    // Keep the browser open a while longer, e.g. to let uBO write its
    // selfie (53 s after boot) before quitting.
    if ( linger > 0 ) {
        log(`scenario "${name}": lingering ${linger} s`);
        await sleep(linger * 1000);
    }
    writeText(`${name}.json`, JSON.stringify(result, null, 2));
    writeText('done', name);
    log(`scenario "${name}": done`);
    if ( autoQuit ) {
        Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
    }
};

/******************************************************************************/

const start = function(data, reason) {
    addonData = data;
    outDir = Services.dirsvc.get('ProfD', Ci.nsIFile);
    outDir.append('uxp-test');
    if ( outDir.exists() === false ) {
        outDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
    }
    // A scenario that re-enables the add-on (stop-busy) keeps the log of the
    // instance it replaces.
    if ( getPref('keepConsoleLog', false) === false ) {
        writeText('console.log', '');
        record('harness', '--- console messages logged before the add-on started ---');
        for ( const message of Services.console.getMessageArray() || [] ) {
            recordConsoleMessage(message, false);
        }
        record('harness', '--- end of earlier messages ---');
    }
    Services.console.registerListener(consoleListener);
    Services.obs.addObserver(consoleAPIObserver, 'console-api-log-event', false);
    log(`started: ${data.id} ${data.version} (reason ${reason})`);

    const scenario = getPref('scenario', '');
    if ( scenario === '' ) { return; }
    if ( Object.hasOwn(scenarios, scenario) === false ) {
        log(`unknown scenario "${scenario}"`);
        return;
    }
    // Prefs for one-off experiments, from the launcher's environment:
    // UXP_TEST_PREFS='{"name": value, ...}'
    const env = Cc['@mozilla.org/process/environment;1'].getService(Ci.nsIEnvironment);
    if ( env.exists('UXP_TEST_PREFS') ) {
        for ( const [ name, value ] of Object.entries(JSON.parse(env.get('UXP_TEST_PREFS'))) ) {
            if ( typeof value === 'boolean' ) {
                Services.prefs.setBoolPref(name, value);
            } else if ( typeof value === 'number' ) {
                Services.prefs.setIntPref(name, value);
            } else {
                Services.prefs.setCharPref(name, String(value));
            }
            log(`experiment pref: ${name} = ${value}`);
        }
    }
    // Test runs get uBO's own diagnostics (ubolog) through an admin setting,
    // and their filters that way.
    if ( Services.prefs.prefHasUserValue(PREF_MANAGED_STORAGE) === false ) {
        const managed = { advancedSettings: [ [ 'consoleLogLevel', 'info' ] ] };
        if ( SCENARIO_FILTERS[scenario] !== undefined ) {
            managed.toOverwrite = { filters: SCENARIO_FILTERS[scenario] };
        }
        if ( SCENARIO_USER_SETTINGS[scenario] !== undefined ) {
            managed.userSettings = SCENARIO_USER_SETTINGS[scenario];
        }
        Services.prefs.setCharPref(PREF_MANAGED_STORAGE, JSON.stringify(managed));
    }
    if ( scenario === 'network' ) {
        // Let the test page's window.open() through the popup blocker.
        Services.prefs.setBoolPref('dom.disable_open_during_load', false);
    }
    if ( SCENARIO_HOSTS[scenario] !== undefined ) {
        Services.prefs.setCharPref('network.dns.localDomains', SCENARIO_HOSTS[scenario]);
    }
    runScenario(scenario);
};

// The runtime's Extension object, from bootstrap.js.
const attach = function(ext) {
    extension = ext;
};

const stop = function() {
    extension = null;
    destroyHost();
    Services.obs.removeObserver(consoleAPIObserver, 'console-api-log-event');
    Services.console.unregisterListener(consoleListener);
};

return { start, attach, stop };

})();

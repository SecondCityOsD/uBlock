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
// under extensions.ublock-uxp.uxpTest., which tools/uxp-test.mjs writes into a
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
//             'stalls'   ... measure the main thread's stalls on a first
//                        install, a reload of all lists, a selfie save
//             'compile'  ... check that the engine's worker compiles each
//                        list as uBO's own compiler does, byte for byte
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

const prefs = Services.prefs.getBranch('extensions.ublock-uxp.uxpTest.');
const appShell = Cc['@mozilla.org/appshell/appShellService;1']
    .getService(Ci.nsIAppShellService);

const SCENARIO_TIMEOUT = 240000;
const PREF_MANAGED_STORAGE = 'extensions.ublock-uxp.managedStorage';
// Module scripts report their resolved jar:file: URL, not the chrome:// one.
// Our add-on's code, not that of another add-on installed beside it (legacy
// uBO, in the `legacy` scenario).
const OWN_SOURCES = /^(?:chrome:\/\/ublock-uxp\/|moz-extension:\/\/|resource:\/\/ublock-uxp-probe\/|jar:file:.+\/ublock@sinfulosd\.xpi!\/)/;

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

// `name`: a path in outDir, its parts separated by `/`.
const writeText = function(name, text, append = false) {
    const file = outDir.clone();
    for ( const part of name.split('/') ) { file.append(part); }
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
        consoleLines.push({ kind, text, source, time: Date.now() });
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
            `data:application/vnd.mozilla.xul+xml;charset=utf-8,<window id='ublock-uxp-probe'/>`;
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
        const result = await probePage(`chrome://ublock-uxp/content/${page}`);
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
    resProtocol.setSubstitution('ublock-uxp-probe', addonData.resourceURI);
    const viaResource = await probePage('resource://ublock-uxp-probe/background.html');
    viaResource.iframe.remove();
    resProtocol.setSubstitution('ublock-uxp-probe', null);
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
    report.probedIn = pages.bgWindow ? 'chrome://ublock-uxp/content/background.html' : 'hiddenDOMWindow';
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
        // On a relaunch (--keep-profile), uBO's saved engine, not a rebuild.
        engine: lines.some(l => l.text.includes('Loaded filtering engine from selfie'))
            ? 'loaded from its selfie'
            : 'built from the filter lists',
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
    get sendMessage() { return { value: { echo: 42, senderId: addonData.id } }; },
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

// Basilisk's panelview for the popup (api-ui.js); while shown, it is in a
// panelmultiview's anonymous content, which querySelector() does not search.
const POPUP_VIEW_ID = 'PanelUI-webext-ublock-uxp-button-view';

const findPopupBrowser = function(win) {
    const selector = '.ublock-uxp-popup-browser';
    const view = win.document.getElementById(POPUP_VIEW_ID);
    return win.document.querySelector(selector) || view && view.querySelector(selector);
};

// The panel a node is in, or null.
const panelOf = function(node) {
    for ( let n = node; n !== null; n = n.parentNode ) {
        if ( n.localName === 'panel' ) { return n; }
    }
    return null;
};

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
    for ( const node of menu.querySelectorAll('[data-ublock-uxp-menu] menuitem, menuitem[data-ublock-uxp-menu], menu[data-ublock-uxp-menu]') ) {
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
            ( ) => win.document.querySelector('[id="ublock-uxp-button"]'),
            10000, 'the toolbar button'
        );
        const badge = await waitFor(( ) => button.getAttribute('badge'), 10000, 'the badge')
            .catch(( ) => '');
        report.button = {
            id: button.id,
            parent: button.parentNode ? button.parentNode.id : null,
            label: button.getAttribute('label'),
            badge,
            icon: button.style.getPropertyValue('--ublock-uxp-icon'),
        };
        report.badgeFromAPI = (await callBackground(bgWindow, 'browserAction.getBadgeText', { tabId })).value;
        const pageStore = µb.pageStoreFromTabId(tabId);
        report.blockedOnPage = pageStore ? pageStore.counts.blocked.any : null;
        const navbar = win.document.getElementById('nav-bar');
        report.toolbarScreenshot = saveScreenshot(win, win, navbar.getBoundingClientRect(), 'toolbar.png');

        const section = sectionRunner(report);

        await section('popup', async ( ) => {
            button.doCommand();
            const popupBrowser = await waitFor(( ) => findPopupBrowser(win), 5000, 'the popup'
            ).catch(ex => {
                const view = win.document.getElementById(POPUP_VIEW_ID);
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
                ( ) => findPopupBrowser(win) === null,
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
            const key = win.document.querySelector('#ublock-uxp-commands > key');
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
            report.shortcutAfterReset = win.document.getElementById('ublock-uxp-commands') === null
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

// Popup: in each place its button can be (Basilisk: the navigation bar,
// the menu panel, the overflow panel; Pale Moon: the navigation bar), light
// and dark, at its widest (firewall pane shown). The whole page shows (no
// panel clips it), the panel has no frame of its own color around it and
// an arrow of the page's color; the popup goes with its panel. Captures of
// each, to look at.

const runPopup = async function() {
    const report = { cases: {} };
    const server = new TestServer(uiRoutes);
    server.start();
    const isBasilisk = Services.appinfo.name === 'Basilisk';
    let CUI = null;
    if ( isBasilisk ) {
        ({ CustomizableUI: CUI } = Cu.import('resource:///modules/CustomizableUI.jsm', {}));
    }
    const buttonId = 'ublock-uxp-button';
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    const doc = win.document;

    const place = async where => {
        if ( isBasilisk === false ) { return; }
        CUI.addWidgetToArea(buttonId, where === 'menu-panel' ? CUI.AREA_PANEL : CUI.AREA_NAVBAR);
        if ( where === 'overflow' ) {
            win.restore();
            await sleep(500);
            win.resizeTo(420, 700);
            await waitFor(( ) => doc.getElementById(buttonId).getAttribute('overflowedItem') === 'true',
                5000, 'the button to overflow');
        } else if ( win.windowState !== win.STATE_MAXIMIZED ) {
            win.maximize();
            await sleep(800);
        }
    };
    const open = async ( ) => {
        if ( isBasilisk === false ) {
            doc.getElementById(buttonId).doCommand();
            return;
        }
        const group = CUI.getWidget(buttonId);
        const node = group.forWindow(win).node;
        if ( group.areaType === CUI.TYPE_MENU_PANEL ) {
            await win.PanelUI.show();
        } else if ( node.getAttribute('overflowedItem') === 'true' ) {
            await doc.getElementById('nav-bar').overflowable.show();
        }
        node.dispatchEvent(new win.CustomEvent('command', { bubbles: true, cancelable: true }));
    };
    const closeAll = ( ) => {
        for ( const panel of doc.querySelectorAll('panel') ) {
            if ( panel.state === 'open' ) { panel.hidePopup(); }
        }
        const browser = findPopupBrowser(win);
        const panel = browser && panelOf(browser);
        if ( panel && typeof panel.hidePopup === 'function' ) { panel.hidePopup(); }
    };
    const measure = async name => {
        const browser = await waitFor(( ) => findPopupBrowser(win), 8000, 'the popup');
        const popupDoc = await waitFor(( ) => {
            const d = browser.contentDocument;
            if ( !d || d.readyState !== 'complete' || !d.body ) { return null; }
            if ( d.body.classList.contains('loading') ) { return null; }
            const hostname = d.getElementById('hostname');
            return hostname && hostname.textContent.trim() !== '' ? d : null;
        }, 30000, 'the popup page');
        await sleep(1500);
        const panel = panelOf(browser);
        const anon = cls => panel && doc.getAnonymousElementByAttribute(panel, 'class', cls);
        const content = anon('panel-arrowcontent');
        const arrow = anon('panel-arrow');
        const cw = popupDoc.defaultView;
        const shown = browser.getBoundingClientRect();
        const contentStyle = content ? win.getComputedStyle(content) : null;
        const out = {
            panel: panel ? panel.id || panel.className : 'none',
            // No width asked: fitted to its view (the menu panel).
            asked: browser.style.width !== '' ? parseFloat(browser.style.width) : 'fitted',
            view: Math.round(browser.parentNode.getBoundingClientRect().width),
            shown: Math.round(shown.width),
            viewport: `${cw.innerWidth}x${cw.innerHeight}`,
            layout: popupDoc.documentElement.className,
            pageBackground: cw.getComputedStyle(popupDoc.body).backgroundColor,
            frameBackground: contentStyle ? contentStyle.backgroundColor : null,
            framePadding: contentStyle
                ? [ 'top', 'right', 'bottom', 'left' ].map(side => contentStyle.getPropertyValue(`padding-${side}`)).join(' ')
                : null,
            arrow: arrow ? win.getComputedStyle(arrow).listStyleImage.slice(0, 32) : null,
        };
        out.capture = await captureScreen(`popup-${name.replace(/ /g, '-')}.png`);
        closeAll();
        out.closed = await waitFor(( ) => findPopupBrowser(win) === null, 5000, 'the popup to go')
            .catch(( ) => false);
        await sleep(500);
        return out;
    };

    try {
        const { bgWindow } = await whenUBOReady();
        win.maximize();
        await sleep(1000);
        await openTab(`http://127.0.0.1:${server.port}/ui.html`);
        await callUBO(bgWindow, 'changeUserSettings', 'advancedUserEnabled', true);
        await callUBO(bgWindow, 'changeUserSettings', 'popupPanelSections', 31);
        const places = isBasilisk ? [ 'nav-bar', 'menu-panel', 'overflow' ] : [ 'nav-bar' ];
        for ( const where of places ) {
            for ( const theme of [ 'light', 'dark' ] ) {
                const name = `${where} ${theme}`;
                try {
                    await callUBO(bgWindow, 'changeUserSettings', 'uiTheme', theme);
                    await place(where);
                    await open();
                    report.cases[name] = await measure(name);
                } catch (ex) {
                    report.cases[name] = { error: String(ex) };
                    closeAll();
                    await sleep(500);
                }
            }
        }
        await place('nav-bar');
    } finally {
        server.stop();
    }

    const checks = {};
    for ( const [ name, c ] of Object.entries(report.cases) ) {
        const failures = [];
        if ( c.error ) {
            failures.push(c.error);
        } else {
            // The page is as wide as asked (fitted: as its view), and laid
            // out at that width.
            const wanted = c.asked === 'fitted' ? c.view : c.asked;
            if ( Math.abs(c.shown - wanted) > 1 || Math.abs(parseInt(c.viewport, 10) - c.shown) > 1 ) {
                failures.push(`asked ${c.asked}, view ${c.view}, shown ${c.shown}, viewport ${c.viewport}`);
            }
            if ( name.startsWith('menu-panel') === false ) {
                // At its widest: the firewall pane beside the main one.
                if ( c.asked < 400 ) { failures.push(`narrow (${c.asked})`); }
                if ( c.framePadding !== '0px 0px 0px 0px' ) { failures.push(`padding ${c.framePadding}`); }
                if ( c.frameBackground !== c.pageBackground ) {
                    failures.push(`frame ${c.frameBackground}, page ${c.pageBackground}`);
                }
                if ( /^url\("data:image\/svg\+xml/.test(c.arrow) === false ) { failures.push(`arrow ${c.arrow}`); }
            }
            if ( c.closed !== true ) { failures.push('the popup stayed'); }
        }
        checks[name] = failures.length === 0 ? 'PASS' : `FAIL: ${failures.join('; ')}`;
    }
    report.summary = {
        app: `${Services.appinfo.name} ${Services.appinfo.version}`,
        checks,
        cases: report.cases,
        ownErrors: ownErrors(consoleLines),
    };
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
            report.privacyStored = Object.keys(JSON.parse(readAnyPref('extensions.ublock-uxp.privacySettings') || '{}'));
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
        buttonPlacement = CustomizableUI.getPlacementOfWidget('ublock-uxp-button', false, true);
    } catch {
        const doc = 'chrome://browser/content/browser.xul';
        const store = Cc['@mozilla.org/xul/xulstore;1'].getService(Ci.nsIXULStore);
        const ids = store.getIDsEnumerator(doc);
        while ( ids.hasMore() ) {
            const id = ids.getNext();
            if ( store.getValue(doc, id, 'currentset').includes('ublock-uxp-button') ) {
                buttonPlacement = { toolbar: id };
            }
        }
    }
    return {
        prefs: Services.prefs.getChildList('extensions.ublock-uxp.', {})
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
        (before.prefs || []).includes('extensions.ublock-uxp.uuid') &&
        (before.originStorage || []).length !== 0 &&
        before.storageLocal === true && before.buttonPlacement !== null,
        before);
    // As in Firefox: disabled, the data stays; the privacy prefs are the
    // user's again.
    if ( disableFirst ) {
        const disabled = report.afterDisable || {};
        checks.disableKeepsData = pass(
            (disabled.prefs || []).includes('extensions.ublock-uxp.uuid') &&
            (disabled.originStorage || []).length !== 0 && disabled.storageLocal === true &&
            Array.isArray(disabled.privacyPrefsSet) && disabled.privacyPrefsSet.length === 0,
            disabled);
    }
    checks.addonRemoved = pass(report.addonGone === true, report.addonGone);
    checks.prefs = pass(
        JSON.stringify(after.prefs) === JSON.stringify([ 'extensions.ublock-uxp.managedStorage' ]),
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
// filters (its HTML filter reading the page's document, half arrived), a
// window of another kind (a dialog) open from before that stop to after it.
// The pages must still finish, whole, the runtime must log nothing once
// stopped (nor keep watching the dialog), and uBO must block again once
// re-enabled. The add-on that comes
// back runs no scenario: this harness drives on to the end.

const STOP_HOST = 'uxp-stop.test';
const STOP_FILTERS = [
    `||${STOP_HOST}^*/uxp-blocked/`,
    `${STOP_HOST}##^#uxp-stop-removed`,
];
// Added by the stalls scenario while uBO reloads.
const ADDED_FILTER = `||${STOP_HOST}^*/uxp-added/`;
const RUNTIME_SOURCE = /^chrome:\/\/ublock-uxp\/content\/uxp\/|\/ublock@sinfulosd\.xpi!\/bootstrap\.js$/;
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
    // Its image is blocked by a filter added while uBO reloads (stalls).
    case '/added.html':
        return {
            type: 'text/html; charset=utf-8',
            body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
<img id="okImage" src="/ok/probe.svg"><img id="adImage" src="/uxp-added/probe.svg">
<script>${recorderScript('')}</script></body></html>`,
        };
    case '/ok/image.svg':
    case '/ok/probe.svg':
        return svg('green');
    case '/uxp-blocked/ad.svg':
    case '/uxp-blocked/probe.svg':
    case '/uxp-added/probe.svg':
        return svg('red');
    case '/slow/image.svg':
        return { ...svg('blue'), delayMs: 3000 };
    case '/slow/xhr.txt':
        return { type: 'text/plain', body: 'slow', delayMs: 3000 };
    default:
        return null;
    }
};

// Errors logged since `since` by the runtime, and by uBO's own pages. Read
// from the harness's record, not from the console service: that one drops
// a window's messages once the window is destroyed, so the error of a page
// that went away (a pane uBO blanked, a tab closed) would be missed.
const errorsSince = function(since) {
    const out = { runtime: [], ubo: [] };
    for ( const line of consoleLines ) {
        if ( line.time < since ) { continue; }
        if ( line.kind !== 'error' && line.kind !== 'console.error' ) { continue; }
        const file = line.source.replace(/(?::\d+)+$/, '');
        const text = `+${line.time - since} ms ${line.text} @ ${line.source}`;
        if ( RUNTIME_SOURCE.test(file) ) {
            out.runtime.push(text);
        } else if ( UBO_SOURCE.test(file) ) {
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
        const dialog = Services.ww.openWindow(null, 'chrome://global/content/config.xul',
            '_blank', 'chrome,dialog=no,resizable', null);
        await sleep(1000);

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
        dialog.close();

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

// Pages: uBO's pages when the runtime stops. A runtime.reload() keeps them,
// reloaded and working with the new runtime. A disable closes them, as
// Firefox does: a window left with none of its tabs keeps a new one, the
// logger's popup window goes, a page uBO strict-blocked loads in the tab of
// its document-blocked.html. Nothing logged by the runtime or by uBO's
// pages. The add-on that comes back runs no scenario.

const runPages = async function() {
    const report = {};
    const server = new TestServer(path => path === '/target.html'
        ? { type: 'text/html; charset=utf-8', body: '<!doctype html><title>target</title><p>target</p>' }
        : { status: 404, type: 'text/plain', body: '' });
    server.start();
    const BROWSER_URL = 'chrome://browser/content/browser.xul';
    const openBrowserWindow = (url, features) => {
        const arg = Cc['@mozilla.org/supports-string;1'].createInstance(Ci.nsISupportsString);
        arg.data = url;
        return Services.ww.openWindow(null, BROWSER_URL, '_blank', features, arg);
    };
    try {
        const { AddonManager } = Cu.import('resource://gre/modules/AddonManager.jsm', {});
        const addon = await new Promise(resolve => { AddonManager.getAddonByID(addonData.id, resolve); });
        prefs.setCharPref('scenario', '');
        prefs.setBoolPref('keepConsoleLog', true);
        const { ext, bgWindow } = await whenUBOReady();
        const base = ext.getURL('');
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        const pageIn = (browser, path) => waitFor(( ) => {
            const d = browser.contentDocument;
            return d && d.readyState === 'complete' && d.documentURI.startsWith(`${base}${path}`) ? d : null;
        }, 30000, path);
        const dashboardReady = (browser, oldDoc = null) => waitFor(( ) => {
            const d = browser.contentDocument;
            return d && d !== oldDoc && d.documentURI.startsWith(`${base}dashboard.html`) && d.body &&
                d.readyState === 'complete' && d.body.classList.contains('notReady') === false ? d : null;
        }, 60000, 'the dashboard ready');

        // runtime.reload() as a dashboard pane has just started loading:
        // the dashboard stays, is reloaded, and works; the pane cut short
        // logs nothing.
        const dashTab = win.gBrowser.addTab(`${base}dashboard.html`);
        const oldDoc = await dashboardReady(dashTab.linkedBrowser);
        await sleep(1000);
        const paneURL = `${base}1p-filters.html`;
        const paneCreated = new Promise(resolve => {
            const observer = {
                observe(doc) {
                    if ( doc.documentURI !== paneURL ) { return; }
                    Services.obs.removeObserver(observer, 'document-element-inserted');
                    resolve(doc);
                },
            };
            Services.obs.addObserver(observer, 'document-element-inserted', false);
        });
        oldDoc.defaultView.location.hash = '#1p-filters.html';
        const paneDoc = await paneCreated;
        let paneAtStop = '';
        ext.onShutdown(( ) => { paneAtStop = paneDoc.readyState; });
        const reloadAt = Date.now();
        callBackground(bgWindow, 'runtime.reload');
        await waitFor(( ) => extension !== null && extension !== ext, 30000, 'the new runtime');
        await whenUBOReady();
        const newDoc = await dashboardReady(dashTab.linkedBrowser, oldDoc).catch(( ) => null);
        await sleep(2000);
        const newPane = newDoc && newDoc.getElementById('iframe').contentDocument;
        report.reload = {
            paneAtStop,
            tabOpen: dashTab.parentNode !== null,
            reloaded: newDoc !== null,
            pane: newPane ? `${newPane.documentURI.replace(base, '')} ${newPane.readyState}` : null,
            errors: errorsSince(reloadAt),
        };

        // A disable: the dashboard tab in the main window, a window with
        // only the dashboard, the logger in a popup window, a page uBO
        // blocked.
        const targetURL = `http://127.0.0.1:${server.port}/target.html`;
        const blockedURL = `${base}document-blocked.html?details=${encodeURIComponent(JSON.stringify({
            url: targetURL, hn: '127.0.0.1', dn: '127.0.0.1', fs: '||127.0.0.1^',
        }))}`;
        const blockedTab = win.gBrowser.addTab(blockedURL);
        await pageIn(blockedTab.linkedBrowser, 'document-blocked.html');
        const soloWin = openBrowserWindow(`${base}dashboard.html`, 'chrome,dialog=no,all');
        const popupWin = openBrowserWindow(`${base}logger-ui.html`,
            'chrome,dialog=no,resizable,minimizable,scrollbars');
        await waitFor(( ) => soloWin.gBrowser && popupWin.gBrowser, 10000, 'the windows');
        await pageIn(soloWin.gBrowser.selectedBrowser, 'dashboard.html');
        await pageIn(popupWin.gBrowser.selectedBrowser, 'logger-ui.html');
        await sleep(1000);
        const disableAt = Date.now();
        addon.userDisabled = true;
        await waitFor(( ) => blockedTab.linkedBrowser.currentURI.spec === targetURL, 10000, 'the blocked page')
            .catch(( ) => {});
        await sleep(2000);
        const ownURLs = w => w.closed || !w.gBrowser ? [] : Array.from(w.gBrowser.tabs,
            t => t.linkedBrowser.currentURI.spec).filter(u => u.startsWith(base));
        report.disable = {
            mainWindowOwnTabs: ownURLs(win),
            mainWindowTabs: win.gBrowser.tabs.length,
            dashTabGone: dashTab.parentNode === null,
            blockedTab: blockedTab.parentNode === null ? 'closed' : blockedTab.linkedBrowser.currentURI.spec,
            soloWindow: soloWin.closed ? 'closed' : Array.from(soloWin.gBrowser.tabs,
                t => t.linkedBrowser.currentURI.spec),
            popupWasPopup: popupWin.closed ? null : popupWin.toolbar.visible === false,
            popupWindowClosed: popupWin.closed,
            errors: errorsSince(disableAt),
        };
        if ( soloWin.closed === false ) { soloWin.close(); }
        if ( popupWin.closed === false ) { popupWin.close(); }
        addon.userDisabled = false;
        await sleep(3000);
    } catch (ex) {
        report.error = String(ex);
    } finally {
        server.stop();
    }
    const pass = (ok, value) => ok ? 'PASS' : `FAIL: ${JSON.stringify(value)}`;
    const { reload = {}, disable = {} } = report;
    const noErrors = e => e !== undefined && e.runtime.length === 0 && e.ubo.length === 0;
    const tabsClosed = disable.dashTabGone === true &&
        Array.isArray(disable.mainWindowOwnTabs) && disable.mainWindowOwnTabs.length === 0;
    const windowKept = Array.isArray(disable.soloWindow) && disable.soloWindow.length === 1 &&
        disable.soloWindow[0].startsWith('moz-extension:') === false;
    const checks = {
        reloadCutsPaneShort: pass(reload.paneAtStop === 'loading' || reload.paneAtStop === 'interactive',
            reload.paneAtStop),
        reloadKeepsTab: pass(reload.tabOpen === true, reload.tabOpen),
        reloadReloads: pass(reload.reloaded === true && reload.pane === '1p-filters.html complete', reload),
        reloadNoErrors: pass(noErrors(reload.errors), reload.errors),
        disableClosesTabs: pass(tabsClosed, [ disable.dashTabGone, disable.mainWindowOwnTabs ]),
        disableKeepsWindow: pass(windowKept, disable.soloWindow),
        disableClosesPopup: pass(disable.popupWindowClosed === true, disable.popupWindowClosed),
        disableLoadsBlocked: pass(typeof disable.blockedTab === 'string' && disable.blockedTab.endsWith('/target.html'),
            disable.blockedTab),
        disableNoErrors: pass(noErrors(disable.errors), disable.errors),
    };
    report.summary = {
        app: `${Services.appinfo.name} ${Services.appinfo.version}`,
        checks,
        reload,
        disable,
        error: report.error,
    };
    return report;
};

/******************************************************************************/

const PORT_REPOSITORY = 'https://github.com/SecondCityOsD/uBlock';

// uBO's dashboard controls which took their event from `window.event`, a
// global UXP lacks: the Filter lists pane's two settings (the change threw,
// the setting never saved), and the dashboard holding back a page with
// unsaved My filters edits (its beforeunload handler threw: the page went
// without asking). The page is asked as the browser asks before closing a
// tab (nsIContentViewer.permitUnload()), its prompt answered by the test.
// Then the port's About and Support panes: the add-on's own version, links
// to the port's repository, the note on where to report what.
const runDashboard = async function() {
    const report = {};
    const startedAt = Date.now();
    let tab = null;
    try {
        // A page may ask only after the user used it, where the browser has
        // that rule; the test's edits are no user's.
        Services.prefs.setBoolPref('dom.require_user_interaction_for_beforeunload', false);
        const { ext, µb } = await whenUBOReady();
        const base = ext.getURL('');
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        tab = win.gBrowser.addTab(`${base}dashboard.html#3p-filters.html`);
        win.gBrowser.selectedTab = tab;
        const browser = tab.linkedBrowser;
        const paneOf = path => waitFor(( ) => {
            const frame = browser.contentDocument.getElementById('iframe');
            const pane = frame && frame.contentDocument;
            return pane && pane.documentURI === `${base}${path}` && pane.readyState === 'complete' ? pane : null;
        }, 30000, path);
        const top = await dashboardReady(browser);
        let pane = await paneOf('3p-filters.html');
        await sleep(1000);
        report.settings = {};
        for ( const id of [ 'autoUpdate', 'suspendUntilListsAreLoaded' ] ) {
            const before = µb.userSettings[id] === true;
            const settled = value => waitFor(( ) => µb.userSettings[id] === value, 5000, id)
                .then(( ) => true, ( ) => false);
            const input = pane.getElementById(id);
            input.click();
            const changed = await settled(!before);
            input.click();
            const restored = await settled(before);
            report.settings[id] = { before, changed, restored };
        }

        top.defaultView.location.hash = '#1p-filters.html';
        pane = await paneOf('1p-filters.html');
        const editor = await waitFor(( ) => {
            const node = pane.querySelector('.CodeMirror');
            return node && Cu.waiveXrays(node).CodeMirror;
        }, 10000, 'the My filters editor');
        await sleep(500);
        const viewer = browser.docShell.contentViewer;
        const paneWindow = Cu.waiveXrays(pane.defaultView);
        // The browser's "leave page?" prompt runs a nested event loop, where
        // a timer finds it and answers "Stay on page" (button 1).
        const ask = ( ) => {
            const state = {
                paneSaysUnsaved: paneWindow.hasUnsavedData() === true,
                prompted: '',
            };
            const deadline = Date.now() + 10000;
            let timer;
            const answer = ( ) => {
                for ( const prompt of win.gBrowser.getTabModalPromptBox(browser).listPrompts() ) {
                    state.prompted = 'tab-modal';
                    prompt.onButtonClick(1);
                    return;
                }
                const windows = Services.wm.getEnumerator(null);
                while ( windows.hasMoreElements() ) {
                    const dialog = windows.getNext();
                    if ( dialog.location.href !== 'chrome://global/content/commonDialog.xul' ) { continue; }
                    state.prompted = 'window-modal';
                    dialog.document.documentElement.cancelDialog();
                    return;
                }
                if ( Date.now() < deadline ) { timer = setTimeout(answer, 100); }
            };
            timer = setTimeout(answer, 100);
            try {
                state.leaveAllowed = viewer.permitUnload();
            } finally {
                clearTimeout(timer);
            }
            return state;
        };
        const saved = editor.getValue();
        editor.setValue(`${saved}\n||uxp-unsaved.test^`);
        await sleep(300);
        report.unsaved = ask();
        editor.setValue(saved);
        await sleep(300);
        report.saved = ask();

        // The port's own About and Support: its version, its links, where
        // to report what.
        const pageReady = (path, ready) => {
            const pageTab = win.gBrowser.addTab(`${base}${path}`);
            return waitFor(( ) => {
                const doc = pageTab.linkedBrowser.contentDocument;
                return doc && doc.readyState === 'complete' && ready(doc) ? { doc, pageTab } : null;
            }, 30000, path);
        };
        const about = await pageReady('about.html',
            doc => doc.getElementById('aboutNameVer').textContent !== '');
        report.about = {
            nameVer: about.doc.getElementById('aboutNameVer').textContent,
            links: Array.from(about.doc.querySelectorAll(
                '[data-i18n="aboutPrivacyPolicy"], [data-i18n="aboutChangelog"], [data-i18n="aboutCode"]'
            ), a => a.href),
        };
        win.gBrowser.removeTab(about.pageTab);
        const support = await pageReady('support.html',
            doc => doc.getElementById('uxpBugReport').getAttribute('data-url').includes('body='));
        const reportURL = new support.doc.defaultView.URL(
            support.doc.getElementById('uxpBugReport').getAttribute('data-url')
        );
        report.support = {
            noteShown: support.doc.querySelector('.uxp').getBoundingClientRect().height > 0 &&
                support.doc.querySelector('[data-i18n="uxpSupportP2"]').textContent.includes('Firefox'),
            reportTo: `${reportURL.origin}${reportURL.pathname}`,
            reportHasVersion: reportURL.searchParams.get('body').includes(`uBlock Origin: ${addonData.version}`),
        };
        win.gBrowser.removeTab(support.pageTab);
    } catch (ex) {
        report.error = String(ex);
    }
    if ( tab !== null && tab.parentNode !== null ) {
        tab.ownerGlobal.gBrowser.removeTab(tab);
    }
    report.errors = errorsSince(startedAt);
    const pass = (ok, value) => ok ? 'PASS' : `FAIL: ${JSON.stringify(value)}`;
    const { settings = {}, unsaved = {}, saved = {}, about = {}, support = {}, errors } = report;
    const saves = id => settings[id] !== undefined &&
        settings[id].changed === true && settings[id].restored === true;
    const checks = {
        autoUpdateSaves: pass(saves('autoUpdate'), settings.autoUpdate),
        suspendSaves: pass(saves('suspendUntilListsAreLoaded'), settings.suspendUntilListsAreLoaded),
        unsavedAsks: pass(unsaved.paneSaysUnsaved === true && unsaved.prompted !== '' &&
            unsaved.leaveAllowed === false, unsaved),
        savedLeaves: pass(saved.paneSaysUnsaved === false && saved.prompted === '' &&
            saved.leaveAllowed === true, saved),
        aboutVersion: pass(about.nameVer === `uBlock Origin ${addonData.version}`, about.nameVer),
        aboutLinks: pass(Array.isArray(about.links) && about.links.length === 3 &&
            about.links.every(href => href === PORT_REPOSITORY || href.startsWith(`${PORT_REPOSITORY}/`)),
            about.links),
        supportNote: pass(support.noteShown === true, support.noteShown),
        supportReport: pass(support.reportTo === `${PORT_REPOSITORY}/issues/new` &&
            support.reportHasVersion === true, support),
        noErrors: pass(errors.runtime.length === 0 && errors.ubo.length === 0, errors),
    };
    report.summary = {
        app: `${Services.appinfo.name} ${Services.appinfo.version}`,
        checks,
        settings,
        unsaved,
        saved,
        about,
        support,
        error: report.error,
    };
    return report;
};

/******************************************************************************/

// Other ad blockers beside the port: legacy uBO 1.16.6.1, installed by
// tools/uxp-test.mjs as when someone switches, and a stand-in the test
// installs, a temporary add-on named "Test Ad Blocker" (found by its name).
// Each runs beside the port, with its own button; the port's notice names
// the other blocker, its buttons disable it, or keep it (not asked about
// again); several blockers are named in one notice, disabled together.
// Legacy uBO's uninstall, which deletes its whole pref branch, leaves the
// port's prefs (its UUID: its data) as they were, and the port still blocks.
const LEGACY_ID = 'uBlock0@raymondhill.net';
const STAND_IN_ID = 'test-ad-blocker@uxp-test';
const OTHER_BLOCKERS_NOTICE = 'ublock-uxp-other-blockers';

// A restartless add-on with nothing in it but its name.
const installStandInBlocker = function(AddonManager) {
    const targets = [
        '{8de7fcbb-c55c-4fbe-bfc5-fc555c87dbc4}',   // Pale Moon
        '{ec8030f7-c20a-464f-9b0e-13a3a9e97384}',   // Basilisk
    ].map(id => '<em:targetApplication><Description>' +
        `<em:id>${id}</em:id><em:minVersion>1.0</em:minVersion><em:maxVersion>*</em:maxVersion>` +
        '</Description></em:targetApplication>'
    ).join('');
    const dir = outDir.clone();
    dir.append('test-ad-blocker');
    if ( dir.exists() ) { dir.remove(true); }
    dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
    writeText('test-ad-blocker/install.rdf', '<?xml version="1.0"?>' +
        '<RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:em="http://www.mozilla.org/2004/em-rdf#">' +
        '<Description about="urn:mozilla:install-manifest">' +
        `<em:id>${STAND_IN_ID}</em:id><em:version>1.0</em:version><em:type>2</em:type>` +
        `<em:name>Test Ad Blocker</em:name><em:bootstrap>true</em:bootstrap>${targets}` +
        '</Description></RDF>');
    writeText('test-ad-blocker/bootstrap.js',
        'function install() {}\nfunction uninstall() {}\nfunction startup() {}\nfunction shutdown() {}\n');
    // UXP has no temporary installs: zipped, installed as any XPI is.
    const xpi = outDir.clone();
    xpi.append('test-ad-blocker.xpi');
    const zip = Cc['@mozilla.org/zipwriter;1'].createInstance(Ci.nsIZipWriter);
    zip.open(xpi, 0x04 | 0x08 | 0x20);   // PR_RDWR | PR_CREATE_FILE | PR_TRUNCATE
    for ( const name of [ 'install.rdf', 'bootstrap.js' ] ) {
        const file = dir.clone();
        file.append(name);
        zip.addEntryFile(name, Ci.nsIZipWriter.COMPRESSION_DEFAULT, file, false);
    }
    zip.close();
    return new Promise((resolve, reject) => {
        AddonManager.getInstallForFile(xpi, install => {
            install.addListener({
                onInstallEnded: ( ) => { resolve(); },
                onInstallFailed: ( ) => { reject(new Error(`stand-in install failed: ${install.error}`)); },
            });
            install.install();
        });
    });
};

const runLegacy = async function() {
    const report = {};
    const startedAt = Date.now();
    const server = new TestServer(stopRoutes);
    server.start();
    try {
        const { AddonManager } = Cu.import('resource://gre/modules/AddonManager.jsm', {});
        const addonOf = id => new Promise(resolve => { AddonManager.getAddonByID(id, resolve); });
        const until = async (test, timeout) => {
            const deadline = Date.now() + timeout;
            for (;;) {
                if ( await test() ) { return true; }
                if ( Date.now() > deadline ) { return false; }
                await sleep(250);
            }
        };
        const isActive = async (id, want) => {
            const addon = await addonOf(id);
            return addon !== null && addon.isActive === want;
        };
        const setEnabled = async (id, enabled) => {
            (await addonOf(id)).userDisabled = enabled === false;
            await until(( ) => isActive(id, enabled), 10000);
        };
        await whenUBOReady();
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        const doc = win.document;
        const box = doc.getElementById('global-notificationbox') || win.gBrowser.getNotificationBox();
        const notice = ( ) => box.getNotificationWithValue(OTHER_BLOCKERS_NOTICE);
        const buttonsOf = shown => Array.from(shown.querySelectorAll('button'),
            b => b.label || b.getAttribute('label')).filter(Boolean);
        const clickNotice = label => {
            Array.from(notice().querySelectorAll('button'))
                .find(b => (b.label || b.getAttribute('label')) === label)
                .click();
        };
        const ourPrefs = ( ) => Services.prefs.getChildList('extensions.ublock-uxp.', {}).sort();
        const addonState = addon => addon === null
            ? 'removed'
            : `${addon.version} ${addon.isActive ? 'active' : 'inactive'}`;
        const state = async ( ) => {
            const shown = notice();
            return {
                legacy: addonState(await addonOf(LEGACY_ID)),
                standIn: addonState(await addonOf(STAND_IN_ID)),
                notice: shown === null ? null : shown.label,
                buttons: shown === null ? [] : buttonsOf(shown),
                ourButton: doc.getElementById('ublock-uxp-button') !== null,
                legacyButton: doc.querySelector('[id="uBlock0-legacy-button"], [id="ublock0-button"]') !== null,
            };
        };

        // Legacy uBO beside the port, at launch.
        await until(( ) => notice() !== null, 30000);
        report.together = await state();
        report.together.legacyPrefs = Services.prefs.getChildList('extensions.ublock0.', {}).length;
        report.noticeScreenshot = notice() === null ? null : saveScreenshot(win, win, {
            left: 0, top: win.innerHeight - 160, width: Math.min(win.innerWidth, 1400), height: 160,
        }, 'other-blockers-notice.png');

        // Its "Disable" button.
        clickNotice('Disable uBlock Origin 1.16.6.1');
        await until(( ) => isActive(LEGACY_ID, false), 10000);
        await sleep(500);
        report.disabled = await state();

        // Enabled again: asked again.
        await setEnabled(LEGACY_ID, true);
        await until(( ) => notice() !== null, 10000);
        report.reenabled = await state();

        // "Keep both enabled": not asked about again.
        clickNotice('Keep both enabled');
        await until(( ) => notice() === null, 5000);
        await setEnabled(LEGACY_ID, false);
        await setEnabled(LEGACY_ID, true);
        await sleep(2000);
        report.kept = await state();
        report.kept.pref = readAnyPref('extensions.ublock-uxp.otherBlockersKept');

        // Another ad blocker, found by its name: named alone, legacy uBO kept.
        await installStandInBlocker(AddonManager);
        await until(( ) => notice() !== null, 10000);
        report.standIn = await state();

        // Nothing kept any more: both named in one notice, disabled together.
        Services.prefs.clearUserPref('extensions.ublock-uxp.otherBlockersKept');
        await setEnabled(STAND_IN_ID, false);
        await setEnabled(STAND_IN_ID, true);
        await until(( ) => notice() !== null && notice().label.includes('Test Ad Blocker') &&
            notice().label.includes('1.16.6.1'), 10000);
        report.several = await state();
        clickNotice('Disable them');
        await until(async ( ) => await isActive(LEGACY_ID, false) && await isActive(STAND_IN_ID, false), 10000);
        await sleep(500);
        report.severalDisabled = await state();

        // Legacy uBO uninstalled: its cleanup deletes extensions.ublock0.*.
        (await addonOf(STAND_IN_ID)).uninstall();
        const prefsBefore = ourPrefs();
        const uuidBefore = readAnyPref('extensions.ublock-uxp.uuid');
        (await addonOf(LEGACY_ID)).uninstall();
        await until(async ( ) => await addonOf(LEGACY_ID) === null, 10000);
        await sleep(1000);
        report.uninstalled = await state();
        Object.assign(report.uninstalled, {
            legacyPrefsLeft: Services.prefs.getChildList('extensions.ublock0.', {}),
            ourPrefsKept: JSON.stringify(ourPrefs()) === JSON.stringify(prefsBefore),
            uuidKept: uuidBefore !== '' && readAnyPref('extensions.ublock-uxp.uuid') === uuidBefore,
            blocking: await probeBlocking(win, server, 60000),
        });
    } catch (ex) {
        report.error = `${ex}\n${ex && ex.stack}`;
    }
    server.stop();
    const errors = errorsSince(startedAt);
    const pass = (ok, value) => ok ? 'PASS' : `FAIL: ${JSON.stringify(value)}`;
    const {
        together = {}, disabled = {}, reenabled = {}, kept = {},
        standIn = {}, several = {}, severalDisabled = {}, uninstalled = {},
    } = report;
    const legacy = '1.16.6.1';
    const named = (s, ...names) => typeof s.notice === 'string' && names.every(n => s.notice.includes(n));
    const checks = {
        bothRun: pass(together.legacy === `${legacy} active` && together.legacyPrefs > 0 &&
            together.ourButton === true && together.legacyButton === true, together),
        noticeNamesIt: pass(named(together, `uBlock Origin ${legacy}`, 'uBlock Origin for Pale Moon and Basilisk') &&
            JSON.stringify(together.buttons) === JSON.stringify([ `Disable uBlock Origin ${legacy}`, 'Keep both enabled' ]),
        together),
        disableDisables: pass(disabled.legacy === `${legacy} inactive` && disabled.notice === null &&
            disabled.legacyButton === false && disabled.ourButton === true, disabled),
        askedAgainWhenEnabled: pass(reenabled.legacy === `${legacy} active` && reenabled.notice !== null,
            reenabled),
        keepRemembered: pass(typeof kept.pref === 'string' && kept.pref.includes(LEGACY_ID) &&
            kept.notice === null && kept.legacy === `${legacy} active`, kept),
        anyBlockerByName: pass(standIn.standIn === '1.0 active' && named(standIn, 'Test Ad Blocker 1.0') &&
            standIn.notice.includes(legacy) === false, standIn),
        severalInOne: pass(named(several, 'Test Ad Blocker 1.0', `uBlock Origin ${legacy}`) &&
            JSON.stringify(several.buttons) === JSON.stringify([ 'Disable them', 'Keep all enabled' ]), several),
        severalDisabled: pass(severalDisabled.legacy === `${legacy} inactive` &&
            severalDisabled.standIn === '1.0 inactive' && severalDisabled.notice === null, severalDisabled),
        legacyCleanupRan: pass(uninstalled.legacy === 'removed' &&
            Array.isArray(uninstalled.legacyPrefsLeft) && uninstalled.legacyPrefsLeft.length === 0,
        uninstalled.legacyPrefsLeft),
        oursKept: pass(uninstalled.ourPrefsKept === true && uninstalled.uuidKept === true &&
            uninstalled.ourButton === true, uninstalled),
        stillBlocks: pass(uninstalled.blocking !== undefined && uninstalled.blocking.blocked === true,
            uninstalled.blocking),
        noErrors: pass(errors.runtime.length === 0 && errors.ubo.length === 0, errors),
    };
    report.summary = {
        app: `${Services.appinfo.name} ${Services.appinfo.version}`,
        checks,
        together,
        disabled,
        reenabled,
        kept,
        standIn,
        several,
        severalDisabled,
        uninstalled,
        noticeScreenshot: report.noticeScreenshot,
        error: report.error,
    };
    return report;
};

/******************************************************************************/

// Upgrade: the add-on installed again over itself while it runs, as an
// update installs (ADDON_UPGRADE), with a dashboard tab open and the popup
// used before. The instance that comes back runs the second stage: uBO
// ready and blocking, the dashboard tab reloaded and working, one button,
// at most one keyset (none without shortcuts), Basilisk's one panelview, no
// popup left (nothing left by the runtime that stopped), nothing logged by the runtime or uBO since the upgrade.

const UPGRADE_MARK = 'uxpBeforeUpgrade';

const openPopupOf = function(win) {
    if ( Services.appinfo.name !== 'Basilisk' ) {
        win.document.getElementById('ublock-uxp-button').doCommand();
        return;
    }
    const { CustomizableUI } = Cu.import('resource:///modules/CustomizableUI.jsm', {});
    CustomizableUI.getWidget('ublock-uxp-button').forWindow(win).node.dispatchEvent(
        new win.CustomEvent('command', { bubbles: true, cancelable: true })
    );
};

const popupLoaded = win => waitFor(( ) => {
    const browser = findPopupBrowser(win);
    const doc = browser && browser.contentDocument;
    const hostname = doc && doc.getElementById('hostname');
    return hostname && hostname.textContent.trim() !== '' ? browser : null;
}, 30000, 'the popup');

const dashboardIn = function(win, base) {
    return Array.from(win.gBrowser.tabs).find(tab =>
        tab.linkedBrowser.currentURI.spec.startsWith(`${base}dashboard.html`)
    ) || null;
};

const dashboardReady = browser => waitFor(( ) => {
    const doc = browser.contentDocument;
    return doc && doc.readyState === 'complete' && doc.body &&
        doc.body.classList.contains('notReady') === false ? doc : null;
}, 60000, 'the dashboard ready');

const upgradeStage1 = async function() {
    const { ext } = await whenUBOReady();
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    const tab = win.gBrowser.addTab(ext.getURL('dashboard.html'));
    const doc = await dashboardReady(tab.linkedBrowser);
    doc.documentElement.dataset[UPGRADE_MARK] = 'true';
    openPopupOf(win);
    const browser = await popupLoaded(win);
    const panel = panelOf(browser);
    if ( panel !== null ) { panel.hidePopup(); }
    await sleep(1000);
    prefs.setIntPref('upgradeStage', 2);
    prefs.setCharPref('upgradeAt', String(Date.now()));
    prefs.setBoolPref('keepConsoleLog', true);
    // A copy of the installed package, installed over it.
    const copy = outDir.clone();
    copy.append('upgrade.xpi');
    if ( copy.exists() ) { copy.remove(false); }
    addonData.installPath.copyTo(outDir, 'upgrade.xpi');
    const { AddonManager } = Cu.import('resource://gre/modules/AddonManager.jsm', {});
    AddonManager.getInstallForFile(copy, install => { install.install(); });
    // This instance stops; the next one runs the second stage.
    return new Promise(( ) => {});
};

const upgradeStage2 = async function() {
    const report = {};
    const upgradeAt = parseInt(getPref('upgradeAt', '0'), 10);
    const server = new TestServer(stopRoutes);
    server.start();
    try {
        const { ext, µb } = await whenUBOReady();
        report.readyAfter = µb.supportStats.allReadyAfter;
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        const doc = win.document;
        const tab = dashboardIn(win, ext.getURL(''));
        if ( tab === null ) {
            report.dashboard = { open: false };
        } else {
            const dashboard = await dashboardReady(tab.linkedBrowser).catch(( ) => null);
            report.dashboard = {
                open: true,
                reloaded: dashboard !== null &&
                    dashboard.documentElement.dataset[UPGRADE_MARK] === undefined,
                ready: dashboard !== null,
            };
        }
        openPopupOf(win);
        report.popup = await popupLoaded(win).then(( ) => 'loaded', ex => String(ex));
        const browser = findPopupBrowser(win);
        const panel = browser && panelOf(browser);
        if ( panel && typeof panel.hidePopup === 'function' ) {
            // A panel still opening ignores hidePopup() (seen on a busy
            // machine): closed once open.
            await waitFor(( ) => panel.state === 'open', 5000, 'the panel open').catch(( ) => {});
            panel.hidePopup();
        }
        // Counted with the popup closed: shown, Basilisk's panelview is in
        // a panel's anonymous content, which querySelectorAll() misses.
        await waitFor(( ) => (!panel || panel.state === 'closed') && findPopupBrowser(win) === null,
            5000, 'the popup closed').catch(( ) => {});
        await sleep(500);
        report.parts = {
            buttons: doc.querySelectorAll('[id="ublock-uxp-button"]').length,
            keysets: doc.querySelectorAll('[id="ublock-uxp-commands"]').length,
            views: doc.querySelectorAll(`[id="${POPUP_VIEW_ID}"]`).length,
            popupBrowsers: doc.querySelectorAll('.ublock-uxp-popup-browser').length +
                (doc.getElementById(POPUP_VIEW_ID)
                    ? doc.getElementById(POPUP_VIEW_ID).querySelectorAll('.ublock-uxp-popup-browser').length
                    : 0),
        };
        report.blocking = await probeBlocking(win, server, 60000);
        report.errors = errorsSince(upgradeAt);
    } catch (ex) {
        report.error = String(ex);
    } finally {
        server.stop();
    }
    const pass = (ok, value) => ok ? 'PASS' : `FAIL: ${JSON.stringify(value)}`;
    const { dashboard = {}, parts = {}, blocking = {}, errors } = report;
    const isBasilisk = Services.appinfo.name === 'Basilisk';
    report.summary = {
        app: `${Services.appinfo.name} ${Services.appinfo.version}`,
        checks: {
            ready: pass(typeof report.readyAfter === 'string', report.readyAfter),
            dashboardReloaded: pass(dashboard.open === true && dashboard.reloaded === true &&
                dashboard.ready === true, dashboard),
            popup: pass(report.popup === 'loaded', report.popup),
            oneOfEach: pass(parts.buttons === 1 && parts.keysets <= 1 &&
                parts.views === (isBasilisk ? 1 : 0) && parts.popupBrowsers === 0, parts),
            blocks: pass(blocking.blocked === true, blocking),
            noErrors: pass(errors !== undefined && errors.runtime.length === 0 && errors.ubo.length === 0,
                errors),
        },
        readyAfter: report.readyAfter,
        error: report.error,
    };
    return report;
};

const runUpgrade = ( ) => getPref('upgradeStage', 1) === 1 ? upgradeStage1() : upgradeStage2();

/******************************************************************************/

// Stalls: what blocks the browser's main thread, its only one, while uBO
// builds its engines: on a first install, on a reload of all its lists (as
// after a list update), and while it saves its selfie. A heartbeat every
// 16 ms from the add-on's start: any gap is a freeze the user feels.

const stalls = { started: 0, gaps: [], timer: null };

const startStallMonitor = function() {
    stalls.started = Date.now();
    let last = stalls.started;
    const tick = ( ) => {
        const now = Date.now();
        const gap = now - last - 16;
        if ( gap >= 50 ) { stalls.gaps.push({ at: now - gap, ms: gap }); }
        last = now;
        stalls.timer = setTimeout(tick, 16);
    };
    stalls.timer = setTimeout(tick, 16);
};

// The gaps between two moments: the longest, how many above 100 ms, and the
// three longest, with when they began (ms after `from`).
const stallsBetween = function(from, to) {
    const gaps = stalls.gaps.filter(g => g.at >= from && g.at < to);
    return {
        longestStallMs: gaps.reduce((max, g) => Math.max(max, g.ms), 0),
        stallsOver100ms: gaps.filter(g => g.ms > 100).length,
        longest: gaps.slice().sort((a, b) => b.ms - a.ms).slice(0, 3)
            .map(g => `${g.ms} ms at +${g.at - from} ms`),
    };
};

// The bytes under `file`.
const sizeOf = function(file) {
    if ( file.exists() === false ) { return 0; }
    if ( file.isDirectory() === false ) { return file.fileSize; }
    let total = 0;
    const entries = file.directoryEntries;
    while ( entries.hasMoreElements() ) {
        total += sizeOf(entries.getNext().QueryInterface(Ci.nsIFile));
    }
    return total;
};

// What uBO's data weighs on disk, in MB: its cache's IndexedDB (the
// moz-extension origin's), and the browser's own IndexedDB, which holds
// storage.local and whatever else chrome code keeps there.
const storageSizes = function() {
    const storage = Services.dirsvc.get('ProfD', Ci.nsIFile);
    storage.append('storage');
    const origins = storage.clone();
    origins.append('default');
    let cache = 0;
    if ( origins.exists() ) {
        const entries = origins.directoryEntries;
        while ( entries.hasMoreElements() ) {
            const entry = entries.getNext().QueryInterface(Ci.nsIFile);
            if ( entry.leafName.startsWith('moz-extension+++') ) { cache += sizeOf(entry); }
        }
    }
    const chrome = storage.clone();
    chrome.append('permanent');
    chrome.append('chrome');
    const mb = bytes => Math.round(bytes / 10485.76) / 100;
    return { uboCacheMB: mb(cache), chromeIndexedDBMB: mb(sizeOf(chrome)) };
};

// The keys the add-on's storage.local holds (api-core.js), or null.
const storageLocalKeys = addonId => new Promise(resolve => {
    const request = indexedDB.open(`uxp-webext-storage:${addonId}`, 1);
    request.onsuccess = ( ) => {
        const db = request.result;
        const keys = db.transaction('local', 'readonly').objectStore('local').getAllKeys();
        keys.onsuccess = ( ) => { db.close(); resolve(keys.result); };
        keys.onerror = ( ) => { db.close(); resolve(null); };
    };
    request.onerror = event => {
        event.preventDefault();
        resolve(null);
    };
});

// A µBlock method of the background page, its Promise awaited.
const callUBO = function(bgWindow, path, ...args) {
    const page = Cu.waiveXrays(bgWindow);
    const names = path.split('.');
    const method = names.pop();
    const target = names.reduce((object, name) => object[name], page.µBlock);
    return new Promise(resolve => {
        try {
            Promise.resolve(target[method](...args.map(a => Cu.cloneInto(a, page)))).then(
                ( ) => { resolve({}); },
                error => { resolve({ error: String(error && error.message || error) }); }
            );
        } catch (ex) {
            resolve({ error: String(ex && ex.message || ex) });
        }
    });
};

// How many filters each enabled list has, as the dashboard shows it. (How
// many are used depends on the order the lists load in: a filter two lists
// share is a duplicate in the second.)
const listCounts = function(µb) {
    const out = {};
    for ( const [ key, entry ] of Object.entries(plain(µb.availableFilterLists)) ) {
        if ( entry.off === true || entry.entryCount === undefined ) { continue; }
        out[key] = entry.entryCount;
    }
    return out;
};

// A test page: how long it takes, and whether its image at `blockedPath`
// reached the server. Opened while uBO reloads its lists: once uBO filters,
// a reload no longer holds network requests, and the engines from before
// still block (storage.js, onFilterListsReady()).
const testPage = async function(win, server, path, blockedPath) {
    const adRequests = ( ) => server.requests.filter(r => r.endsWith(blockedPath)).length;
    const before = adRequests();
    const t0 = Date.now();
    const tab = win.gBrowser.addTab(`http://${STOP_HOST}:${server.port}${path}?t=${t0}`);
    const page = await finishedPage(tab, 30000);
    const endedAt = Date.now();
    win.gBrowser.removeTab(tab);
    return {
        finished: page.finished,
        loadMs: endedAt - t0,
        endedAt,
        okImage: page.results && page.results.okImage === true,
        adBlocked: adRequests() === before,
    };
};

// Whether the page loaded fast, before the reload it was opened during
// ended, and with what it should block blocked.
const passedWhileReloading = (page, reloadEndedAt) =>
    page !== undefined && page.finished && page.loadMs < 3000 &&
        page.endedAt < reloadEndedAt && page.okImage && page.adBlocked;

const runStalls = async function() {
    const report = {};
    let failure = null;
    const server = new TestServer(stopRoutes);
    server.start();
    try {
        const { bgWindow, µb } = await whenUBOReady();
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        report.firstInstall = { readyAfterMs: Date.now() - stalls.started };
        await sleep(3000);
        Object.assign(report.firstInstall, stallsBetween(stalls.started, Date.now()));
        const countsBefore = listCounts(µb);

        // All lists reloaded, from their compiled form, as after a list
        // update; a page opened a second in. Then a filter added, which the
        // engines the reload swaps in may not have read: uBO loads the lists
        // again after it (storage.js, appendUserFilters()).
        let from = Date.now();
        let reloading = callUBO(bgWindow, 'loadFilterLists');
        await sleep(1000);
        report.pageDuringReload = await testPage(win, server, '/probe.html', '/uxp-blocked/probe.svg');
        await callUBO(bgWindow, 'createUserFilters', { filters: ADDED_FILTER });
        report.reload = await reloading;
        report.reload.durationMs = Date.now() - from;
        report.reload.endedAt = Date.now();
        report.reload.countsBefore = countsBefore;
        report.reload.countsAfter = listCounts(µb);
        await sleep(3000);
        Object.assign(report.reload, stallsBetween(from, Date.now()));
        // The load the added filter brought about, once done: none at all
        // would leave it out of the engines swapped in.
        await waitFor(( ) => Cu.waiveXrays(bgWindow).µBlock.filterListsLoading() === undefined,
            60000, 'the load after the added filter');
        report.pageWithAddedFilter = await testPage(win, server, '/added.html', '/uxp-added/probe.svg');
        // The user filters as the admin's: at a launch, uBO overwrites them
        // with those, and its selfie with them, if they differ.
        await callUBO(bgWindow, 'saveUserFilters', STOP_FILTERS.join('\n'));

        // An update of urlhaus, the biggest list: compiled again, then all
        // lists reloaded, as uBO's updater does; a page opened a second in.
        from = Date.now();
        await callUBO(bgWindow, 'removeCompiledFilterList', 'urlhaus-1');
        reloading = callUBO(bgWindow, 'loadFilterLists');
        await sleep(1000);
        report.pageDuringUpdate = await testPage(win, server, '/probe.html', '/uxp-blocked/probe.svg');
        report.update = await reloading;
        report.update.durationMs = Date.now() - from;
        report.update.endedAt = Date.now();
        report.update.countsBefore = countsBefore;
        await sleep(3000);
        Object.assign(report.update, stallsBetween(from, Date.now()));
        report.update.countsAfter = listCounts(µb);

        // uBO's selfie save, a minute after each rebuild.
        from = Date.now();
        report.selfie = await callUBO(bgWindow, 'selfieManager.create');
        report.selfie.durationMs = Date.now() - from;
        // uBO lists what its cache holds in a registry it saves 3 s after
        // a write, and reads nothing it doesn't list: a relaunch of this
        // profile (boot --keep-profile) loads this selfie only after that.
        await sleep(5000);
        Object.assign(report.selfie, stallsBetween(from, Date.now()));

        // What uBO's data weighs in the profile, and what of its cache
        // storage.local holds: compiled lists and selfies are IndexedDB's
        // alone (cachestorage.js, fastCacheOnly()).
        report.storage = storageSizes();
        const keys = await storageLocalKeys(addonData.id);
        report.storage.derivedInStorageLocal = keys === null
            ? null
            : keys.filter(key => /^cache\/(compiled|selfie)\//.test(key));
    } catch (ex) {
        failure = String(ex);
    }
    server.stop();
    clearTimeout(stalls.timer);
    report.builtBy = consoleLines
        .filter(l => /Network filters built/.test(l.text))
        .map(l => l.text.replace(/^\[uBO\] loadFilterLists\(\) /, ''));
    // Every list compiled: on the first install, and urlhaus's update.
    report.compiledBy = compiledWhere(0).map(({ key, where }) => `${key} ${where}`);
    const compiledOnPage = report.compiledBy.filter(t => t.endsWith(' in a worker') === false);
    // Every compiled list and selfie written to IndexedDB (cachestorage.js,
    // setEntriesInWorker()).
    report.storedBy = consoleLines
        .filter(l => /idbStorage\(\) \S+ (not )?written in a worker/.test(l.text))
        .map(l => l.text.replace(/^\[uBO\] idbStorage\(\) /, ''));
    const storedOnPage = report.storedBy.filter(t => t.includes('not written'));
    const pass = (ok, value) => ok ? 'PASS' : `FAIL: ${JSON.stringify(value)}`;
    const { firstInstall = {}, reload = {}, update = {}, selfie = {} } = report;
    const sameCounts = (after, before) => after !== undefined && JSON.stringify(after) === JSON.stringify(before);
    const added = report.pageWithAddedFilter;
    const checks = {
        // The first install's, the reload's, the one after the added
        // filter, the update's.
        builtInWorker: pass(report.builtBy.length === 4 && report.builtBy.every(t => t.includes('in a worker')), report.builtBy),
        compiledInWorker: pass(report.compiledBy.length !== 0 && compiledOnPage.length === 0, compiledOnPage),
        reloadCountsUnchanged: pass(sameCounts(reload.countsAfter, reload.countsBefore), reload.countsAfter),
        updateCountsUnchanged: pass(sameCounts(update.countsAfter, update.countsBefore), update.countsAfter),
        reloadNoFreeze: pass(reload.longestStallMs < 300, reload.longest),
        pageDuringReload: pass(passedWhileReloading(report.pageDuringReload, reload.endedAt), report.pageDuringReload),
        pageDuringUpdate: pass(passedWhileReloading(report.pageDuringUpdate, update.endedAt), report.pageDuringUpdate),
        filterAddedDuringReload: pass(added !== undefined && added.finished && added.okImage && added.adBlocked, added),
        selfieNoFreeze: pass(selfie.longestStallMs < 300, selfie.longest),
        storedInWorker: pass(report.storedBy.length !== 0 && storedOnPage.length === 0, storedOnPage),
        derivedOnlyInIndexedDB: pass(
            report.storage !== undefined && report.storage.derivedInStorageLocal !== null &&
                report.storage.derivedInStorageLocal.length === 0,
            report.storage && report.storage.derivedInStorageLocal
        ),
    };
    const brief = phase => phase && {
        durationMs: phase.durationMs || phase.readyAfterMs,
        longestStallMs: phase.longestStallMs,
        stallsOver100ms: phase.stallsOver100ms,
        longest: phase.longest,
    };
    report.summary = {
        app: `${Services.appinfo.name} ${Services.appinfo.version}`,
        checks,
        firstInstall: brief(firstInstall),
        reload: brief(reload),
        update: brief(update),
        selfie: brief(selfie),
        pageLoadMs: report.pageDuringReload && {
            duringReload: report.pageDuringReload.loadMs,
            duringUpdate: report.pageDuringUpdate && report.pageDuringUpdate.loadMs,
        },
        builtBy: report.builtBy,
        storage: report.storage,
    };
    if ( failure !== null ) {
        report.error = failure;
    }
    return report;
};

/******************************************************************************/

// Compile: uBO's compiling off the main thread (µb.compileFiltersAsync(),
// the engine's worker) makes of each enabled list exactly what its own
// compiler on the background page makes of it (µb.compileFilters()), byte
// for byte, and what each costs the browser's main thread. The raw lists
// are the package's.

// A file of the add-on's package, as text.
const readPackageText = function(rel) {
    const channel = NetUtil.newChannel({
        uri: addonData.resourceURI.spec + rel,
        loadUsingSystemPrincipal: true,
    });
    const stream = typeof channel.open2 === 'function' ? channel.open2() : channel.open();
    try {
        return NetUtil.readInputStreamToString(stream, stream.available(), { charset: 'UTF-8' });
    } finally {
        stream.close();
    }
};

// Where two texts first differ: the offset, the line, each one's line.
const firstDifference = function(a, b) {
    let i = 0;
    while ( i < a.length && a.charCodeAt(i) === b.charCodeAt(i) ) { i += 1; }
    const start = a.lastIndexOf('\n', i - 1) + 1;
    let line = 1;
    for ( let j = a.indexOf('\n'); j !== -1 && j < start; j = a.indexOf('\n', j + 1) ) {
        line += 1;
    }
    const lineAt = s => {
        const end = s.indexOf('\n', start);
        return s.slice(start, end === -1 ? s.length : end).slice(0, 200);
    };
    return { offset: i, line, worker: lineAt(a), page: lineAt(b) };
};

const megabytes = s => Math.round(s.length / 10485.76) / 100;

// What uBO logged of where it compiled lists (compileFiltersAsync()), from
// the console's line `first` on: [ { key, where } ], where is 'in a worker'
// or 'on the page: <reason>'.
const compiledWhere = function(first) {
    const out = [];
    for ( const line of consoleLines.slice(first) ) {
        const match = /compileFiltersAsync\(\) (\S+) compiled (.+)$/.exec(line.text);
        if ( match !== null ) { out.push({ key: match[1], where: match[2] }); }
    }
    return out;
};

const runCompile = async function() {
    const report = { lists: {} };
    let failure = null;
    try {
        const { bgWindow } = await whenUBOReady();
        const page = Cu.waiveXrays(bgWindow);
        const µb = page.µBlock;
        // uBO's own selfie save, done now rather than in the middle.
        await callUBO(bgWindow, 'selfieManager.create');

        // The enabled lists the package holds.
        const lists = [];
        for ( const [ key, entry ] of Object.entries(plain(µb.availableFilterLists)) ) {
            if ( entry.off === true ) { continue; }
            const locals = [].concat(entry.contentURL || []).filter(url => /^[a-z]+:/i.test(url) === false);
            if ( locals.length === 0 ) { continue; }
            let raw;
            for ( const local of locals ) {
                try {
                    raw = readPackageText(local);
                    break;
                } catch {
                }
            }
            if ( raw === undefined ) {
                report.lists[key] = { notInPackage: locals.join(', ') };
                continue;
            }
            lists.push({ key, raw });
        }
        await sleep(3000);

        // All lists compiled off the main thread; then by uBO's compiler on
        // the page, each result compared with the other.
        const details = key => Cu.cloneInto({
            assetKey: key,
            trustedSource: µb.isTrustedList(key),
        }, page);
        startStallMonitor();
        const offThread = new Map();
        const firstLine = consoleLines.length;
        let from = Date.now();
        for ( const { key, raw } of lists ) {
            report.lists[key] = { rawMB: megabytes(raw) };
            const t0 = Date.now();
            offThread.set(key, await Promise.resolve(µb.compileFiltersAsync(raw, details(key))));
            report.lists[key].workerMs = Date.now() - t0;
        }
        report.compiledWhere = Object.fromEntries(
            compiledWhere(firstLine).map(({ key, where }) => [ key, where ])
        );
        report.worker = { durationMs: Date.now() - from, ...stallsBetween(from, Date.now()) };

        from = Date.now();
        for ( const { key, raw } of lists ) {
            const result = report.lists[key];
            const t0 = Date.now();
            const compiled = µb.compileFilters(raw, details(key));
            result.pageMs = Date.now() - t0;
            result.compiledMB = megabytes(compiled);
            const theirs = offThread.get(key);
            offThread.delete(key);
            result.identical = theirs === compiled;
            if ( result.identical === false ) {
                result.firstDifference = firstDifference(theirs, compiled);
            }
            await sleep(0);
        }
        report.page = { durationMs: Date.now() - from, ...stallsBetween(from, Date.now()) };
    } catch (ex) {
        failure = String(ex);
    }
    clearTimeout(stalls.timer);
    const pass = (ok, value) => ok ? 'PASS' : `FAIL: ${JSON.stringify(value)}`;
    const checked = Object.entries(report.lists).filter(([ , r ]) => r.notInPackage === undefined);
    const differing = checked.filter(([ , r ]) => r.identical !== true).map(([ key ]) => key);
    const { compiledWhere: where = {}, worker = {} } = report;
    const notInWorker = checked.filter(([ key ]) => where[key] !== 'in a worker')
        .map(([ key ]) => `${key}: ${where[key] || 'not logged'}`);
    report.summary = {
        app: `${Services.appinfo.name} ${Services.appinfo.version}`,
        checks: {
            compiledInWorker: pass(checked.length !== 0 && notInWorker.length === 0, notInWorker),
            identicalToPage: pass(checked.length !== 0 && differing.length === 0, differing),
            workerNoFreeze: pass(worker.longestStallMs < 300, worker.longest),
        },
        worker: report.worker,
        page: report.page,
        lists: Object.fromEntries(Object.entries(report.lists).map(([ key, r ]) => [ key, r.notInPackage
            ? `not in the package: ${r.notInPackage}`
            : `raw ${r.rawMB} MB -> ${r.compiledMB} MB, worker ${r.workerMs} ms, page ${r.pageMs} ms`,
        ])),
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

/******************************************************************************/

// Screen captures of this browser's windows, popups included (an arrow
// panel is a window of its own, which drawWindow() does not see): the
// launcher takes them (tools/uxp-capture.ps1). A process started from here
// would take the focus, and the browser would close its popups.
// Resolves with the PNG's path, or with why there is none.
const captureScreen = async function(name) {
    const done = outDir.clone();
    done.append(`${name}.captured`);
    if ( done.exists() ) { done.remove(false); }
    writeText(`${name}.capture-request`, String(Services.appinfo.processID));
    try {
        await waitFor(( ) => done.exists(), 30000, 'the capture');
    } catch {
        return 'no capture: the launcher did not answer';
    }
    const result = readBytes(done.path);
    const png = outDir.clone();
    png.append(name);
    if ( result === 'ok' ) { return png.path; }
    return result.startsWith('ok, ')
        ? `${png.path} (${result.slice(4)}: another window was over it)`
        : `no capture: ${result}`;
};

// A script of the tester's own (the launcher's --script=<file>), run with
// the harness's helpers: explorations which need no scenario of their own.
// It may return an object, its `summary` printed by the launcher.
const runScript = async function() {
    const text = decodeURIComponent(escape(readBytes(getPref('script', ''))));
    const body = new Function('h', `return (async ( ) => {\n${text}\n})();`);
    const report = {};
    const h = {
        Cc, Ci, Cu, Services, report, sleep, waitFor, plain, openTab,
        whenUBOReady, callBackground, callUBO, saveScreenshot, captureScreen,
        log, writeText, errorsSince, TestServer, getPref, readAnyPref,
        ownErrors: ( ) => ownErrors(consoleLines),
        consoleLines: ( ) => consoleLines.slice(),
        extension: ( ) => extension,
        outDir: ( ) => outDir.path,
    };
    try {
        Object.assign(report, await body(h) || {});
    } catch (ex) {
        report.scriptError = `${ex}\n${ex && ex.stack}`;
    }
    report.ownErrors = ownErrors(consoleLines);
    return report;
};

const scenarios = {
    script: runScript,
    probe: runProbes,
    boot: runBoot,
    network: runNetwork,
    cosmetic: runCosmetic,
    ui: runUI,
    popup: runPopup,
    filtering: runFiltering,
    uninstall: ( ) => runUninstall(false),
    'uninstall-disabled': ( ) => runUninstall(true),
    update: runUpdate,
    'stop-busy': runStopBusy,
    pages: runPages,
    dashboard: runDashboard,
    legacy: runLegacy,
    upgrade: runUpgrade,
    stalls: runStalls,
    compile: runCompile,
};

// Filters and user settings given to uBO through managed storage.
const SCENARIO_FILTERS = {
    network: NETWORK_FILTERS,
    cosmetic: COSMETIC_FILTERS,
    ui: UI_FILTERS,
    filtering: FILTERING_FILTERS,
    'stop-busy': STOP_FILTERS,
    upgrade: STOP_FILTERS,
    legacy: STOP_FILTERS,
    // Its pages opened while uBO reloads (testPage()).
    stalls: STOP_FILTERS,
};
const SCENARIO_USER_SETTINGS = {
    filtering: FILTERING_USER_SETTINGS,
    // Its own update phase only: uBO's updater would overlap the others.
    stalls: [ [ 'autoUpdate', 'false' ] ],
    compile: [ [ 'autoUpdate', 'false' ] ],
};

// Test pages served under a name of their own (network.dns.localDomains).
const SCENARIO_HOSTS = {
    cosmetic: COSMETIC_HOST,
    filtering: FILTERING_HOST,
    'stop-busy': STOP_HOST,
    upgrade: STOP_HOST,
    legacy: STOP_HOST,
    stalls: STOP_HOST,
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
    // From now on, before uBO starts.
    if ( scenario === 'stalls' ) {
        startStallMonitor();
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

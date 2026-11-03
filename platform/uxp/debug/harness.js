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
//             and write <scenario>.json
//   autoQuit  true    quit the application once the scenario is done
// Without autoQuit, a manually installed debug build never quits the browser.

/* exported harness */

'use strict';

// `var` so that loadSubScript() exposes it to bootstrap.js.
var harness = (( ) => {

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;
const { Services } = Cu.import('resource://gre/modules/Services.jsm', {});
const { XPCOMUtils } = Cu.import('resource://gre/modules/XPCOMUtils.jsm', {});
const { NetUtil } = Cu.import('resource://gre/modules/NetUtil.jsm', {});
const { setTimeout, clearTimeout } = Cu.import('resource://gre/modules/Timer.jsm', {});

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
    } catch (ex) {
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
    } catch (ex) {
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
    } catch (ex) {
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
    } catch (ex) {
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
        } catch (ex) {
            out[name] = false;
        }
    }
    return out;
};

const parseIn = function(win, table) {
    const out = {};
    for ( const [ name, source ] of Object.entries(table) ) {
        try {
            new win.Function(source); // eslint-disable-line no-new-func
            out[name] = true;
        } catch (ex) {
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
    } catch (ex) {
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
    } catch (ex) {
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
        } catch (ex) {
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
            } catch (ex) {
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
    } catch (ex) {
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
        } catch (ex) {
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

const ownErrors = lines => lines
    .filter(line => line.kind === 'error' || line.kind === 'console.error')
    .filter(line => OWN_SOURCES.test(line.source))
    .map(line => `${line.text} @ ${line.source}`);

const placeholdersHit = lines => Array.from(new Set(
    lines.filter(l => l.text.includes('is not implemented yet')).map(l => l.text)
));

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
            report.dashboard.listEntries = await waitFor(( ) =>
                page.doc.querySelectorAll('.listEntry[data-key]').length,
                15000, 'lists rendered in 3p-filters.html'
            );
        } catch (ex) {
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
        placeholdersHit: placeholdersHit(lines),
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
                } catch (ex) {
                    input.close();
                    output.close();
                    return;
                }
                if ( received.includes('\r\n\r\n') === false ) {
                    input.asyncWait(reader, 0, 0, Services.tm.mainThread);
                    return;
                }
                this.respond(received, output);
                input.close();
            },
        };
        input.asyncWait(reader, 0, 0, Services.tm.mainThread);
    }

    respond(request, output) {
        const path = request.split('\r\n', 1)[0].split(' ')[1] || '/';
        const host = (/^host:\s*(\S+)/im.exec(request) || [ '', '' ])[1];
        this.requests.push(`${host.replace(/:\d+$/, '')}${path}`);
        const route = this.routes(path.replace(/\?.*$/, ''), this.port);
        const body = route !== null ? route.body : 'not found';
        const response = [
            `HTTP/1.1 ${route !== null ? '200 OK' : '404 Not Found'}`,
            `Content-Type: ${route !== null ? route.type : 'text/plain'}`,
            `Content-Length: ${body.length}`,
            'Cache-Control: no-store',
            'Connection: close',
            '',
            body,
        ].join('\r\n');
        output.write(response, response.length);
        output.close();
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
        placeholdersHit: placeholdersHit(consoleLines),
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

// Calls the background page's browser.* API as the page itself would;
// settles with { value } or { error }.
const callBackground = function(bgWindow, path, ...args) {
    const page = Cu.waiveXrays(bgWindow);
    const [ namespace, name ] = path.split('.');
    return new Promise(resolve => {
        page.browser[namespace][name](...args.map(a => Cu.cloneInto(a, page))).then(
            Cu.exportFunction(value => { resolve({ value: plain(value) }); }, page),
            Cu.exportFunction(error => { resolve({ error: String(error && error.message) }); }, page)
        );
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
        } catch (ex) {
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
        placeholdersHit: placeholdersHit(consoleLines),
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
        const button = await waitFor(( ) =>
            win.document.querySelector('[id="uBlock0-legacy-button"], [id="ublock0-button"]'),
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

        // Web pages may load web-accessible resources (the element picker,
        // redirect= filters), not the rest of the package. The page's own
        // script loads them: a load started from here would be the
        // browser's.
        const pageLoads = async path => {
            const key = `load${path.replace(/\W/g, '')}`;
            const script = page.doc.createElement('script');
            script.textContent = `{
                const img = new Image();
                img.onload = ( ) => { document.documentElement.dataset.${key} = 'true'; };
                img.onerror = ( ) => { document.documentElement.dataset.${key} = 'false'; };
                img.src = ${JSON.stringify(ext.getURL(path))};
            }`;
            page.doc.body.appendChild(script);
            return waitFor(( ) => page.doc.documentElement.dataset[key], 5000, path)
                .then(result => result === 'true', ( ) => 'timeout');
        };
        report.webAccessible = {
            'web_accessible_resources/1x1.gif': await pageLoads('web_accessible_resources/1x1.gif'),
            'img/icon_16.png': await pageLoads('img/icon_16.png'),
        };

        // Each part on its own: a failure does not hide the next parts.
        const section = async (name, fn) => {
            try {
                await fn();
            } catch (ex) {
                report.errors = report.errors || {};
                report.errors[name] = String(ex);
            }
        };

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
            report.popupClosedItself = await waitFor(( ) =>
                findPopupBrowser() === null, 5000, 'the popup to close'
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
            report.pickerStarted = await waitFor(( ) =>
                Array.from(page.doc.querySelectorAll('iframe'), f => f.contentDocument ? f.contentDocument.documentURI : 'no document')
                    .some(url => url.includes('/epicker-ui.html')), 10000, 'the element picker'
            ).catch(( ) => false);
            report.pageFrames = Array.from(page.doc.querySelectorAll('iframe'), f => f.contentDocument ? f.contentDocument.documentURI : 'no document');
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
            const loggerTab = await waitFor(( ) =>
                openTabs().find(t => t.linkedBrowser.currentURI.spec.includes('logger-ui.html')),
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
            const manager = await waitFor(( ) => {
                const tab = openTabs().find(t => t.linkedBrowser.currentURI.spec.startsWith('about:addons'));
                const w = tab && tab.linkedBrowser.contentWindow;
                const view = w && w.gViewController && w.gViewController.currentViewObj;
                const item = view && typeof view.getListItemForID === 'function'
                    ? view.getListItemForID(ext.id)
                    : null;
                return item ? { tab, doc: w.document, item } : null;
            }, 10000, 'the Add-ons Manager');
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
    checks.webAccessible = pass(report.webAccessible && report.webAccessible['web_accessible_resources/1x1.gif'] === true && report.webAccessible['img/icon_16.png'] === false, report.webAccessible);
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
        placeholdersHit: placeholdersHit(consoleLines),
        ownErrors: ownErrors(consoleLines),
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
        } catch (ex) {
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
};

// Filters given to uBO through managed storage.
const SCENARIO_FILTERS = {
    network: NETWORK_FILTERS,
    cosmetic: COSMETIC_FILTERS,
    ui: UI_FILTERS,
};

const runScenario = async function(name) {
    const started = Date.now();
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
    const linger = getPref('lingerSeconds', 0);
    if ( linger > 0 ) {
        log(`scenario "${name}": lingering ${linger} s`);
        await sleep(linger * 1000);
    }
    writeText(`${name}.json`, JSON.stringify(result, null, 2));
    writeText('done', name);
    log(`scenario "${name}": done`);
    if ( getPref('autoQuit', false) ) {
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
    writeText('console.log', '');
    record('harness', '--- console messages logged before the add-on started ---');
    for ( const message of Services.console.getMessageArray() || [] ) {
        recordConsoleMessage(message, false);
    }
    record('harness', '--- end of earlier messages ---');
    Services.console.registerListener(consoleListener);
    Services.obs.addObserver(consoleAPIObserver, 'console-api-log-event', false);
    log(`started: ${data.id} ${data.version} (reason ${reason})`);

    const scenario = getPref('scenario', '');
    if ( scenario === '' ) { return; }
    if ( scenarios.hasOwnProperty(scenario) === false ) {
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
        Services.prefs.setCharPref(PREF_MANAGED_STORAGE, JSON.stringify(managed));
    }
    if ( scenario === 'network' ) {
        // Let the test page's window.open() through the popup blocker.
        Services.prefs.setBoolPref('dom.disable_open_during_load', false);
    }
    if ( scenario === 'cosmetic' ) {
        Services.prefs.setCharPref('network.dns.localDomains', COSMETIC_HOST);
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

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
//   scenario  ''      mirror the console to <profile>/uxp-test/console.log
//             'probe' also probe the platform and write probe.json
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
    return { doc, close: ( ) => { win.gBrowser.removeTab(tab); } };
};

const ownErrors = lines => lines
    .filter(line => line.kind === 'error' || line.kind === 'console.error')
    .filter(line => OWN_SOURCES.test(line.source))
    .map(line => `${line.text} @ ${line.source}`);

const runBoot = async function() {
    const report = {};
    let failure = null;
    try {
        const ext = await waitFor(( ) => extension, 30000, 'the extension');
        report.uuid = ext.uuid;
        const bgWindow = await waitFor(( ) => ext.background && ext.background.window, 60000, 'the background page');
        // allReadyAfter starts as '?' (background.js).
        const µb = await waitFor(( ) => {
            const µb = Cu.waiveXrays(bgWindow).µBlock;
            return µb && µb.readyToFilter === true &&
                µb.supportStats.allReadyAfter !== '?' ? µb : null;
        }, 180000, 'uBO to report "all ready"');
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
        placeholdersHit: Array.from(new Set(
            lines.filter(l => l.text.includes('is not implemented yet')).map(l => l.text)
        )),
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
    // Test runs get uBO's own diagnostics (ubolog) through an admin setting.
    if ( Services.prefs.prefHasUserValue(PREF_MANAGED_STORAGE) === false ) {
        Services.prefs.setCharPref(PREF_MANAGED_STORAGE, JSON.stringify({
            advancedSettings: [ [ 'consoleLogLevel', 'info' ] ],
        }));
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

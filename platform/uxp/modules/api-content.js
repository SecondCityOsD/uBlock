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

// Content scripts: the manifest's content_scripts, contentScripts.register(),
// tabs.executeScript()/insertCSS()/removeCSS(), and the tabs.sendMessage()/
// tabs.connect() side of messaging.
//
// As in Firefox, a document gets one content-script context: an Xray sandbox
// whose prototype is the document's window, with the expanded principal
// [page, extension]. All of the extension's scripts for that document run
// in it -- declared, registered, then injected ones -- so they share their
// globals (uBO's contentscript-extra.js uses the vAPI which vapi.js made).
// document_start scripts run from `document-element-inserted`, before any
// script of the page. Some documents never get that notification: an
// initial about:blank document, created complete, is caught when its window
// is created; the about:blank document which then replaces it in the same
// window (Gecko loads one into a frame without src), when it becomes
// interactive.
//
// Loaded into Extension.jsm's global (see there).

/* global Cc, Ci, Cu, Services, NetUtil, URL, NAME_PREFIX, dispatch,
          MatchPattern, windowUtilsOf, Context, ExtensionError, PageValue,
          apiSync, apiAsync, injectAPI */
/* exported createContentAPIs */

'use strict';

var { createContentAPIs } = (( ) => {

const RUN_AT = new Set([ 'document_start', 'document_end', 'document_idle' ]);
const DOCUMENT_TOPICS = [
    'document-element-inserted',
    'content-document-global-created',
    'content-document-interactive',
];
const NO_HOST_PERMISSION = 'Missing host permission for the tab';
const NOT_CLONEABLE = 'Script returned non-structured-clonable data';
const { AUTHOR_SHEET, USER_SHEET } = Ci.nsIDOMWindowUtils;

/******************************************************************************/

const parseURL = function(spec) {
    try {
        return new URL(spec);
    } catch {
    }
    return null;
};

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const globToRegex = function(glob) {
    const body = String(glob).split(/([*?])/).map(part => {
        if ( part === '*' ) { return '.*'; }
        if ( part === '?' ) { return '.'; }
        return escapeRegex(part);
    }).join('');
    return new RegExp(`^${body}$`);
};

const checkRunAt = function(runAt) {
    if ( runAt === undefined ) { return 'document_idle'; }
    if ( RUN_AT.has(runAt) === false ) {
        throw new ExtensionError(`Invalid runAt: ${runAt}`);
    }
    return runAt;
};

// A script's world: its isolated content-script sandbox, or the page's own
// global (`MAIN`, Firefox 128).
const checkWorld = function(world) {
    if ( world === undefined || world === 'ISOLATED' ) { return 'ISOLATED'; }
    if ( world === 'MAIN' ) { return 'MAIN'; }
    throw new ExtensionError(`Invalid world: ${world}`);
};

const checkCSSOrigin = function(cssOrigin) {
    if ( cssOrigin === undefined || cssOrigin === 'author' ) { return AUTHOR_SHEET; }
    if ( cssOrigin === 'user' ) { return USER_SHEET; }
    throw new ExtensionError(`Invalid cssOrigin: ${cssOrigin}`);
};

// The ([tabId], details) argument forms of executeScript() & co.
const tabIdAndDetails = function(args) {
    const [ first, second ] = args;
    if ( first !== null && typeof first === 'object' ) {
        return [ undefined, first ];
    }
    if ( second === null || typeof second !== 'object' ) {
        throw new ExtensionError('Missing details');
    }
    return [ first === null ? undefined : first, second ];
};

const frameIdOption = options =>
    options !== null && typeof options === 'object' && typeof options.frameId === 'number'
        ? options.frameId
        : undefined;

// Calls reaching into pages complete as a task of their own, as in Firefox,
// where they cross processes.
const nextTask = ( ) => new Promise(resolve => { dispatch(resolve); });

// The URLs a document is matched by: its own, or with matchAboutBlank, for
// about:blank and about:srcdoc, its principal's -- the URL of the document
// which created it. With matchOriginAsFallback (Firefox 128), blob: frames
// too are matched by their principal's; data: frames, whose principals are
// opaque, are not. System and expanded principals have no URL.
const documentURLsOf = function(doc) {
    const spec = doc.documentURI;
    const isAboutBlank = /^about:(?:blank|srcdoc)(?:[?#]|$)/.test(spec);
    let originURL = null;
    if ( isAboutBlank || spec.startsWith('blob:') ) {
        try {
            originURL = parseURL(doc.nodePrincipal.URI.spec);
        } catch {
        }
    }
    return {
        url: isAboutBlank ? null : parseURL(spec),
        aboutBlankURL: isAboutBlank ? originURL : null,
        originURL,
    };
};

const urlToMatch = function(urls, matchAboutBlank, matchOriginAsFallback = false) {
    if ( matchOriginAsFallback && urls.originURL !== null ) { return urls.originURL; }
    if ( urls.url !== null ) { return urls.url; }
    return matchAboutBlank ? urls.aboutBlankURL : null;
};

// Script results reach the caller structured-cloned, as in Firefox.
const resultOf = function(frame, value) {
    if ( typeof value === 'function' || typeof value === 'symbol' ) {
        throw new ExtensionError(NOT_CLONEABLE);
    }
    try {
        return frame.cloneIn(value);
    } catch {
        throw new ExtensionError(NOT_CLONEABLE);
    }
};

/******************************************************************************/

// Script and style sheet sources: { code } or { file }, the latter resolved
// against the caller's URL, and read from the package once.

const Sources = class {
    constructor(extension) {
        this.extension = extension;
        this.files = new Map();
    }

    resolve(entry, baseURL) {
        const isObject = entry !== null && typeof entry === 'object';
        const hasCode = isObject && typeof entry.code === 'string';
        const hasFile = isObject && typeof entry.file === 'string';
        if ( hasCode === hasFile ) {
            throw new ExtensionError('Exactly one of code and file must be specified');
        }
        if ( hasCode ) {
            return { code: entry.code, url: baseURL };
        }
        let url = '';
        try {
            url = Services.io.newURI(entry.file, null, Services.io.newURI(baseURL, null, null)).spec;
        } catch {
        }
        if ( this.extension.isOwnURL(url) === false ) {
            throw new ExtensionError(`Files to be injected must be within the extension: ${entry.file}`);
        }
        const path = url.slice(this.extension.origin.length + 1).replace(/[?#].*$/, '');
        return { path: decodeURIComponent(path), url };
    }

    textOf(source) {
        if ( source.code !== undefined ) { return source.code; }
        let text = this.files.get(source.path);
        if ( text === undefined ) {
            try {
                text = this.extension.readPackageFile(source.path);
            } catch {
                throw new ExtensionError(`Unable to load ${source.url}`);
            }
            this.files.set(source.path, text);
        }
        return text;
    }

    sheetOf(source, type) {
        return {
            uri: `data:text/css;charset=utf-8,${encodeURIComponent(this.textOf(source))}`,
            type,
        };
    }
};

/******************************************************************************/

// MAIN-world scripts run in the page's own global, as in Firefox, whatever
// the page's CSP. UXP gives chrome code one way there (no evalInWindow, no
// compileScript): the subscript loader, which compiles a script in its
// target's global, but loads local URLs only -- not data: nor blob:. So
// each script's text is written once to a temporary folder, which a chrome
// package of its own maps: the page sees chrome://<package>/content/<n>.js
// in stack traces, not a local path nor this add-on's name, and pages
// cannot load chrome: URLs. A file lasts while a content script holds it.
// Its first read starts as it is written, off the main thread: a file's
// first open costs ~50 ms per 100 KB on Windows (antivirus scanning), its
// next ones ~6 ms, as much as compiling the code in an inline <script>.

const writeTextFile = function(file, text) {
    const stream = Cc['@mozilla.org/network/file-output-stream;1']
        .createInstance(Ci.nsIFileOutputStream);
    // PR_WRONLY | PR_CREATE_FILE | PR_TRUNCATE
    stream.init(file, 0x02 | 0x08 | 0x20, 0o600, 0);
    const converter = Cc['@mozilla.org/intl/converter-output-stream;1']
        .createInstance(Ci.nsIConverterOutputStream);
    converter.init(stream, 'UTF-8', 0, 0);
    try {
        converter.writeString(text);
    } finally {
        converter.close();
    }
};

const PageScripts = class {
    constructor() {
        this.dir = null;
        this.package = '';
        // By text: { text, file, url, holders }
        this.entries = new Map();
        this.count = 0;
    }

    // The folder and its package, made when first needed.
    open() {
        if ( this.dir !== null ) { return this.dir; }
        const dir = Services.dirsvc.get('TmpD', Ci.nsIFile);
        dir.append(`${NAME_PREFIX}-page-scripts`);
        dir.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
        const manifest = dir.clone();
        manifest.append('chrome.manifest');
        this.package = `p${Math.random().toString(36).slice(2, 12)}`;
        writeTextFile(manifest, `content ${this.package} ./\n`);
        Components.manager.addBootstrappedManifestLocation(dir);
        this.dir = dir;
        return dir;
    }

    // The file holding `text`, shared by all who hold it.
    acquire(text) {
        let entry = this.entries.get(text);
        if ( entry === undefined ) {
            const file = this.open().clone();
            const name = `${++this.count}.js`;
            file.append(name);
            writeTextFile(file, text);
            entry = { text, file, url: `chrome://${this.package}/content/${name}`, holders: 0 };
            this.entries.set(text, entry);
            NetUtil.asyncFetch({ uri: entry.url, loadUsingSystemPrincipal: true }, stream => {
                try {
                    stream.close();
                } catch {
                }
            });
        }
        entry.holders += 1;
        return entry;
    }

    release(entry) {
        entry.holders -= 1;
        if ( entry.holders !== 0 || this.entries.get(entry.text) !== entry ) { return; }
        this.entries.delete(entry.text);
        try {
            entry.file.remove(false);
        } catch {
            // Still open for its first read: it goes with the folder.
        }
    }

    stop() {
        const { dir } = this;
        if ( dir === null ) { return; }
        this.dir = null;
        this.entries.clear();
        try {
            Components.manager.removeBootstrappedManifestLocation(dir);
            dir.remove(true);
        } catch (ex) {
            Cu.reportError(ex);
        }
    }
};

/******************************************************************************/

// A content script: a manifest entry, or one registered at runtime.

const ContentScript = class {
    constructor(sources, details, baseURL) {
        const { matches } = details;
        if ( Array.isArray(matches) === false || matches.length === 0 ) {
            throw new ExtensionError('matches must be a non-empty array of match patterns');
        }
        this.matches = new MatchPattern(matches);
        this.excludeMatches = new MatchPattern(details.excludeMatches || []);
        this.includeGlobs = (details.includeGlobs || []).map(globToRegex);
        this.excludeGlobs = (details.excludeGlobs || []).map(globToRegex);
        this.js = (details.js || []).map(entry => sources.resolve(entry, baseURL));
        this.css = (details.css || []).map(entry => sources.resolve(entry, baseURL));
        this.allFrames = details.allFrames === true;
        this.matchAboutBlank = details.matchAboutBlank === true;
        this.matchOriginAsFallback = details.matchOriginAsFallback === true;
        this.runAt = checkRunAt(details.runAt);
        this.world = checkWorld(details.world);
        // A MAIN-world script's files, while it is registered (see
        // ContentScripts.register()): one PageScripts entry per source.
        this.pageFiles = null;
    }

    appliesTo(urls, isTop) {
        if ( isTop === false && this.allFrames === false ) { return false; }
        const url = urlToMatch(urls, this.matchAboutBlank, this.matchOriginAsFallback);
        if ( url === null || this.matches.matchesURL(url) === false ) { return false; }
        if ( this.excludeMatches.matchesURL(url) ) { return false; }
        const { href } = url;
        if ( this.includeGlobs.length !== 0 && this.includeGlobs.some(re => re.test(href)) === false ) {
            return false;
        }
        return this.excludeGlobs.some(re => re.test(href)) === false;
    }
};

/******************************************************************************/

// The content-script context of one document.

const ContentContext = class extends Context {
    constructor(extension, window) {
        const doc = window.document;
        const principal = doc.nodePrincipal;
        const ssm = Services.scriptSecurityManager;
        if ( ssm.isSystemPrincipal(principal) ) {
            throw new Error('Content scripts never run with the system principal');
        }
        // Firefox's own arrangement: the page's origin attributes (private
        // browsing, containers), with the add-on ID.
        const attrs = principal.originAttributes;
        attrs.addonId = extension.id;
        const sandbox = Cu.Sandbox([
            principal,
            ssm.createCodebasePrincipal(extension.baseURI, attrs),
        ], {
            sandboxName: `${extension.id} content script`,
            // Errors are reported to the page's web console.
            metadata: {
                'inner-window-id': windowUtilsOf(window).currentInnerWindowID,
                addonId: extension.id,
            },
            sandboxPrototype: window,
            sameZoneAs: window,
            wantXrays: true,
            isWebExtensionContentScript: true,
            wantExportHelpers: true,
            wantGlobalProperties: [ 'XMLHttpRequest', 'fetch' ],
            originAttributes: attrs,
        });
        super(extension, window, 'content_script', sandbox);
        this.sandbox = sandbox;
        this.document = doc;
        this.sheets = [];
        this.waiting = [];
        this.readyListener = null;
        // The declared and registered scripts were run (see onNewDocument()).
        this.scriptsRun = false;
    }

    // Its document is shown: not navigated away from, nor in the bfcache.
    get isCurrent() {
        return this.unloaded === false && this.window.document === this.document;
    }

    evaluate(text, filename) {
        return Cu.evalInSandbox(text, this.sandbox, 'latest', filename, 1);
    }

    // A script of the MAIN world, from its file (see PageScripts): in the
    // page's own global, exactly as the page's own code -- the page's
    // builtins, `globalThis` the window -- leaving nothing in its DOM.
    evaluateInPage(url) {
        Services.scriptloader.loadSubScriptWithOptions(url, {
            target: this.window,
            charset: 'UTF-8',
            ignoreCache: true,
        });
    }

    reached(runAt) {
        if ( runAt === 'document_start' ) { return true; }
        const state = this.document.readyState;
        return runAt === 'document_end' ? state !== 'loading' : state === 'complete';
    }

    // Calls `run` once the document has reached `runAt`: right away if it
    // has, else from its readystatechange event (system group: the page
    // cannot stop it). `cancel` is called instead if the context unloads.
    whenReached(runAt, run, cancel = null) {
        if ( this.reached(runAt) ) {
            run();
            return;
        }
        this.waiting.push({ runAt, run, cancel });
        if ( this.readyListener !== null ) { return; }
        this.readyListener = ( ) => { this.onReadyStateChange(); };
        Services.els.addSystemEventListener(this.document, 'readystatechange', this.readyListener, false);
    }

    onReadyStateChange() {
        if ( this.unloaded ) { return; }
        const due = this.waiting.filter(w => this.reached(w.runAt));
        if ( due.length === 0 ) { return; }
        this.waiting = this.waiting.filter(w => due.includes(w) === false);
        if ( this.waiting.length === 0 ) {
            this.stopWaiting();
        }
        for ( const { run } of due ) {
            try {
                run();
            } catch (ex) {
                Cu.reportError(ex);
            }
        }
    }

    stopWaiting() {
        if ( this.readyListener === null ) { return; }
        Services.els.removeSystemEventListener(this.document, 'readystatechange', this.readyListener, false);
        this.readyListener = null;
    }

    // A document loads a given sheet once; insertions of the same sheet
    // are counted, and the last removal unloads it.
    hasSheet(sheet) {
        return this.sheets.some(s => s.uri === sheet.uri && s.type === sheet.type);
    }

    addSheet(sheet) {
        if ( this.hasSheet(sheet) === false ) {
            windowUtilsOf(this.window).loadSheetUsingURIString(sheet.uri, sheet.type);
        }
        this.sheets.push(sheet);
    }

    removeSheet(sheet) {
        const i = this.sheets.findIndex(s => s.uri === sheet.uri && s.type === sheet.type);
        if ( i === -1 ) { return; }
        this.sheets.splice(i, 1);
        if ( this.hasSheet(sheet) ) { return; }
        windowUtilsOf(this.window).removeSheetUsingURIString(sheet.uri, sheet.type);
    }

    unload() {
        if ( this.unloaded ) { return; }
        const { window, sandbox, waiting, sheets } = this;
        let shown = false;
        try {
            shown = this.isCurrent &&
                windowUtilsOf(window).currentInnerWindowID === this.innerWindowID;
        } catch {
        }
        this.stopWaiting();
        this.waiting = [];
        this.sheets = [];
        super.unload();
        for ( const { cancel } of waiting ) {
            if ( cancel !== null ) { cancel(); }
        }
        // The extension went away while the document is still shown (it
        // was disabled): leave nothing of it in the page.
        if ( shown ) {
            const utils = windowUtilsOf(window);
            for ( const sheet of new Map(sheets.map(s => [ `${s.type}${s.uri}`, s ])).values() ) {
                try {
                    utils.removeSheetUsingURIString(sheet.uri, sheet.type);
                } catch {
                }
            }
        }
        Cu.nukeSandbox(sandbox);
    }
};

/******************************************************************************/

const ContentScripts = class {
    constructor(extension) {
        this.extension = extension;
        this.tracker = extension.tabTracker;
        this.messaging = extension.messaging;
        this.sources = new Sources(extension);
        const root = extension.getURL('');
        this.declared = (extension.manifest.content_scripts || []).map(entry =>
            new ContentScript(this.sources, {
                matches: entry.matches,
                excludeMatches: entry.exclude_matches,
                includeGlobs: entry.include_globs,
                excludeGlobs: entry.exclude_globs,
                js: (entry.js || []).map(file => ({ file })),
                css: (entry.css || []).map(file => ({ file })),
                allFrames: entry.all_frames,
                matchAboutBlank: entry.match_about_blank,
                runAt: entry.run_at,
            }, root)
        );
        this.registered = new Set();
        this.pageScripts = new PageScripts();
        this.observer = {
            observe: (subject, topic) => { this.observe(subject, topic); },
        };
    }

    start() {
        for ( const topic of DOCUMENT_TOPICS ) {
            Services.obs.addObserver(this.observer, topic, false);
        }
    }

    stop() {
        for ( const topic of DOCUMENT_TOPICS ) {
            Services.obs.removeObserver(this.observer, topic);
        }
        this.registered.clear();
        this.pageScripts.stop();
    }

    observe(subject, topic) {
        try {
            switch ( topic ) {
            case 'document-element-inserted': {
                const win = subject.defaultView;
                if ( win !== null && win.document === subject ) {
                    this.onNewDocument(win, true);
                }
                break;
            }
            // Only an initial about:blank document has its elements already.
            case 'content-document-global-created': {
                const doc = subject.document;
                if ( doc !== null && doc.documentElement !== null ) {
                    this.onNewDocument(subject, false);
                }
                break;
            }
            // Just before DOMContentLoaded.
            case 'content-document-interactive': {
                const win = subject.defaultView;
                if ( win !== null && win.document === subject ) {
                    this.onNewDocument(win, false);
                }
                break;
            }
            default:
                break;
            }
        } catch (ex) {
            Cu.reportError(ex);
        }
    }

    /**************************************************************************/

    // Declared and registered scripts

    // A document gets them once. Its parser's notification starts it over
    // (see createContext()); the others catch documents which never get
    // that notification, and do nothing for those which already got their
    // scripts.
    onNewDocument(win, fromParser) {
        const urls = documentURLsOf(win.document);
        const isTop = win.top === win;
        const scripts = [];
        for ( const script of this.declared ) {
            if ( script.appliesTo(urls, isTop) ) { scripts.push(script); }
        }
        for ( const script of this.registered ) {
            if ( script.appliesTo(urls, isTop) ) { scripts.push(script); }
        }
        if ( scripts.length === 0 || this.isInTab(win) === false ) { return; }
        // An existing context without them was made by executeScript() & co.
        let context = fromParser ? null : this.existingContext(win);
        if ( context !== null && context.scriptsRun ) { return; }
        if ( context === null ) {
            context = this.createContext(win);
        }
        context.scriptsRun = true;
        for ( const script of scripts ) {
            this.runScript(context, script);
        }
    }

    // As in Firefox, only frames of tabs get content scripts.
    isInTab(win) {
        return this.tracker.tabForBrowser(this.tracker.browserForContentWindow(win)) !== null;
    }

    // Style sheets first, then scripts, in order; a script's error is
    // reported and does not stop the next one.
    runScript(context, script) {
        context.whenReached(script.runAt, ( ) => {
            for ( const source of script.css ) {
                if ( context.unloaded ) { return; }
                try {
                    context.addSheet(this.sources.sheetOf(source, AUTHOR_SHEET));
                } catch (ex) {
                    Cu.reportError(ex);
                }
            }
            for ( let i = 0; i < script.js.length; i++ ) {
                if ( context.unloaded ) { return; }
                try {
                    if ( script.world === 'MAIN' ) {
                        // Its file is gone if it was unregistered since.
                        const entry = script.pageFiles[i];
                        if ( entry.holders !== 0 ) {
                            context.evaluateInPage(entry.url);
                        }
                    } else {
                        const source = script.js[i];
                        context.evaluate(this.sources.textOf(source), source.url);
                    }
                } catch (ex) {
                    Cu.reportError(ex);
                }
            }
        });
    }

    /**************************************************************************/

    // Contexts

    // The content-script context of the window's current document, if any.
    existingContext(win) {
        const context = this.extension.contexts.get(windowUtilsOf(win).currentInnerWindowID);
        if ( context === undefined || context.isContentScript === false ) { return null; }
        return context.document === win.document ? context : null;
    }

    // A new context for the window's current document, replacing an older
    // one of the same window: the initial about:blank document's window is
    // reused by the first document loaded into it, and document.open()
    // starts a document over.
    createContext(win) {
        const innerWindowID = windowUtilsOf(win).currentInnerWindowID;
        this.extension.unloadContext(innerWindowID);
        const context = new ContentContext(this.extension, win);
        this.extension.contexts.set(innerWindowID, context);
        try {
            injectAPI(context, this.extension.buildAPI(context));
        } catch (ex) {
            this.extension.unloadContext(innerWindowID);
            throw ex;
        }
        return context;
    }

    contextFor(win) {
        return this.existingContext(win) || this.createContext(win);
    }

    /**************************************************************************/

    // tabs.executeScript(), insertCSS(), removeCSS()

    // May the extension's scripts run in the window's document?
    mayRunIn(win, matchAboutBlank) {
        const url = urlToMatch(documentURLsOf(win.document), matchAboutBlank);
        return url !== null && this.extension.hostPermissions.matchesURL(url);
    }

    // The top frame or details.frameId, plus with allFrames their
    // descendants the extension may access.
    targetsOf(tab, details) {
        const browser = tab.linkedBrowser;
        let root = browser.contentWindow;
        const { frameId } = details;
        if ( typeof frameId === 'number' && frameId !== 0 ) {
            root = Services.wm.getOuterWindowWithId(frameId);
            if (
                !root || root.top === root ||
                this.tracker.browserForContentWindow(root) !== browser
            ) {
                throw new ExtensionError(`Frame not found, or missing host permission (frame ${frameId})`);
            }
        }
        const matchAboutBlank = details.matchAboutBlank === true;
        if ( !root || this.mayRunIn(root, matchAboutBlank) === false ) {
            throw new ExtensionError(NO_HOST_PERMISSION);
        }
        const out = [ root ];
        if ( details.allFrames === true ) {
            const walk = win => {
                for ( let i = 0; i < win.frames.length; i++ ) {
                    const frame = win.frames[i];
                    if ( this.mayRunIn(frame, matchAboutBlank) ) { out.push(frame); }
                    walk(frame);
                }
            };
            walk(root);
        }
        return out;
    }

    // Resolves with fn(context) once the window's document reaches `runAt`.
    whenFrameReached(win, runAt, fn) {
        return new Promise((resolve, reject) => {
            const frame = this.contextFor(win);
            frame.whenReached(runAt, ( ) => {
                try {
                    resolve(fn(frame));
                } catch (ex) {
                    reject(ex);
                }
            }, ( ) => {
                reject(new ExtensionError('The frame was unloaded before the script could run'));
            });
        });
    }

    // The tab is resolved when the call is made, and the call then runs as
    // a task of its own: by then the tab may be gone.
    async tabInNextTask(context, tabId) {
        const id = this.tracker.getId(this.tracker.tabOrThrow(context, tabId).linkedBrowser);
        await nextTask();
        const tab = this.tracker.tabById(id);
        if ( tab === null ) {
            throw new ExtensionError(`Invalid tab ID: ${id}`);
        }
        return tab;
    }

    async executeScript(context, args) {
        const [ tabId, details ] = tabIdAndDetails(args);
        const source = this.sources.resolve(details, context.url);
        const runAt = checkRunAt(details.runAt);
        const text = this.sources.textOf(source);
        const tab = await this.tabInNextTask(context, tabId);
        return Promise.all(this.targetsOf(tab, details).map(win =>
            this.whenFrameReached(win, runAt, frame => {
                let value;
                try {
                    value = frame.evaluate(text, source.url);
                } catch (ex) {
                    Cu.reportError(ex);
                    throw new ExtensionError(ex && ex.message ? ex.message : String(ex));
                }
                return resultOf(frame, value);
            })
        ));
    }

    async insertCSS(context, args) {
        const [ tabId, details ] = tabIdAndDetails(args);
        const sheet = this.sources.sheetOf(
            this.sources.resolve(details, context.url),
            checkCSSOrigin(details.cssOrigin)
        );
        const runAt = checkRunAt(details.runAt);
        const tab = await this.tabInNextTask(context, tabId);
        await Promise.all(this.targetsOf(tab, details).map(win =>
            this.whenFrameReached(win, runAt, frame => { frame.addSheet(sheet); })
        ));
    }

    async removeCSS(context, args) {
        const [ tabId, details ] = tabIdAndDetails(args);
        const sheet = this.sources.sheetOf(
            this.sources.resolve(details, context.url),
            checkCSSOrigin(details.cssOrigin)
        );
        const tab = await this.tabInNextTask(context, tabId);
        for ( const win of this.targetsOf(tab, details) ) {
            const frame = this.existingContext(win);
            if ( frame !== null ) { frame.removeSheet(sheet); }
        }
    }

    /**************************************************************************/

    // tabs.sendMessage(), tabs.connect(): to the content scripts of a tab,
    // or of one of its frames, whose document is shown.

    inTab(tabId, frameId) {
        const tab = typeof tabId === 'number' ? this.tracker.tabById(tabId) : null;
        const browser = tab !== null ? tab.linkedBrowser : null;
        return other => browser !== null &&
            other.isContentScript &&
            other.isCurrent &&
            (frameId === undefined || other.frameId === frameId) &&
            this.tracker.browserForContentWindow(other.window) === browser;
    }

    sendMessage(context, tabId, message, options) {
        const { messaging } = this;
        const receivers = messaging.receiversOf(
            messaging.onMessage,
            context,
            this.inTab(tabId, frameIdOption(options))
        );
        return messaging.deliver(context, message, receivers);
    }

    connect(context, tabId, info) {
        const { messaging } = this;
        const options = info !== null && typeof info === 'object' ? info : {};
        const receivers = messaging.receiversOf(
            messaging.onConnect,
            context,
            this.inTab(tabId, frameIdOption(options))
        );
        return messaging.connectTo(context, options.name, receivers);
    }

    /**************************************************************************/

    // contentScripts.register(): as in Firefox, a registration lasts as long
    // as the page which made it.

    register(context, options) {
        if ( options === null || typeof options !== 'object' ) {
            throw new ExtensionError('Missing content script options');
        }
        const script = new ContentScript(this.sources, options, context.url);
        // Written now, so that pages need not wait for them.
        if ( script.world === 'MAIN' ) {
            script.pageFiles = script.js.map(source =>
                this.pageScripts.acquire(this.sources.textOf(source))
            );
        }
        this.registered.add(script);
        const unregister = ( ) => {
            if ( this.registered.delete(script) && script.pageFiles !== null ) {
                for ( const entry of script.pageFiles ) {
                    this.pageScripts.release(entry);
                }
            }
            context.forgetOnUnload(unregister);
        };
        context.callOnUnload(unregister);
        const handle = context.createObject();
        handle.unregister = context.exportFunction(( ) => {
            unregister();
            return context.pagePromise(undefined);
        }, handle);
        return new PageValue(handle);
    }
};

/******************************************************************************/

const createContentAPIs = function(extension) {
    const scripts = new ContentScripts(extension);
    scripts.start();
    extension.onShutdown(( ) => { scripts.stop(); });

    const tree = {
        tabs: {
            executeScript: apiAsync((context, ...args) => scripts.executeScript(context, args)),
            insertCSS: apiAsync((context, ...args) => scripts.insertCSS(context, args)),
            removeCSS: apiAsync((context, ...args) => scripts.removeCSS(context, args)),
            sendMessage: apiAsync((context, tabId, message, options) =>
                scripts.sendMessage(context, tabId, message, options)
            ),
            connect: apiSync((context, tabId, info) => scripts.connect(context, tabId, info)),
        },
        contentScripts: {
            register: apiAsync((context, options) => scripts.register(context, options)),
        },
    };

    return {
        build: ( ) => tree,
    };
};

/******************************************************************************/

return { createContentAPIs };

})();

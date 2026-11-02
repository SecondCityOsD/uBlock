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

// Extension contexts and the `browser` object injected into them.
//
// Same technique as Firefox's own WebExtensions runtime of the Gecko 52 era:
// page-side objects come from Cu.createObjectIn(), page-callable functions
// from Cu.exportFunction(), and every value crossing the boundary is
// structured-cloned with Cu.cloneInto(). The page only ever sees objects of
// its own global, so upstream's `instanceof Object/Function/Promise` checks
// hold, and nothing privileged leaks into the page.
//
// Loaded into Extension.jsm's global (see there).

/* global Cu, Ci */
/* exported Context, EventManager, ExtensionError, PageValue, apiSync,
            apiAsync, injectAPI */

'use strict';

var {
    Context,
    EventManager,
    ExtensionError,
    PageValue,
    apiSync,
    apiAsync,
    injectAPI,
} = (( ) => {

const chromeScope = {};
const KIND = Symbol('api kind');

// Errors whose message is meant for the extension page. Anything else is a
// bug of ours: reported to the console, page gets a generic error (as in
// Firefox).
const ExtensionError = class extends Error {};

// A value which already lives in the page and must not be cloned.
const PageValue = class {
    constructor(value) {
        this.value = value;
    }
};

// API members: functions get the calling context first, then the page's
// arguments cloned into chrome.
const apiSync = fn => ({ [KIND]: 'sync', fn });
const apiAsync = fn => ({ [KIND]: 'async', fn });

// As web origins are serialized: "null" for opaque ones.
const originOf = function(principal) {
    try {
        if ( principal.isNullPrincipal ) { return 'null'; }
        return principal.originNoSuffix;
    } catch (ex) {
    }
    return 'null';
};

/******************************************************************************/

// An extension page, or a content script (viewType 'content_script'). Its
// API objects live in `global`: the page itself, or the content script's
// sandbox.

const Context = class {
    constructor(extension, window, viewType, global = window) {
        this.extension = extension;
        this.window = window;
        this.waived = Cu.waiveXrays(global);
        this.viewType = viewType;
        this.isContentScript = viewType === 'content_script';
        const doc = window.document;
        this.url = doc.documentURI;
        this.origin = originOf(doc.nodePrincipal);
        const utils = window.QueryInterface(Ci.nsIInterfaceRequestor)
            .getInterface(Ci.nsIDOMWindowUtils);
        this.innerWindowID = utils.currentInnerWindowID;
        this.frameId = window.top === window ? 0 : utils.outerWindowID;
        this.unloaded = false;
        this.unloadCallbacks = new Set();
        // runtime.lastError, set while a callback runs.
        this.lastError = undefined;
        this.lastErrorChecked = true;
    }

    callOnUnload(callback) {
        this.unloadCallbacks.add(callback);
    }

    forgetOnUnload(callback) {
        this.unloadCallbacks.delete(callback);
    }

    unload() {
        if ( this.unloaded ) { return; }
        this.unloaded = true;
        for ( const callback of Array.from(this.unloadCallbacks) ) {
            try {
                callback();
            } catch (ex) {
                Cu.reportError(ex);
            }
        }
        this.unloadCallbacks.clear();
        this.window = this.waived = null;
    }

    /**************************************************************************/

    // chrome -> page
    cloneOut(value) {
        if ( value instanceof PageValue ) { return value.value; }
        if ( value === null || typeof value !== 'object' ) { return value; }
        return Cu.cloneInto(value, this.waived);
    }

    // page -> chrome. Page functions (listeners) are kept as they are.
    cloneIn(value) {
        if ( value === null || typeof value !== 'object' ) { return value; }
        return Cu.cloneInto(Cu.waiveXrays(value), chromeScope);
    }

    createObject() {
        return Cu.waiveXrays(Cu.createObjectIn(this.waived));
    }

    exportFunction(fn, target = this.waived) {
        return Cu.exportFunction(fn, target);
    }

    pageError(reason) {
        let message = 'An unexpected error occurred';
        if ( reason instanceof ExtensionError ) {
            message = reason.message;
        } else {
            Cu.reportError(reason);
        }
        return new this.waived.Error(message);
    }

    // A page Promise settled by a chrome Promise (or value).
    pagePromise(result) {
        const settlers = {};
        const promise = new this.waived.Promise(this.exportFunction((resolve, reject) => {
            settlers.resolve = resolve;
            settlers.reject = reject;
        }));
        Promise.resolve(result).then(value => {
            if ( this.unloaded ) { return; }
            try {
                settlers.resolve(this.cloneOut(value));
            } catch (ex) {
                settlers.reject(this.pageError(ex));
            }
        }, reason => {
            if ( this.unloaded ) { return; }
            settlers.reject(this.pageError(reason));
        });
        return promise;
    }

    // Chrome's callback form, which Firefox accepts too: the callback gets
    // the result, or no argument with runtime.lastError set while it runs.
    settleCallback(result, callback) {
        Promise.resolve(result).then(value => {
            if ( this.unloaded ) { return; }
            let pageValue;
            try {
                pageValue = this.cloneOut(value);
            } catch (ex) {
                this.callWithLastError(callback, ex);
                return;
            }
            this.callPage(callback, [ pageValue ]);
        }, reason => {
            if ( this.unloaded ) { return; }
            this.callWithLastError(callback, reason);
        });
    }

    callWithLastError(callback, reason) {
        const error = this.pageError(reason);
        this.lastError = error;
        this.lastErrorChecked = false;
        this.callPage(callback, []);
        this.lastError = undefined;
        if ( this.lastErrorChecked === false ) {
            Cu.reportError(`Unchecked runtime.lastError: ${error.message}`);
        }
        this.lastErrorChecked = true;
    }

    // Call a page function; its exceptions are reported, not propagated.
    callPage(fn, args) {
        try {
            return fn(...args);
        } catch (ex) {
            Cu.reportError(ex);
        }
    }

    // A page value which may be a thenable, as a chrome Promise of a chrome
    // value.
    awaitPage(value) {
        const waived = Cu.waiveXrays(value);
        if ( waived === null || typeof waived !== 'object' || typeof waived.then !== 'function' ) {
            return Promise.resolve(this.cloneIn(value));
        }
        return new Promise((resolve, reject) => {
            waived.then(
                this.exportFunction(v => { resolve(this.cloneIn(v)); }),
                this.exportFunction(e => {
                    reject(new ExtensionError(e && e.message || String(e)));
                })
            );
        });
    }
};

/******************************************************************************/

// One manager per API event; listeners are kept per context and dropped when
// their context unloads.

const EventManager = class {
    constructor(name, { onFirstListener, onLastListener } = {}) {
        this.name = name;
        this.contexts = new Map();
        this.count = 0;
        this.onFirstListener = onFirstListener;
        this.onLastListener = onLastListener;
    }

    get hasListeners() {
        return this.count !== 0;
    }

    addListener(context, fn, extra) {
        if ( typeof fn !== 'function' ) {
            throw new ExtensionError(`${this.name}.addListener: listener must be a function`);
        }
        let listeners = this.contexts.get(context);
        if ( listeners === undefined ) {
            listeners = new Map();
            listeners.unload = ( ) => { this.removeContext(context); };
            this.contexts.set(context, listeners);
            context.callOnUnload(listeners.unload);
        }
        if ( listeners.has(fn) ) { return; }
        listeners.set(fn, extra);
        this.count += 1;
        if ( this.count === 1 && this.onFirstListener ) {
            this.onFirstListener();
        }
    }

    removeListener(context, fn) {
        const listeners = this.contexts.get(context);
        if ( listeners === undefined || listeners.has(fn) === false ) { return; }
        listeners.delete(fn);
        if ( listeners.size === 0 ) {
            this.contexts.delete(context);
            context.forgetOnUnload(listeners.unload);
        }
        this.removed(1);
    }

    hasListener(context, fn) {
        const listeners = this.contexts.get(context);
        return listeners !== undefined && listeners.has(fn);
    }

    removeContext(context) {
        const listeners = this.contexts.get(context);
        if ( listeners === undefined ) { return; }
        this.contexts.delete(context);
        this.removed(listeners.size);
    }

    removed(n) {
        this.count -= n;
        if ( this.count === 0 && this.onLastListener ) {
            this.onLastListener();
        }
    }

    // [ { context, fn, extra } ], a snapshot: listeners may change during
    // dispatch.
    listeners(onlyContext = null) {
        const out = [];
        for ( const [ context, listeners ] of this.contexts ) {
            if ( onlyContext !== null && context !== onlyContext ) { continue; }
            for ( const [ fn, extra ] of listeners ) {
                out.push({ context, fn, extra });
            }
        }
        return out;
    }

    // Call every listener with chrome values cloned into its page.
    fire(...args) {
        return this.fireWith(context => args.map(a => context.cloneOut(a)));
    }

    // Call listeners with page arguments made per context by `argsFor`.
    // Returns [ { context, value } ] with each listener's page return value.
    fireWith(argsFor, onlyContext = null) {
        const results = [];
        const pageArgs = new Map();
        for ( const { context, fn } of this.listeners(onlyContext) ) {
            if ( context.unloaded || this.hasListener(context, fn) === false ) { continue; }
            let args = pageArgs.get(context);
            if ( args === undefined ) {
                try {
                    args = argsFor(context);
                } catch (ex) {
                    Cu.reportError(ex);
                    continue;
                }
                pageArgs.set(context, args);
            }
            results.push({ context, value: context.callPage(fn, args) });
        }
        return results;
    }
};

/******************************************************************************/

const makeFunction = function(context, member) {
    const { fn } = member;
    if ( member[KIND] === 'sync' ) {
        return (...args) => {
            if ( context.unloaded ) { return; }
            try {
                return context.cloneOut(fn(context, ...args.map(a => context.cloneIn(a))));
            } catch (ex) {
                throw context.pageError(ex);
            }
        };
    }
    return (...args) => {
        if ( context.unloaded ) { return; }
        const callback = typeof args[args.length - 1] === 'function'
            ? args.pop()
            : null;
        let result;
        try {
            result = fn(context, ...args.map(a => context.cloneIn(a)));
        } catch (ex) {
            result = Promise.reject(ex);
        }
        if ( callback === null ) {
            return context.pagePromise(result);
        }
        context.settleCallback(result, callback);
    };
};

const makeEvent = function(context, manager) {
    const target = context.createObject();
    target.addListener = context.exportFunction((fn, ...extra) => {
        try {
            manager.addListener(context, fn, extra.map(a => context.cloneIn(a)));
        } catch (ex) {
            throw context.pageError(ex);
        }
    }, target);
    target.removeListener = context.exportFunction(fn => {
        manager.removeListener(context, fn);
    }, target);
    target.hasListener = context.exportFunction(fn =>
        manager.hasListener(context, fn), target
    );
    return target;
};

const makeObject = function(context, tree) {
    const target = context.createObject();
    for ( const [ name, member ] of Object.entries(tree) ) {
        if ( member instanceof EventManager ) {
            target[name] = makeEvent(context, member);
        } else if ( member !== null && typeof member === 'object' && member[KIND] !== undefined ) {
            target[name] = context.exportFunction(makeFunction(context, member), target);
        } else if ( member instanceof PageValue ) {
            target[name] = member.value;
        } else if ( member !== null && typeof member === 'object' && Array.isArray(member) === false ) {
            target[name] = makeObject(context, member);
        } else {
            target[name] = context.cloneOut(member);
        }
    }
    return target;
};

// Built-ins which the Firefox version UXP reports itself as (128-140) has
// and upstream relies on, implemented with what UXP has. Built from page
// objects only.
const installPolyfills = function(context) {
    const page = context.waived;
    const wasm = page.WebAssembly;
    if ( wasm === undefined ) { return; }
    const arrayBufferOf = source => page.Promise.resolve(source).then(
        context.exportFunction(response => Cu.waiveXrays(response).arrayBuffer())
    );
    // start.js: fetch(...).then(WebAssembly.compileStreaming)
    if ( typeof wasm.compileStreaming !== 'function' ) {
        wasm.compileStreaming = context.exportFunction(source =>
            arrayBufferOf(source).then(
                context.exportFunction(buffer => wasm.compile(buffer))
            ), wasm
        );
    }
    // lib/lz4
    if ( typeof wasm.instantiateStreaming !== 'function' ) {
        wasm.instantiateStreaming = context.exportFunction((source, imports) =>
            arrayBufferOf(source).then(
                context.exportFunction(buffer => wasm.instantiate(buffer, imports))
            ), wasm
        );
    }
};

// Define `browser` (and its `chrome` alias, as Firefox does) in the page.
const injectAPI = function(context, tree) {
    const api = makeObject(context, tree);
    if ( api.runtime !== undefined ) {
        Object.defineProperty(api.runtime, 'lastError', {
            get: context.exportFunction(( ) => {
                context.lastErrorChecked = true;
                return context.lastError;
            }),
            enumerable: true,
            configurable: true,
        });
    }
    for ( const name of [ 'browser', 'chrome' ] ) {
        Object.defineProperty(context.waived, name, {
            value: api,
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    if ( context.isContentScript === false ) {
        installPolyfills(context);
    }
};

/******************************************************************************/

return {
    Context,
    EventManager,
    ExtensionError,
    PageValue,
    apiSync,
    apiAsync,
    injectAPI,
};

})();

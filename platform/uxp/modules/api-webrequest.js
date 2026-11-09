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

// browser.webRequest on HTTP channel observers, the way Firefox implemented
// it on the same platform (UXP still ships that WebRequest.jsm):
//   http-on-modify-request   onBeforeRequest, onBeforeSendHeaders,
//                            onSendHeaders
//   http-on-examine-*        onHeadersReceived, onBeforeRedirect
//   channel listener         onResponseStarted, onCompleted, onErrorOccurred
// Blocking listeners may return a Promise: the channel is suspended until it
// settles. The request ID lives in the channel's property bag, which Gecko
// copies to the new channel on redirect, so it survives redirects as in
// Firefox. Requests made by the browser itself are not exposed (as in
// Firefox). filterResponseData() gives the response body to the extension
// (see StreamFilter). Loads of the extension's own web-accessible resources
// by web pages get onBeforeRequest from Extension.jsm's content policy (see
// onResourceLoad()).
//
// Priming: from every (re)start of the background page until uBO adds its
// first onBeforeRequest listener, requests are suspended, then run through
// the listeners -- Firefox does the same with persistent listeners at
// browser launch, which is how uBO blocks from the very first request.
//
// Loaded into Extension.jsm's global (see there).

/* global Cc, Ci, Cr, Cu, Services, URL, XPCOMUtils, setTimeout,
          clearTimeout, dispatch, MatchPattern, outerWindowIdOf, errorNameOf,
          EventManager, ExtensionError, PageValue, apiSync, apiAsync */
/* exported createWebRequestAPIs */

'use strict';

var { createWebRequestAPIs } = (( ) => {

const REQUEST_ID_KEY = 'uBlock0-uxp.requestId';
const PRIMING_TIMEOUT_MS = 60000;
const MODIFY_TOPIC = 'http-on-modify-request';
const EXAMINE_TOPICS = [
    'http-on-examine-response',
    'http-on-examine-cached-response',
    'http-on-examine-merged-response',
];
const REDIRECT_STATUSES = new Set([ 301, 302, 303, 307, 308 ]);
const EVENT_NAMES = [
    'onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders',
    'onHeadersReceived', 'onAuthRequired', 'onResponseStarted',
    'onBeforeRedirect', 'onCompleted', 'onErrorOccurred',
];

const RESOURCE_TYPES = {
    BEACON: 'beacon', CSP_REPORT: 'csp_report', FONT: 'font', IMAGE: 'image',
    IMAGESET: 'imageset', MAIN_FRAME: 'main_frame', MEDIA: 'media',
    OBJECT: 'object', OBJECT_SUBREQUEST: 'object_subrequest', OTHER: 'other',
    PING: 'ping', SCRIPT: 'script', SPECULATIVE: 'speculative',
    STYLESHEET: 'stylesheet', SUB_FRAME: 'sub_frame',
    WEB_MANIFEST: 'web_manifest', WEBSOCKET: 'websocket', XML_DTD: 'xml_dtd',
    XMLHTTPREQUEST: 'xmlhttprequest', XSLT: 'xslt',
};

// nsIContentPolicy type -> webRequest type, Firefox's mapping.
const typeOfPolicy = (( ) => {
    const map = new Map();
    for ( const [ name, type ] of [
        [ 'TYPE_DOCUMENT', 'main_frame' ], [ 'TYPE_SUBDOCUMENT', 'sub_frame' ],
        [ 'TYPE_STYLESHEET', 'stylesheet' ], [ 'TYPE_SCRIPT', 'script' ],
        [ 'TYPE_IMAGE', 'image' ], [ 'TYPE_IMAGESET', 'imageset' ],
        [ 'TYPE_OBJECT', 'object' ], [ 'TYPE_OBJECT_SUBREQUEST', 'object_subrequest' ],
        [ 'TYPE_XMLHTTPREQUEST', 'xmlhttprequest' ], [ 'TYPE_FETCH', 'xmlhttprequest' ],
        [ 'TYPE_XBL', 'xbl' ], [ 'TYPE_XSLT', 'xslt' ], [ 'TYPE_PING', 'ping' ],
        [ 'TYPE_BEACON', 'beacon' ], [ 'TYPE_DTD', 'xml_dtd' ], [ 'TYPE_FONT', 'font' ],
        [ 'TYPE_MEDIA', 'media' ], [ 'TYPE_WEBSOCKET', 'websocket' ],
        [ 'TYPE_CSP_REPORT', 'csp_report' ], [ 'TYPE_WEB_MANIFEST', 'web_manifest' ],
    ] ) {
        if ( Ci.nsIContentPolicy[name] !== undefined ) {
            map.set(Ci.nsIContentPolicy[name], type);
        }
    }
    return policyType => map.get(policyType) || 'other';
})();

/******************************************************************************/

let nextRequestId = 1;

const requestIdOf = function(channel) {
    try {
        const bag = channel.QueryInterface(Ci.nsIWritablePropertyBag2);
        if ( bag.hasKey(REQUEST_ID_KEY) ) {
            return bag.getPropertyAsAString(REQUEST_ID_KEY);
        }
        const id = String(nextRequestId++);
        bag.setPropertyAsAString(REQUEST_ID_KEY, id);
        return id;
    } catch {
    }
    return String(nextRequestId++);
};

const loadContextOf = function(channel) {
    for ( const callbacks of [
        ( ) => channel.notificationCallbacks,
        ( ) => channel.loadGroup && channel.loadGroup.notificationCallbacks,
    ] ) {
        try {
            const loadContext = callbacks().getInterface(Ci.nsILoadContext);
            if ( loadContext ) { return loadContext; }
        } catch {
        }
    }
    return null;
};

const headersOf = function(channel, visitMethod) {
    const out = [];
    try {
        channel[visitMethod]({
            visitHeader(name, value) { out.push({ name, value }); },
        });
    } catch {
    }
    return out;
};

// Firefox semantics: the listener's list replaces the original headers.
const replaceHeaders = function(channel, headers, isResponse) {
    const set = (name, value, merge) => {
        try {
            if ( isResponse ) {
                channel.setResponseHeader(name, value, merge);
            } else {
                channel.setRequestHeader(name, value, merge);
            }
        } catch {
        }
    };
    const group = list => {
        const out = new Map();
        for ( const header of list ) {
            if ( typeof header.name !== 'string' ) { continue; }
            const key = header.name.toLowerCase();
            if ( out.has(key) === false ) {
                out.set(key, { name: header.name, values: [] });
            }
            out.get(key).values.push(typeof header.value === 'string' ? header.value : '');
        }
        return out;
    };
    const before = group(headersOf(channel, isResponse ? 'visitResponseHeaders' : 'visitRequestHeaders'));
    const after = group(headers);
    for ( const [ key, { name } ] of before ) {
        if ( after.has(key) === false ) { set(name, '', false); }
    }
    for ( const [ key, { name, values } ] of after ) {
        const old = before.has(key) ? before.get(key).values : [];
        if ( old.length === values.length && old.every((v, i) => v === values[i]) ) { continue; }
        values.forEach((value, i) => { set(name, value, i !== 0); });
    }
};

const proxyInfoOf = function(channel) {
    let info = null;
    try {
        info = channel.QueryInterface(Ci.nsIProxiedChannel).proxyInfo;
    } catch {
    }
    if ( !info || info.type === 'direct' ) { return null; }
    return {
        host: info.host,
        port: info.port,
        type: info.type,
        proxyDNS: (info.flags & Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST) !== 0,
        failoverTimeout: info.failoverTimeout,
    };
};

const responseDetailsOf = function(channel) {
    const out = { statusCode: 0, statusLine: '', fromCache: false };
    try {
        out.statusCode = channel.responseStatus;
        const major = {}, minor = {};
        channel.QueryInterface(Ci.nsIHttpChannelInternal).getResponseVersion(major, minor);
        out.statusLine = `HTTP/${major.value}.${minor.value} ${channel.responseStatus} ${channel.responseStatusText}`;
    } catch {
    }
    try {
        out.fromCache = channel.QueryInterface(Ci.nsICacheInfoChannel).isFromCache();
    } catch {
    }
    try {
        out.ip = channel.QueryInterface(Ci.nsIHttpChannelInternal).remoteAddress;
    } catch {
    }
    return out;
};

const compileSpec = function(args) {
    const filter = args[0] !== null && typeof args[0] === 'object' ? args[0] : {};
    const extraInfo = Array.isArray(args[1]) ? args[1] : [];
    const urls = Array.isArray(filter.urls) ? new MatchPattern(filter.urls) : null;
    const types = Array.isArray(filter.types) ? new Set(filter.types) : null;
    return {
        blocking: extraInfo.includes('blocking'),
        requestHeaders: extraInfo.includes('requestHeaders'),
        responseHeaders: extraInfo.includes('responseHeaders'),
        matches(details, url) {
            if ( types !== null && types.has(details.type) === false ) { return false; }
            if ( urls !== null && urls.matchesURL(url) === false ) { return false; }
            if ( filter.tabId !== undefined && details.tabId !== filter.tabId ) { return false; }
            if ( filter.windowId !== undefined && details.windowId !== filter.windowId ) { return false; }
            return true;
        },
    };
};

/******************************************************************************/

// Wraps a channel's stream listener to see the response start and the end
// of the request, whatever the outcome. Installed at request time, so it
// also sees failures and requests the extension cancelled; once the response
// starts, a stream filter can no longer be attached. After a redirect the
// wrapper moves to the new channel with the rest of the listener chain: it
// only reports for its own channel. A request can outlive the extension
// (a long download): once webRequest has stopped -- and bootstrap.js may
// have unloaded this module, globals included -- the wrapper only passes
// everything on.

const TracingListener = class {
    constructor(service, request) {
        this.service = service;
        this.request = request;
        this.original = null;
    }

    reports(channel) {
        return channel === this.request.channel && this.service.stopped === false;
    }

    onStartRequest(channel, ...rest) {
        if ( this.reports(channel) ) {
            this.service.onResponseStarted(this.request);
        }
        this.original.onStartRequest(channel, ...rest);
    }

    onDataAvailable(...args) {
        this.original.onDataAvailable(...args);
    }

    onStopRequest(channel, ...rest) {
        try {
            this.original.onStopRequest(channel, ...rest);
        } finally {
            if ( this.reports(channel) ) {
                this.service.onRequestStopped(this.request, rest[rest.length - 1]);
            }
        }
    }
};
TracingListener.prototype.QueryInterface = XPCOMUtils.generateQI([
    Ci.nsIStreamListener,
    Ci.nsIRequestObserver,
]);

/******************************************************************************/

// webRequest.filterResponseData(): Firefox's StreamFilter, attached the way
// Firefox attaches it (StreamFilterParent): through nsITraceableChannel, as
// the channel's first stream listener, any time before the response starts.
// It gets the body after content decoding; the rest of the listener chain
// gets what the extension writes, and the end of the response once the
// extension closes or disconnects the filter. As in Firefox, a redirected
// channel's filter fails and its response passes through unfiltered, and
// the response goes on unfiltered when the extension page goes away; then,
// beyond Firefox, what the filter gave the extension goes on first, if the
// extension had written nothing yet (onUnload).
//
// Events fire from the channel's own callbacks rather than from a later
// task: uBO writes and closes from its onstop handler, so a document gets
// the end of its data in the same callback in which the channel ends.
//
// Once the extension page has gone, a filter only passes everything on,
// without this module's globals (see TracingListener).

const NS_OK = Cr.NS_OK;
const FILTER_OPEN = new Set([
    'uninitialized', 'transferringdata', 'finishedtransferringdata', 'suspended',
]);
const FILTER_WRITABLE = new Set([
    'transferringdata', 'finishedtransferringdata', 'suspended',
]);

const bytesOfStream = function(stream, count) {
    const binary = Cc['@mozilla.org/binaryinputstream;1']
        .createInstance(Ci.nsIBinaryInputStream);
    binary.setInputStream(stream);
    const buffer = new ArrayBuffer(count);
    binary.readArrayBuffer(count, buffer);
    return buffer;
};

const StreamFilter = class {
    constructor(context, request) {
        this.context = context;
        this.channel = request !== null ? request.channel : null;
        this.status = 'uninitialized';
        this.error = '';
        this.next = null;           // the rest of the channel's listener chain
        this.request = null;        // as the channel's callbacks pass it
        this.callbackArgs = [];     // and their context argument (Gecko 52)
        this.offset = 0;            // bytes given to the chain so far
        this.started = false;
        this.stopped = false;
        this.passThrough = false;   // data goes on as it comes
        this.heldStop = null;       // the channel's end, until the extension is done
        this.suspended = false;
        // What the extension was given while it has written nothing. Should
        // its page go away then, that goes on first, so that the page loads
        // whole: uBO's HTML filtering takes a whole document before writing.
        this.unwritten = [];
        this.written = false;
        this.onUnload = ( ) => {
            if ( FILTER_OPEN.has(this.status) === false ) { return; }
            for ( const data of this.unwritten ) {
                const stream = Cc['@mozilla.org/io/arraybuffer-input-stream;1']
                    .createInstance(Ci.nsIArrayBufferInputStream);
                stream.setData(data, 0, data.byteLength);
                this.forward(stream, data.byteLength);
            }
            this.letThrough('disconnected', '');
        };
        context.callOnUnload(this.onUnload);
        this.page = this.makePageObject();
    }

    makePageObject() {
        const { context } = this;
        const filter = context.createObject();
        const method = (name, fn) => {
            filter[name] = context.exportFunction((...args) => {
                try {
                    return fn(...args);
                } catch (ex) {
                    throw context.pageError(ex);
                }
            }, filter);
        };
        method('write', data => { this.write(data); });
        method('close', ( ) => { this.close(); });
        method('disconnect', ( ) => { this.disconnect(); });
        method('suspend', ( ) => { this.suspend(); });
        method('resume', ( ) => { this.resume(); });
        for ( const name of [ 'status', 'error' ] ) {
            Object.defineProperty(filter, name, {
                get: context.exportFunction(( ) => this[name], filter),
                enumerable: true,
                configurable: true,
            });
        }
        for ( const name of [ 'onstart', 'ondata', 'onstop', 'onerror' ] ) {
            filter[name] = null;
        }
        return filter;
    }

    attach() {
        if ( this.channel === null ) { return false; }
        try {
            this.next = this.channel
                .QueryInterface(Ci.nsITraceableChannel)
                .setNewListener(this);
            return true;
        } catch {
        }
        return false;
    }

    fire(type, fields = {}) {
        if ( this.context.unloaded ) { return; }
        const handler = this.page[`on${type}`];
        if ( typeof handler !== 'function' ) { return; }
        try {
            handler.call(this.page, this.context.cloneOut(Object.assign({ type }, fields)));
        } catch (ex) {
            Cu.reportError(ex);
        }
    }

    forward(stream, count) {
        const offset = this.offset;
        this.offset += count;
        this.next.onDataAvailable(this.request, ...this.callbackArgs, stream, offset, count);
    }

    stopChain(status) {
        if ( this.started === false || this.stopped ) { return; }
        this.stopped = true;
        this.heldStop = null;
        this.next.onStopRequest(this.request, ...this.callbackArgs, status);
    }

    resumeChannel() {
        if ( this.suspended === false ) { return; }
        this.suspended = false;
        try {
            this.channel.resume();
        } catch {
        }
    }

    // No more filtering: the rest of the response goes on as it comes.
    letThrough(status, error) {
        this.status = status;
        this.error = error;
        this.unwritten = [];
        this.passThrough = true;
        this.resumeChannel();
        if ( this.heldStop !== null ) { this.stopChain(this.heldStop); }
        this.context.forgetOnUnload(this.onUnload);
    }

    fail(error) {
        this.letThrough('failed', error);
        this.fire('error');
    }

    // The extension's side

    write(data) {
        if ( FILTER_WRITABLE.has(this.status) === false ) {
            throw new ExtensionError(`StreamFilter.write: invalid state (${this.status})`);
        }
        let bytes = this.context.cloneIn(data);
        if ( bytes instanceof ArrayBuffer ) { bytes = new Uint8Array(bytes); }
        if ( bytes instanceof Uint8Array === false ) {
            throw new ExtensionError('StreamFilter.write: data must be an ArrayBuffer or a Uint8Array');
        }
        this.written = true;
        this.unwritten = [];
        if ( bytes.byteLength === 0 ) { return; }
        const stream = Cc['@mozilla.org/io/arraybuffer-input-stream;1']
            .createInstance(Ci.nsIArrayBufferInputStream);
        stream.setData(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.forward(stream, bytes.byteLength);
    }

    // The rest of the response is dropped; the chain ends with what was
    // written (once the response starts, if it has not yet).
    close() {
        if ( FILTER_OPEN.has(this.status) === false ) {
            throw new ExtensionError(`StreamFilter.close: invalid state (${this.status})`);
        }
        this.status = 'closed';
        this.unwritten = [];
        this.resumeChannel();
        this.stopChain(NS_OK);
        this.context.forgetOnUnload(this.onUnload);
    }

    disconnect() {
        if ( FILTER_OPEN.has(this.status) === false ) {
            throw new ExtensionError(`StreamFilter.disconnect: invalid state (${this.status})`);
        }
        this.letThrough('disconnected', '');
    }

    suspend() {
        if ( this.status !== 'transferringdata' ) {
            throw new ExtensionError(`StreamFilter.suspend: invalid state (${this.status})`);
        }
        this.channel.suspend();
        this.suspended = true;
        this.status = 'suspended';
    }

    resume() {
        if ( this.status !== 'suspended' ) {
            throw new ExtensionError(`StreamFilter.resume: invalid state (${this.status})`);
        }
        this.resumeChannel();
        this.status = 'transferringdata';
    }

    // The channel's side (nsIStreamListener)

    onStartRequest(request, ...args) {
        this.request = request;
        this.callbackArgs = args;
        this.started = true;
        this.next.onStartRequest(request, ...args);
        if ( this.status === 'closed' ) {
            this.stopChain(NS_OK);
            return;
        }
        if ( this.passThrough ) { return; }
        if ( request !== this.channel ) {
            this.fail('Channel redirected');
            return;
        }
        this.status = 'transferringdata';
        this.fire('start');
    }

    onDataAvailable(request, ...args) {
        const [ stream, , count ] = args.slice(-3);
        if ( this.passThrough ) {
            this.forward(stream, count);
            return;
        }
        // Read even when dropped: a listener consumes what it is given.
        const data = bytesOfStream(stream, count);
        if ( this.status === 'closed' ) { return; }
        if ( this.written === false ) { this.unwritten.push(data); }
        this.fire('data', { data });
    }

    onStopRequest(request, ...args) {
        if ( this.stopped ) { return; }
        const status = args[args.length - 1];
        if ( this.passThrough || this.status === 'closed' ) {
            this.stopChain(status);
            return;
        }
        this.heldStop = status;
        if ( Components.isSuccessCode(status) === false ) {
            this.fail(errorNameOf(status));
            return;
        }
        this.status = 'finishedtransferringdata';
        this.fire('stop');
    }
};
StreamFilter.prototype.QueryInterface = XPCOMUtils.generateQI([
    Ci.nsIStreamListener,
    Ci.nsIRequestObserver,
]);

/******************************************************************************/

const WebRequestService = class {
    constructor(extension) {
        this.extension = extension;
        this.tracker = extension.tabTracker;
        this.specs = new WeakMap();
        this.stopped = false;
        this.priming = false;
        this.primed = [];
        this.primingTimer = null;
        // Requests a stream filter can still be attached to, by request ID:
        // until their response starts.
        this.live = new Map();
        // What lets go of each request held for a blocking listener's
        // Promise: stop() does, the extension's answer won't come.
        this.held = new Set();
        this.events = {};
        for ( const name of EVENT_NAMES ) {
            this.events[name] = new EventManager(`webRequest.${name}`, name === 'onBeforeRequest'
                ? { onFirstListener: ( ) => { dispatch(( ) => { this.endPriming(); }); } }
                : {}
            );
        }
        Services.obs.addObserver(this, MODIFY_TOPIC, false);
        for ( const topic of EXAMINE_TOPICS ) {
            Services.obs.addObserver(this, topic, false);
        }
    }

    // The requests held for the extension's answer go on without it, as in
    // Firefox when an extension goes away. What their listeners' Promises
    // do later is ignored: this.stopped, the only state they read first.
    stop() {
        this.stopped = true;
        Services.obs.removeObserver(this, MODIFY_TOPIC);
        for ( const topic of EXAMINE_TOPICS ) {
            Services.obs.removeObserver(this, topic);
        }
        this.endPriming();
        for ( const release of Array.from(this.held) ) {
            release();
        }
        this.live.clear();
    }

    startPriming() {
        this.priming = true;
        clearTimeout(this.primingTimer);
        this.primingTimer = setTimeout(( ) => { this.endPriming(); }, PRIMING_TIMEOUT_MS);
    }

    endPriming() {
        if ( this.priming === false ) { return; }
        this.priming = false;
        clearTimeout(this.primingTimer);
        this.primingTimer = null;
        const requests = this.primed;
        this.primed = [];
        for ( const request of requests ) {
            try {
                this.traceRequest(request);
                this.runRequestPhases(request, true);
            } catch (ex) {
                Cu.reportError(ex);
                try { request.channel.resume(); } catch { }
            }
        }
    }

    observe(subject, topic) {
        let channel;
        try {
            channel = subject.QueryInterface(Ci.nsIHttpChannel);
        } catch {
            return;
        }
        try {
            if ( topic === MODIFY_TOPIC ) {
                this.onModifyRequest(channel);
            } else {
                this.onExamineResponse(channel);
            }
        } catch (ex) {
            Cu.reportError(ex);
        }
    }

    /**************************************************************************/

    // A request exposed to listeners, or null for requests the browser
    // itself makes (system principal), which are never exposed.
    requestOf(channel) {
        const loadInfo = channel.loadInfo;
        if ( !loadInfo ) { return null; }
        const browser = this.browserOf(channel, loadInfo);
        const isTopLevel = !loadInfo.loadingPrincipal && browser !== null;
        if ( isTopLevel === false ) {
            const principal = loadInfo.loadingPrincipal ||
                loadInfo.principalToInherit ||
                loadInfo.triggeringPrincipal;
            if ( !principal || Services.scriptSecurityManager.isSystemPrincipal(principal) ) {
                return null;
            }
        }
        return { channel, loadInfo, browser, details: null };
    }

    browserOf(channel, loadInfo) {
        const loadContext = loadContextOf(channel);
        try {
            if ( loadContext && loadContext.topFrameElement ) {
                return loadContext.topFrameElement;
            }
        } catch {
        }
        const windowId = loadInfo.frameOuterWindowID || loadInfo.outerWindowID;
        if ( windowId ) {
            const win = Services.wm.getOuterWindowWithId(windowId);
            if ( win ) { return this.tracker.browserForContentWindow(win); }
        }
        return null;
    }

    baseDetails(request) {
        if ( request.details !== null ) { return request.details; }
        const { channel, loadInfo, browser } = request;
        const type = typeOfPolicy(loadInfo.externalContentPolicyType);
        let url = channel.URI.spec;
        if ( type === 'websocket' ) {
            url = url.replace(/^http(s?):/, 'ws$1:');
        }
        let windowId = loadInfo.outerWindowID;
        let parentWindowId = loadInfo.parentOuterWindowID;
        if ( loadInfo.frameOuterWindowID ) {
            windowId = loadInfo.frameOuterWindowID;
            parentWindowId = loadInfo.outerWindowID;
        }
        let documentUrl;
        if ( type !== 'main_frame' ) {
            try {
                const doc = loadInfo.loadingDocument;
                if ( doc ) { documentUrl = doc.documentURI; }
            } catch {
            }
            if ( documentUrl === undefined && loadInfo.loadingPrincipal && loadInfo.loadingPrincipal.URI ) {
                documentUrl = loadInfo.loadingPrincipal.URI.spec;
            }
        }
        const triggering = loadInfo.triggeringPrincipal;
        let incognito = false;
        try {
            incognito = loadInfo.originAttributes.privateBrowsingId > 0;
        } catch {
        }
        request.details = Object.assign({
            requestId: requestIdOf(channel),
            url,
            method: channel.requestMethod,
            type,
        }, this.tabDetails(browser, type, windowId, parentWindowId), {
            originUrl: triggering && triggering.URI ? triggering.URI.spec : undefined,
            documentUrl,
            incognito,
            cookieStoreId: 'firefox-default',
            proxyInfo: proxyInfoOf(channel),
        });
        return request.details;
    }

    // Firefox's tab, window and frame IDs: frame 0 is the tab's top-level
    // window, other frames go by their outer window ID.
    tabDetails(browser, type, windowId, parentWindowId) {
        const tab = browser !== null ? this.tracker.tabForBrowser(browser) : null;
        if ( tab === null ) {
            return { tabId: -1, windowId: -1, frameId: 0, parentFrameId: -1 };
        }
        let frameId = 0;
        let parentFrameId = -1;
        if ( type !== 'main_frame' ) {
            let topWindowId = 0;
            try {
                topWindowId = outerWindowIdOf(browser.contentWindow);
            } catch {
            }
            if ( windowId !== 0 && windowId !== topWindowId ) {
                frameId = windowId;
                parentFrameId = parentWindowId === topWindowId ? 0 : parentWindowId;
            }
        }
        return {
            tabId: this.tracker.getId(browser),
            windowId: this.tracker.windowIdOf(tab.ownerGlobal),
            frameId,
            parentFrameId,
        };
    }

    specOf(args) {
        let spec = this.specs.get(args);
        if ( spec === undefined ) {
            spec = compileSpec(args);
            this.specs.set(args, spec);
        }
        return spec;
    }

    // Calls the event's matching listeners; returns the page values that
    // blocking listeners returned.
    dispatch(name, request, extra = null) {
        const manager = this.events[name];
        if ( manager.hasListeners === false ) { return []; }
        const results = [];
        let base = null;
        let url = null;
        for ( const { context, fn, extra: args } of manager.listeners() ) {
            if ( context.unloaded ) { continue; }
            if ( base === null ) {
                base = Object.assign({}, this.baseDetails(request), extra, { timeStamp: Date.now() });
                url = new URL(base.url);
            }
            const spec = this.specOf(args);
            if ( spec.matches(base, url) === false ) { continue; }
            const details = Object.assign({}, base);
            if ( spec.requestHeaders ) {
                details.requestHeaders = headersOf(request.channel, 'visitRequestHeaders');
            }
            if ( spec.responseHeaders ) {
                details.responseHeaders = headersOf(request.channel, 'visitResponseHeaders');
            }
            const value = context.callPage(fn, [ context.cloneOut(details) ]);
            if ( spec.blocking && value !== undefined && value !== null ) {
                results.push({ context, value });
            }
        }
        return results;
    }

    // Blocking results: plain ones now, Promises to be waited for.
    outcomeOf(results) {
        const outcome = { sync: [], async: [] };
        for ( const { context, value } of results ) {
            const waived = Cu.waiveXrays(value);
            if ( waived !== null && typeof waived === 'object' && typeof waived.then === 'function' ) {
                outcome.async.push(context.awaitPage(value).catch(reason => {
                    // A page gone (context.awaitPage()) is no listener's error.
                    if ( context.unloaded === false ) { Cu.reportError(reason); }
                    return null;
                }));
                continue;
            }
            try {
                outcome.sync.push(context.cloneIn(value));
            } catch (ex) {
                Cu.reportError(ex);
            }
        }
        return outcome;
    }

    // Returns true when the request was cancelled or redirected.
    apply(request, phase, results) {
        const { channel } = request;
        for ( const result of results ) {
            if ( result === null || typeof result !== 'object' ) { continue; }
            if ( result.cancel === true ) {
                try {
                    channel.cancel(Cr.NS_ERROR_ABORT);
                } catch {
                }
                return true;
            }
            if (
                typeof result.redirectUrl === 'string' &&
                (phase === 'onBeforeRequest' || phase === 'onHeadersReceived')
            ) {
                try {
                    channel.redirectTo(Services.io.newURI(result.redirectUrl, null, null));
                    return true;
                } catch (ex) {
                    Cu.reportError(ex);
                }
            }
            if ( phase === 'onBeforeSendHeaders' && Array.isArray(result.requestHeaders) ) {
                replaceHeaders(channel, result.requestHeaders, false);
            }
            if ( phase === 'onHeadersReceived' && Array.isArray(result.responseHeaders) ) {
                replaceHeaders(channel, result.responseHeaders, true);
            }
        }
        return false;
    }

    /**************************************************************************/

    onModifyRequest(channel) {
        const request = this.requestOf(channel);
        if ( request === null ) { return; }
        if ( this.priming ) {
            channel.suspend();
            this.primed.push(request);
            return;
        }
        this.traceRequest(request);
        this.runRequestPhases(request, false);
    }

    // onBeforeRequest, then onBeforeSendHeaders, then onSendHeaders; any
    // phase may wait for Promises, the channel stays suspended meanwhile,
    // held until they settle or the service stops (stop()).
    runRequestPhases(request, suspended) {
        const phases = [ 'onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders' ];
        let i = 0;
        const resume = ( ) => {
            this.held.delete(resume);
            if ( suspended === false ) { return; }
            suspended = false;
            try {
                request.channel.resume();
            } catch {
            }
        };
        const next = ( ) => {
            while ( i < phases.length ) {
                const phase = phases[i++];
                const outcome = this.outcomeOf(this.dispatch(phase, request));
                if ( this.apply(request, phase, outcome.sync) ) { return resume(); }
                if ( outcome.async.length === 0 ) { continue; }
                if ( suspended === false ) {
                    request.channel.suspend();
                    suspended = true;
                }
                this.held.add(resume);
                Promise.all(outcome.async).then(values => {
                    if ( this.stopped ) { return; }
                    if ( this.apply(request, phase, values) ) { return resume(); }
                    next();
                }).catch(reason => {
                    if ( this.stopped ) { return; }
                    Cu.reportError(reason);
                    resume();
                });
                return;
            }
            resume();
        };
        next();
    }

    onExamineResponse(channel) {
        const request = this.requestOf(channel);
        if ( request === null ) { return; }
        const response = responseDetailsOf(channel);
        const outcome = this.outcomeOf(this.dispatch('onHeadersReceived', request, response));
        if ( this.apply(request, 'onHeadersReceived', outcome.sync) ) { return; }
        if ( outcome.async.length === 0 ) {
            this.maybeRedirected(request, response);
            return;
        }
        // Held until the Promises settle or the service stops (stop()).
        channel.suspend();
        let suspended = true;
        const resume = ( ) => {
            this.held.delete(resume);
            if ( suspended === false ) { return; }
            suspended = false;
            try {
                channel.resume();
            } catch {
            }
        };
        this.held.add(resume);
        Promise.all(outcome.async).then(values => {
            if ( this.stopped ) { return; }
            if ( this.apply(request, 'onHeadersReceived', values) === false ) {
                this.maybeRedirected(request, response);
            }
        }).catch(reason => {
            if ( this.stopped ) { return; }
            Cu.reportError(reason);
        }).then(resume);
    }

    maybeRedirected(request, response) {
        if ( REDIRECT_STATUSES.has(response.statusCode) === false ) { return; }
        if ( this.events.onBeforeRedirect.hasListeners === false ) { return; }
        let redirectUrl;
        try {
            const location = request.channel.getResponseHeader('Location');
            redirectUrl = Services.io.newURI(location, null, request.channel.URI).spec;
        } catch {
            return;
        }
        this.dispatch('onBeforeRedirect', request, Object.assign({ redirectUrl }, response));
    }

    // Every request is traced: the tracing listener also tells until when a
    // stream filter can be attached.
    traceRequest(request) {
        // The upgrade machinery of WebSocket channels is left alone.
        const { type, requestId } = this.baseDetails(request);
        if ( type === 'websocket' ) { return; }
        const listener = new TracingListener(this, request);
        try {
            listener.original = request.channel
                .QueryInterface(Ci.nsITraceableChannel)
                .setNewListener(listener);
        } catch {
            return;
        }
        // After a redirect, the new channel's request takes the same ID.
        this.live.set(requestId, request);
    }

    forget(request) {
        const { requestId } = request.details;
        if ( this.live.get(requestId) === request ) {
            this.live.delete(requestId);
        }
    }

    onResponseStarted(request) {
        this.forget(request);
        try {
            if ( Components.isSuccessCode(request.channel.status) === false ) { return; }
            this.dispatch('onResponseStarted', request, responseDetailsOf(request.channel));
        } catch (ex) {
            Cu.reportError(ex);
        }
    }

    onRequestStopped(request, status) {
        this.forget(request);
        try {
            if ( status === Cr.NS_BINDING_REDIRECTED ) { return; }
            if ( Components.isSuccessCode(status) ) {
                this.dispatch('onCompleted', request, responseDetailsOf(request.channel));
            } else {
                this.dispatch('onErrorOccurred', request, {
                    error: errorNameOf(status),
                    fromCache: false,
                });
            }
        } catch (ex) {
            Cu.reportError(ex);
        }
    }

    /**************************************************************************/

    filterResponseData(context, requestId) {
        const request = this.live.get(String(requestId)) || null;
        const filter = new StreamFilter(context, request);
        if ( filter.attach() === false ) {
            // As in Firefox, an event: the caller has set its handlers by then.
            dispatch(( ) => { filter.fail('Invalid request ID'); });
        }
        return filter;
    }

    // A web page loading one of the extension's web-accessible resources,
    // seen by Extension.jsm's content policy: onBeforeRequest only, its
    // blocking listeners answered on the spot -- as Firefox 52 did for any
    // load that was not HTTP. uBO checks there the secret its resources'
    // URLs carry. A listener's Promise cannot be waited for in a content
    // policy. Returns true when a listener cancelled the load.
    onResourceLoad(policyType, location, requestOrigin, node, requestPrincipal) {
        if ( this.events.onBeforeRequest.hasListeners === false ) { return false; }
        const type = typeOfPolicy(policyType);
        // The window the resource loads into: a frame's own for a subdocument.
        let win = null;
        try {
            if ( type === 'sub_frame' && node.contentWindow ) {
                win = node.contentWindow;
            } else if ( node instanceof Ci.nsIDOMWindow ) {
                win = node;
            } else {
                win = (node.ownerDocument || node).defaultView;
            }
        } catch {
        }
        const browser = win ? this.tracker.browserForContentWindow(win) : null;
        let incognito = false;
        try {
            incognito = requestPrincipal.originAttributes.privateBrowsingId > 0;
        } catch {
        }
        const details = Object.assign({
            requestId: String(nextRequestId++),
            url: location.spec,
            method: 'GET',
            type,
        }, this.tabDetails(
            browser,
            type,
            win ? outerWindowIdOf(win) : 0,
            win && win.parent !== win ? outerWindowIdOf(win.parent) : 0
        ), {
            originUrl: requestPrincipal && requestPrincipal.URI ? requestPrincipal.URI.spec : undefined,
            documentUrl: requestOrigin ? requestOrigin.spec : undefined,
            incognito,
            cookieStoreId: 'firefox-default',
            proxyInfo: null,
        });
        const request = { channel: null, loadInfo: null, browser, details };
        const { sync } = this.outcomeOf(this.dispatch('onBeforeRequest', request));
        return sync.some(result => result !== null && typeof result === 'object' && result.cancel === true);
    }
};

/******************************************************************************/

const createWebRequestAPIs = function(extension) {
    const service = new WebRequestService(extension);
    extension.webRequest = service;
    extension.onShutdown(( ) => { service.stop(); });

    return {
        build() {
            return {
                webRequest: {
                    ResourceType: RESOURCE_TYPES,
                    MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
                    // Nothing is cached, so nothing to flush. uBO calls this
                    // once its filtering engines are (re)built: see
                    // Extension.onFiltersReady().
                    handlerBehaviorChanged: apiAsync(( ) => { extension.onFiltersReady(); }),
                    filterResponseData: apiSync((context, requestId) =>
                        new PageValue(service.filterResponseData(context, requestId).page)
                    ),
                    ...service.events,
                },
            };
        },
    };
};

/******************************************************************************/

return { createWebRequestAPIs };

})();

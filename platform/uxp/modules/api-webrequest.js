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
// Firefox).
//
// Priming: from every (re)start of the background page until uBO adds its
// first onBeforeRequest listener, requests are suspended, then run through
// the listeners -- Firefox does the same with persistent listeners at
// browser launch, which is how uBO blocks from the very first request.
//
// Loaded into Extension.jsm's global (see there).

/* global Ci, Cr, Cu, Services, XPCOMUtils, setTimeout, clearTimeout,
          dispatch, MatchPattern, outerWindowIdOf, errorNameOf, EventManager,
          apiAsync */
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
const TRACING_EVENTS = [ 'onResponseStarted', 'onCompleted', 'onErrorOccurred' ];

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
    } catch (ex) {
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
        } catch (ex) {
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
    } catch (ex) {
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
        } catch (ex) {
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
    } catch (ex) {
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
    } catch (ex) {
    }
    try {
        out.fromCache = channel.QueryInterface(Ci.nsICacheInfoChannel).isFromCache();
    } catch (ex) {
    }
    try {
        out.ip = channel.QueryInterface(Ci.nsIHttpChannelInternal).remoteAddress;
    } catch (ex) {
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
// also sees failures and requests the extension cancelled. After a redirect
// the wrapper moves to the new channel with the rest of the listener chain:
// it only reports for its own channel.

const TracingListener = class {
    constructor(service, request) {
        this.service = service;
        this.request = request;
        this.original = null;
    }

    onStartRequest(channel, ...rest) {
        if ( channel === this.request.channel ) {
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
            if ( channel === this.request.channel ) {
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

const WebRequestService = class {
    constructor(extension) {
        this.extension = extension;
        this.tracker = extension.tabTracker;
        this.specs = new WeakMap();
        this.priming = false;
        this.primed = [];
        this.primingTimer = null;
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

    stop() {
        Services.obs.removeObserver(this, MODIFY_TOPIC);
        for ( const topic of EXAMINE_TOPICS ) {
            Services.obs.removeObserver(this, topic);
        }
        this.endPriming();
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
                try { request.channel.resume(); } catch (e) { }
            }
        }
    }

    observe(subject, topic) {
        let channel;
        try {
            channel = subject.QueryInterface(Ci.nsIHttpChannel);
        } catch (ex) {
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
        } catch (ex) {
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
        const tab = browser !== null ? this.tracker.tabForBrowser(browser) : null;
        // Frame IDs as in Firefox: 0 for the tab's top-level window.
        let frameId = 0;
        let parentFrameId = -1;
        if ( tab !== null && type !== 'main_frame' ) {
            let windowId = loadInfo.outerWindowID;
            let parentWindowId = loadInfo.parentOuterWindowID;
            if ( loadInfo.frameOuterWindowID ) {
                windowId = loadInfo.frameOuterWindowID;
                parentWindowId = loadInfo.outerWindowID;
            }
            let topWindowId = 0;
            try {
                topWindowId = outerWindowIdOf(browser.contentWindow);
            } catch (ex) {
            }
            if ( windowId !== 0 && windowId !== topWindowId ) {
                frameId = windowId;
                parentFrameId = parentWindowId === topWindowId ? 0 : parentWindowId;
            }
        }
        let documentUrl;
        if ( type !== 'main_frame' ) {
            try {
                const doc = loadInfo.loadingDocument;
                if ( doc ) { documentUrl = doc.documentURI; }
            } catch (ex) {
            }
            if ( documentUrl === undefined && loadInfo.loadingPrincipal && loadInfo.loadingPrincipal.URI ) {
                documentUrl = loadInfo.loadingPrincipal.URI.spec;
            }
        }
        const triggering = loadInfo.triggeringPrincipal;
        let incognito = false;
        try {
            incognito = loadInfo.originAttributes.privateBrowsingId > 0;
        } catch (ex) {
        }
        request.details = {
            requestId: requestIdOf(channel),
            url,
            method: channel.requestMethod,
            type,
            tabId: tab !== null ? this.tracker.getId(browser) : -1,
            windowId: tab !== null ? this.tracker.windowIdOf(tab.ownerGlobal) : -1,
            frameId,
            parentFrameId,
            originUrl: triggering && triggering.URI ? triggering.URI.spec : undefined,
            documentUrl,
            incognito,
            cookieStoreId: 'firefox-default',
            proxyInfo: proxyInfoOf(channel),
        };
        return request.details;
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
                    Cu.reportError(reason);
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
                } catch (ex) {
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
    // phase may wait for Promises, the channel stays suspended meanwhile.
    runRequestPhases(request, suspended) {
        const phases = [ 'onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders' ];
        let i = 0;
        const resume = ( ) => {
            if ( suspended === false ) { return; }
            suspended = false;
            try {
                request.channel.resume();
            } catch (ex) {
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
                Promise.all(outcome.async).then(values => {
                    if ( this.apply(request, phase, values) ) { return resume(); }
                    next();
                }).catch(reason => {
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
        channel.suspend();
        Promise.all(outcome.async).then(values => {
            if ( this.apply(request, 'onHeadersReceived', values) === false ) {
                this.maybeRedirected(request, response);
            }
        }).catch(reason => {
            Cu.reportError(reason);
        }).then(( ) => {
            try {
                channel.resume();
            } catch (ex) {
            }
        });
    }

    maybeRedirected(request, response) {
        if ( REDIRECT_STATUSES.has(response.statusCode) === false ) { return; }
        if ( this.events.onBeforeRedirect.hasListeners === false ) { return; }
        let redirectUrl;
        try {
            const location = request.channel.getResponseHeader('Location');
            redirectUrl = Services.io.newURI(location, null, request.channel.URI).spec;
        } catch (ex) {
            return;
        }
        this.dispatch('onBeforeRedirect', request, Object.assign({ redirectUrl }, response));
    }

    traceRequest(request) {
        if ( TRACING_EVENTS.every(name => this.events[name].hasListeners === false) ) { return; }
        // The upgrade machinery of WebSocket channels is left alone.
        if ( this.baseDetails(request).type === 'websocket' ) { return; }
        const listener = new TracingListener(this, request);
        try {
            listener.original = request.channel
                .QueryInterface(Ci.nsITraceableChannel)
                .setNewListener(listener);
        } catch (ex) {
        }
    }

    onResponseStarted(request) {
        try {
            if ( Components.isSuccessCode(request.channel.status) === false ) { return; }
            this.dispatch('onResponseStarted', request, responseDetailsOf(request.channel));
        } catch (ex) {
            Cu.reportError(ex);
        }
    }

    onRequestStopped(request, status) {
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
                    ...service.events,
                },
            };
        },
    };
};

/******************************************************************************/

return { createWebRequestAPIs };

})();

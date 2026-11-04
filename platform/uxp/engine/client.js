/*******************************************************************************

    uBlock Origin for UXP - the filtering engine's worker, page side
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

/* global Worker, setTimeout, clearTimeout */

// uBO's background page asks js/uxp-engine-worker.js (worker.js) to compile
// filter lists (storage.js, µb.compileFiltersAsync()), to build the network
// filtering engine (loadFilterLists()), and to write its biggest cache
// entries (cachestorage.js). Shipped as js/uxp-engine.js. Each call rejects
// if the worker fails or takes too long, for the page to do the work
// itself.

const WORKER_URL = 'js/uxp-engine-worker.js';

// UXP copies a message's strings on the sending thread: each text goes in
// slices of this many characters, one per task (as worker.js's answers).
const SLICE_LENGTH = 1 << 20;

// In a value to store, what stands for a text sent ahead (as worker.js's).
const TEXT_MARK = '\u0000uxp-text';

// How long a request may wait for its answer.
const TIMEOUT_MS = 120000;

// How long the worker stays once it has nothing to do.
const IDLE_MS = 30000;

const nextTask = ( ) => new Promise(resolve => { setTimeout(resolve, 0); });

const postText = async function(worker, key, text) {
    for ( let i = 0; i === 0 || i < text.length; i += SLICE_LENGTH ) {
        worker.postMessage({ what: 'append', key, text: text.slice(i, i + SLICE_LENGTH) });
        await nextTask();
    }
};

/******************************************************************************/

// Compiling and storing: one worker, for as long as there is work for it
// and a while after; it does the work in the order it comes. A failure of
// the worker itself (its script, a request with no answer) ends it, failing
// whatever it had in hand; the next request starts a new one.

let engine = null;
const requests = new Map(); // request key -> { parts, resolve, reject, timer }
let requestCount = 0;
let idleTimer;

const stopEngine = function(reason) {
    if ( engine === null ) { return; }
    engine.terminate();
    engine = null;
    clearTimeout(idleTimer);
    for ( const request of requests.values() ) {
        clearTimeout(request.timer);
        request.reject(reason);
    }
    requests.clear();
};

const startEngine = function() {
    const worker = new Worker(WORKER_URL);
    worker.onmessage = ev => {
        const { what, key } = ev.data;
        const request = requests.get(key);
        if ( request === undefined ) { return; }
        if ( what === 'compiledSlice' ) {
            request.parts.push(ev.data.text);
            return;
        }
        requests.delete(key);
        clearTimeout(request.timer);
        if ( what === 'compiled' ) {
            request.resolve({ compiled: request.parts.join(''), messages: ev.data.messages });
        } else if ( what === 'stored' ) {
            request.resolve(ev.data.ok);
        } else {
            request.reject(new Error(ev.data.message));
        }
        if ( requests.size === 0 ) {
            idleTimer = setTimeout(( ) => { stopEngine(); }, IDLE_MS);
        }
    };
    worker.onerror = ev => {
        ev.preventDefault();
        stopEngine(new Error(`${WORKER_URL}: ${ev.message}`));
    };
    return worker;
};

// A new request: the worker to send it to, its key, its answer to come.
const newRequest = function(kind) {
    if ( engine === null ) {
        engine = startEngine();
    }
    clearTimeout(idleTimer);
    requestCount += 1;
    const key = `${kind}-${requestCount}`;
    const answered = new Promise((resolve, reject) => {
        const timer = setTimeout(( ) => {
            stopEngine(new Error(`${WORKER_URL}: no answer after ${TIMEOUT_MS / 1000} s`));
        }, TIMEOUT_MS);
        requests.set(key, { parts: [], resolve, reject, timer });
    });
    // A failure while the request is still being sent is reported to
    // whoever awaits it.
    answered.catch(( ) => {});
    return { worker: engine, key, answered };
};

// request: worker.js's compile request, but its key (what=, key=).
// Resolves with { compiled, messages }: the compiled list, and what uBO's
// compiler wrote to its logger, for the page's logger.
export const compileFilters = async function(rawText, request) {
    const { worker, key, answered } = newRequest('compile');
    await postText(worker, key, rawText);
    worker.postMessage(Object.assign({}, request, { what: 'compile', key }));
    return answered;
};

// `value` as it can go to the worker without blocking this thread: texts
// longer than a slice go ahead in slices (out.texts), a mark in their
// place; typed arrays over a big buffer go as copies of just their bytes,
// whose buffers are transferred (out.transfer), as cloning a view clones
// all of its buffer. Containers holding either are copied, the rest is
// the value's own.
const forPosting = function(value, out, depth = 0) {
    if ( typeof value === 'string' ) {
        if ( value.length <= SLICE_LENGTH ) { return value; }
        const textKey = `${out.key}/${out.texts.length}`;
        out.texts.push({ textKey, text: value });
        return { [TEXT_MARK]: textKey };
    }
    if ( value === null || typeof value !== 'object' || depth > 16 ) { return value; }
    if ( ArrayBuffer.isView(value) ) {
        if ( value.buffer.byteLength <= SLICE_LENGTH || typeof value.slice !== 'function' ) {
            return value;
        }
        const copy = value.slice();
        out.transfer.push(copy.buffer);
        return copy;
    }
    if ( value instanceof ArrayBuffer ) {
        if ( value.byteLength <= SLICE_LENGTH ) { return value; }
        const copy = value.slice(0);
        out.transfer.push(copy);
        return copy;
    }
    if ( value instanceof Map ) {
        let copy;
        for ( const [ k, v ] of value ) {
            const w = forPosting(v, out, depth + 1);
            if ( w === v ) { continue; }
            if ( copy === undefined ) { copy = new Map(value); }
            copy.set(k, w);
        }
        return copy || value;
    }
    if ( Array.isArray(value) ) {
        let copy;
        for ( let i = 0; i < value.length; i++ ) {
            const w = forPosting(value[i], out, depth + 1);
            if ( w === value[i] ) { continue; }
            if ( copy === undefined ) { copy = value.slice(); }
            copy[i] = w;
        }
        return copy || value;
    }
    const proto = Object.getPrototypeOf(value);
    if ( proto !== Object.prototype && proto !== null ) { return value; }
    let copy;
    for ( const k of Object.keys(value) ) {
        const w = forPosting(value[k], out, depth + 1);
        if ( w === value[k] ) { continue; }
        if ( copy === undefined ) { copy = Object.assign({}, value); }
        copy[k] = w;
    }
    return copy || value;
};

// Puts entries ({ key, value }) into the page's IndexedDB database
// `dbName`, object store `storeName` (keyPath 'key'), in one transaction.
// Resolves with whether they were written.
export const storeEntries = async function(dbName, storeName, entries) {
    const { worker, key, answered } = newRequest('store');
    const out = { key, texts: [], transfer: [] };
    const posted = entries.map(entry => ({
        key: entry.key,
        value: forPosting(entry.value, out),
    }));
    for ( const { textKey, text } of out.texts ) {
        await postText(worker, textKey, text);
    }
    worker.postMessage({ what: 'store', key, dbName, storeName, entries: posted }, out.transfer);
    return answered;
};

/******************************************************************************/

// Building: one worker per build, as the selfie's buffers move to this page.
// lists: [ { key, compiled } ], in the order they are to be loaded.
// Resolves with { selfie, counts }.
export const buildNetworkEngine = async function(lists) {
    const worker = new Worker(WORKER_URL);
    let timer;
    const answered = new Promise((resolve, reject) => {
        worker.onmessage = ev => {
            const data = ev.data;
            if ( data.what === 'networkEngine' ) {
                resolve(data);
            } else {
                reject(new Error(data.message));
            }
        };
        worker.onerror = ev => {
            ev.preventDefault();
            reject(new Error(`${WORKER_URL}: ${ev.message}`));
        };
        timer = setTimeout(( ) => {
            reject(new Error(`${WORKER_URL}: no answer after ${TIMEOUT_MS / 1000} s`));
        }, TIMEOUT_MS);
    });
    // A failure while the lists are still being sent is reported below.
    answered.catch(( ) => {});
    try {
        for ( const { key, compiled } of lists ) {
            await postText(worker, key, compiled);
        }
        worker.postMessage({ what: 'buildNetworkEngine' });
        const { selfie, counts } = await answered;
        return { selfie, counts };
    } finally {
        clearTimeout(timer);
        worker.terminate();
    }
};

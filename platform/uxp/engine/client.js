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
// filter lists (storage.js, µb.compileFiltersAsync()) and to build the
// network filtering engine (loadFilterLists()). Shipped as js/uxp-engine.js.
// Each call rejects if the worker fails or takes too long, for storage.js
// to do the work on the page instead.

const WORKER_URL = 'js/uxp-engine-worker.js';

// UXP copies a message's strings on the sending thread: each text goes in
// slices of this many characters, one per task (as worker.js's answers).
const SLICE_LENGTH = 1 << 20;

// How long a request may wait for its answer.
const TIMEOUT_MS = 120000;

// How long the compiling worker stays once it has nothing to compile.
const COMPILER_IDLE_MS = 30000;

const nextTask = ( ) => new Promise(resolve => { setTimeout(resolve, 0); });

const postText = async function(worker, key, text) {
    for ( let i = 0; i === 0 || i < text.length; i += SLICE_LENGTH ) {
        worker.postMessage({ what: 'append', key, text: text.slice(i, i + SLICE_LENGTH) });
        await nextTask();
    }
};

/******************************************************************************/

// Compiling: one worker, for as long as there are lists to compile and a
// while after; it compiles them in the order they come. A failure of the
// worker itself (its script, a request with no answer) ends it, failing
// whatever it had in hand; the next request starts a new one.

let compiler = null;
const compiles = new Map(); // request key -> { parts, resolve, reject, timer }
let compileCount = 0;
let compilerIdleTimer;

const stopCompiler = function(reason) {
    if ( compiler === null ) { return; }
    compiler.terminate();
    compiler = null;
    clearTimeout(compilerIdleTimer);
    for ( const request of compiles.values() ) {
        clearTimeout(request.timer);
        request.reject(reason);
    }
    compiles.clear();
};

const startCompiler = function() {
    const worker = new Worker(WORKER_URL);
    worker.onmessage = ev => {
        const { what, key } = ev.data;
        const request = compiles.get(key);
        if ( request === undefined ) { return; }
        if ( what === 'compiledSlice' ) {
            request.parts.push(ev.data.text);
            return;
        }
        compiles.delete(key);
        clearTimeout(request.timer);
        if ( what === 'compiled' ) {
            request.resolve({ compiled: request.parts.join(''), messages: ev.data.messages });
        } else {
            request.reject(new Error(ev.data.message));
        }
        if ( compiles.size === 0 ) {
            compilerIdleTimer = setTimeout(( ) => { stopCompiler(); }, COMPILER_IDLE_MS);
        }
    };
    worker.onerror = ev => {
        ev.preventDefault();
        stopCompiler(new Error(`${WORKER_URL}: ${ev.message}`));
    };
    return worker;
};

// request: worker.js's compile request, but its key (what=, key=).
// Resolves with { compiled, messages }: the compiled list, and what uBO's
// compiler wrote to its logger, for the page's logger.
export const compileFilters = async function(rawText, request) {
    if ( compiler === null ) {
        compiler = startCompiler();
    }
    clearTimeout(compilerIdleTimer);
    const worker = compiler;
    compileCount += 1;
    const key = `compile-${compileCount}`;
    const answered = new Promise((resolve, reject) => {
        const timer = setTimeout(( ) => {
            stopCompiler(new Error(`${WORKER_URL}: no answer after ${TIMEOUT_MS / 1000} s`));
        }, TIMEOUT_MS);
        compiles.set(key, { parts: [], resolve, reject, timer });
    });
    // A failure while the list is still being sent is reported below.
    answered.catch(( ) => {});
    await postText(worker, key, rawText);
    worker.postMessage(Object.assign({}, request, { what: 'compile', key }));
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

/*******************************************************************************

    uBlock Origin for UXP - the network filtering engine's worker, page side
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

// uBO's background page asks js/uxp-engine-worker.js (worker.js) to build
// the network filtering engine (storage.js, loadFilterLists()). Shipped as
// js/uxp-engine.js.

const WORKER_URL = 'js/uxp-engine-worker.js';

// UXP copies a message's strings on the sending thread: each list goes in
// slices of this many characters, one per task.
const SLICE_LENGTH = 1 << 20;

// Beyond this, the page builds the engine itself (storage.js).
const TIMEOUT_MS = 120000;

const nextTask = ( ) => new Promise(resolve => { setTimeout(resolve, 0); });

// lists: [ { key, compiled } ], in the order they are to be loaded.
// Resolves with { selfie, counts }; rejects if the worker fails or takes too
// long. One worker per build: the selfie's buffers move to this page.
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
            for ( let i = 0; i === 0 || i < compiled.length; i += SLICE_LENGTH ) {
                worker.postMessage({ what: 'append', key, text: compiled.slice(i, i + SLICE_LENGTH) });
                await nextTask();
            }
        }
        worker.postMessage({ what: 'buildNetworkEngine' });
        const { selfie, counts } = await answered;
        return { selfie, counts };
    } finally {
        clearTimeout(timer);
        worker.terminate();
    }
};

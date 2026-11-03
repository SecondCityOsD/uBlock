/*******************************************************************************

    uBlock Origin for UXP - the network filtering engine's worker
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

// UXP has no extension process: whatever uBO's background page computes
// blocks the browser (PLAN.md, Phase 6d findings). This worker builds uBO's
// network filtering engine off the main thread from the compiled lists, and
// hands it back as the engine's selfie, which the page loads with
// fromSelfie(): uBO's own restore path, the one every launch takes.
//
// tools/make-uxp.mjs bundles it, with the package's copy of uBO's modules,
// into js/uxp-engine-worker.js: a plain worker script, as UXP has no module
// workers. Its imports are relative to the package's root.
//
// One build per worker: the selfie's buffers are transferred to the page,
// which leaves this copy of the engine unusable.
//
// The page sends each compiled list in slices, one per message: UXP copies
// a message's strings on the sending thread, ~11 ms per MB, and the
// compiled default lists weigh ~78 MB.
//
// Requests: { what: 'append', key, text }   (a list's next slice)
//           { what: 'buildNetworkEngine' }   (the lists appended, in order)
// Answer:   { what: 'networkEngine', selfie, counts: { key: [ accepted, discarded ] } }
//           { what: 'error', message }

import { CompiledListReader } from './js/static-filtering-io.js';
import staticNetFilteringEngine from './js/static-net-filtering.js';

// The buffers a selfie holds: its typed arrays go to the page uncopied.
const buffersOf = function(value, out = new Set(), depth = 0) {
    if ( value === null || typeof value !== 'object' || depth > 8 ) { return out; }
    if ( ArrayBuffer.isView(value) ) {
        out.add(value.buffer);
    } else if ( value instanceof ArrayBuffer ) {
        out.add(value);
    } else if ( value instanceof Map ) {
        for ( const item of value.values() ) { buffersOf(item, out, depth + 1); }
    } else {
        for ( const item of Object.values(value) ) { buffersOf(item, out, depth + 1); }
    }
    return out;
};

// uBO's loadFilterLists(), the network engine's part: each list loaded in
// turn (its counts are what the list contributed), then frozen. toSelfie()
// also optimizes, so the page's own selfie save costs little afterwards.
const buildNetworkEngine = function(lists) {
    const snfe = staticNetFilteringEngine;
    snfe.reset();
    const counts = {};
    for ( const { key, compiled } of lists ) {
        const accepted = snfe.acceptedCount;
        const discarded = snfe.discardedCount;
        if ( compiled !== '' ) {
            snfe.fromCompiled(new CompiledListReader(compiled));
        }
        counts[key] = [ snfe.acceptedCount - accepted, snfe.discardedCount - discarded ];
    }
    snfe.freeze();
    return { selfie: snfe.toSelfie(), counts };
};

// The lists' slices, by key, in the order the lists came.
const slices = new Map();

self.onmessage = ev => {
    const { what } = ev.data;
    try {
        if ( what === 'append' ) {
            const { key, text } = ev.data;
            if ( slices.has(key) === false ) { slices.set(key, []); }
            slices.get(key).push(text);
            return;
        }
        if ( what !== 'buildNetworkEngine' ) {
            throw new Error(`unknown request: ${what}`);
        }
        const lists = Array.from(slices, ([ key, parts ]) => ({ key, compiled: parts.join('') }));
        slices.clear();
        const { selfie, counts } = buildNetworkEngine(lists);
        self.postMessage({ what: 'networkEngine', selfie, counts }, Array.from(buffersOf(selfie)));
    } catch (ex) {
        self.postMessage({ what: 'error', message: String(ex && ex.stack || ex) });
    }
};

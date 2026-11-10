/*******************************************************************************

    uBlock Origin for UXP - the filtering engine's worker
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
// blocks the browser (compiling lists and building its engines froze it for
// seconds at a time). This worker does uBO's heaviest work off the main
// thread, with uBO's own code:
// - it compiles filter lists, with µb.compileFilters()'s loop
//   (static-filtering-compiler.js), and answers with the compiled list;
// - it builds the network filtering engine from compiled lists, and
//   answers with the engine's selfie, which the page loads with
//   fromSelfie(): uBO's own restore path, the one every launch takes;
// - it writes uBO's biggest cache entries, compiled lists and selfies, into
//   its IndexedDB database (cachestorage.js): put() serializes the value on
//   the calling thread, ~14 ms per MB on Pale Moon.
//
// tools/make-uxp.mjs bundles it, with the package's copy of uBO's modules,
// into js/uxp-engine-worker.js: a plain worker script, as UXP has no module
// workers. Its imports are relative to the package's root, but for
// worker-env.js, its stand-ins for the background page.
//
// Texts go both ways in slices, one per message: UXP copies a message's
// strings on the sending thread, ~11 ms per MB, and the compiled default
// lists weigh ~78 MB. A worker compiles and stores any number of times, or
// builds one engine: the selfie's buffers are transferred to the page,
// which leaves this copy of the engine unusable.
//
// Requests: { what: 'append', key, text }
//               the next slice of a text: a raw list to compile, or a
//               compiled list to build from
//           { what: 'compile', key, options, hiddenSettings, redirectAliases }
//               compile the raw list appended as `key`; options are
//               compileFilterList()'s, the rest what uBO's engines read
//               from the page (µb.hiddenSettings, redirectEngine.aliases)
//           { what: 'buildNetworkEngine' }
//               build from all the compiled lists appended, in order
//           { what: 'store', key, dbName, storeName, entries }
//               put the entries ({ key, value }) into that database's
//               object store, in one transaction; in their values, each
//               { [TEXT_MARK]: textKey } stands for a text appended
// Answers:  { what: 'compiledSlice', key, text }, then
//           { what: 'compiled', key, messages }
//               the compiled list in slices, then what uBO's compiler
//               wrote to its logger
//           { what: 'networkEngine', selfie, counts: { key: [ accepted, discarded ] } }
//           { what: 'stored', key, ok }
//           { what: 'error', key, message }

import { logger, µb } from './worker-env.js';
import { CompiledListReader } from './js/static-filtering-io.js';
import { compileFilterList } from './js/static-filtering-compiler.js';
import { redirectEngine } from './js/redirect-engine.js';
import staticNetFilteringEngine from './js/static-net-filtering.js';

// As platform/uxp/engine/client.js's.
const SLICE_LENGTH = 1 << 20;
const TEXT_MARK = '\u0000uxp-text';

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

// µb.compileFilters(), with the page's state it depends on.
const compile = function(text, { options, hiddenSettings, redirectAliases }) {
    µb.hiddenSettings.allowGenericProceduralFilters =
        hiddenSettings.allowGenericProceduralFilters;
    redirectEngine.aliases = redirectAliases;
    logger.entries.length = 0;
    const compiled = compileFilterList(text, options);
    return { compiled, messages: logger.entries.splice(0) };
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

// The texts' slices, by key, in the order the texts came.
const slices = new Map();

const takeText = function(key) {
    const parts = slices.get(key) || [];
    slices.delete(key);
    return parts.join('');
};

// A value as the page had it: each text mark replaced with its text. The
// value is this worker's own copy, changed in place.
const withTexts = function(value, depth = 0) {
    if ( value === null || typeof value !== 'object' || depth > 16 ) { return value; }
    if ( ArrayBuffer.isView(value) || value instanceof ArrayBuffer ) { return value; }
    if ( Object.hasOwn(value, TEXT_MARK) ) { return takeText(value[TEXT_MARK]); }
    if ( value instanceof Map ) {
        for ( const [ k, v ] of value ) { value.set(k, withTexts(v, depth + 1)); }
    } else if ( Array.isArray(value) ) {
        for ( let i = 0; i < value.length; i++ ) { value[i] = withTexts(value[i], depth + 1); }
    } else if ( value instanceof Set === false ) {
        for ( const k of Object.keys(value) ) { value[k] = withTexts(value[k], depth + 1); }
    }
    return value;
};

// The page's databases, opened once. A version change (the page deleting
// a database) closes this side's connection, so as not to block it.
const databases = new Map();

const openDatabase = function(name) {
    if ( databases.has(name) === false ) {
        databases.set(name, new Promise((resolve, reject) => {
            const request = indexedDB.open(name);
            request.onsuccess = ( ) => {
                const db = request.result;
                db.onversionchange = ( ) => {
                    db.close();
                    databases.delete(name);
                };
                resolve(db);
            };
            request.onerror = ev => {
                ev.preventDefault();
                databases.delete(name);
                reject(request.error);
            };
        }));
    }
    return databases.get(name);
};

// Resolves with whether all `entries` were written. A transaction aborted
// from outside (the extension stopped, its page and so this worker gone)
// fails each write with an AbortError: the transaction tells it already,
// so those are not reported as errors too. Any other error aborts the
// transaction, and is reported, as it would be.
const store = async function({ dbName, storeName, entries }) {
    const db = await openDatabase(dbName);
    return new Promise(resolve => {
        const transaction = db.transaction(storeName, 'readwrite');
        transaction.oncomplete = ( ) => { resolve(true); };
        transaction.onerror = transaction.onabort = ( ) => { resolve(false); };
        const objectStore = transaction.objectStore(storeName);
        const onerror = ev => {
            const { error } = ev.target;
            if ( error && error.name === 'AbortError' ) { ev.preventDefault(); }
        };
        for ( const { key, value } of entries ) {
            objectStore.put({ key, value: withTexts(value) }).onerror = onerror;
        }
    });
};

let built = false;

self.onmessage = ev => {
    const { what, key } = ev.data;
    try {
        if ( built ) {
            throw new Error('this worker built an engine: its buffers are gone');
        }
        switch ( what ) {
        case 'append': {
            if ( slices.has(key) === false ) { slices.set(key, []); }
            slices.get(key).push(ev.data.text);
            break;
        }
        case 'compile': {
            const { compiled, messages } = compile(takeText(key), ev.data);
            for ( let i = 0; i === 0 || i < compiled.length; i += SLICE_LENGTH ) {
                self.postMessage({ what: 'compiledSlice', key, text: compiled.slice(i, i + SLICE_LENGTH) });
            }
            self.postMessage({ what: 'compiled', key, messages });
            break;
        }
        case 'store': {
            store(ev.data).then(ok => {
                self.postMessage({ what: 'stored', key, ok });
            }, reason => {
                self.postMessage({ what: 'error', key, message: String(reason) });
            });
            break;
        }
        case 'buildNetworkEngine': {
            const lists = Array.from(slices, ([ listKey, parts ]) => ({
                key: listKey,
                compiled: parts.join(''),
            }));
            slices.clear();
            built = true;
            const { selfie, counts } = buildNetworkEngine(lists);
            self.postMessage({ what: 'networkEngine', selfie, counts }, Array.from(buffersOf(selfie)));
            break;
        }
        default:
            throw new Error(`unknown request: ${what}`);
        }
    } catch (ex) {
        self.postMessage({ what: 'error', key, message: String(ex && ex.stack || ex) });
    }
};

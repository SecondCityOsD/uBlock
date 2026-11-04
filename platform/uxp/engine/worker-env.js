/*******************************************************************************

    uBlock Origin for UXP - the background page, as the engine's worker sees it
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

// uBO's cosmetic, scriptlet, HTML and header filtering engines, which the
// worker's compiler uses, import modules of the background page
// (background.js, logger.js, broadcast.js) and the built-in scriptlets,
// and use vAPI as they load; none of that is needed to compile. In the
// worker's bundle, tools/make-uxp.mjs has those modules' imports resolve to
// the stand-ins below (WORKER_STAND_INS), and this sets vAPI.
//
// Each stand-in holds only what compiling and loading need; anything else
// throws, naming what's missing, so that a newer uBO needing more of the
// page fails here, loudly, and the page compiles instead (worker.js answers
// with the error).

const strict = (name, target) => new Proxy(target, {
    get(target, property) {
        if ( property in target ) { return target[property]; }
        throw new Error(`${name}.${String(property)}: not in the engine's worker`);
    },
});

// What the modules use as they load: CosmeticFilteringEngine and
// StaticExtFilteringHostnameDB create timers, which reset() cancels (a
// timer is started only once filters are loaded, which never happens
// here), ScriptletFilteringEngineEx makes a URL. redirect-engine.js and
// static-net-filtering.js have stand-ins of their own for when there is no
// vAPI, which they get here: a function making redirect secrets (only
// called to redirect), and a store that forgets the tries' size hints
// (the page keeps its own).
globalThis.vAPI = strict('vAPI', {
    defer: strict('vAPI.defer', {
        create: ( ) => strict('vAPI.defer timer', {
            off( ) {},
            ongoing: ( ) => false,
        }),
    }),
    getURL: path => path,
    localStorage: {
        getItem( ) { return null; },
        setItem( ) {},
        removeItem( ) {},
    },
    warSecret: strict('vAPI.warSecret', {
        short: ( ) => '',
    }),
});

// background.js: the hidden setting compiling reads; worker.js sets it from
// the page's, with each request.
export const µb = strict('µb', {
    hiddenSettings: strict('µb.hiddenSettings', {
        allowGenericProceduralFilters: false,
    }),
});

// logger.js: compiling writes invalid filters to uBO's logger; they are
// kept for worker.js, which hands them to the page's logger.
export const logger = strict('logger', {
    enabled: false,
    entries: [],
    writeOne(details) {
        this.entries.push(details);
    },
});

// broadcast.js: ScriptletFilteringEngineEx listens to broadcasts, which
// never reach a worker.
export const onBroadcast = ( ) => strict('onBroadcast() channel', {});

// resources/scriptlets.js: the scriptlets' code, which the redirect engine
// loads only for the page to inject them. Its aliases, which compiling
// needs, come with each request (worker.js).
export const builtinScriptlets = strict('builtinScriptlets', {});

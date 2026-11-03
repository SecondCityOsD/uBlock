/*******************************************************************************

    uBlock Origin for UXP - changes to uBO's code for UXP
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

// Where uBO's behavior has to differ on UXP, applied by tools/make-uxp.mjs
// to the package's copy (upstream/ stays as published; PLAN.md, Phase 6e).
// Each edit is a text that must occur exactly once in its file, and its
// replacement; the code added is marked [uBlock-UXP]. When upstream changes
// a patched spot, the build stops instead of shipping a half-applied patch.

import fs from 'node:fs';
import path from 'node:path';

export const PATCHES = [
    {
        // UXP has no extension process: building the network filtering
        // engine on the background page blocks the browser for seconds.
        // loadFilterLists() now loads each list's cosmetic part as before
        // and keeps its network part; onDone() has the network engine
        // built in a worker (js/uxp-engine.js) and loads it from its
        // selfie. If the worker fails, the engine is built on the page,
        // as upstream does.
        file: 'js/storage.js',
        edits: [
            [
                "import staticNetFilteringEngine from './static-net-filtering.js';\n",
                "import staticNetFilteringEngine from './static-net-filtering.js';\n" +
                "// [uBlock-UXP] tools/uxp-patches.mjs\n" +
                "import { buildNetworkEngine as uxpBuildNetworkEngine } from './uxp-engine.js';\n",
            ],
            [
                '    const onDone = ( ) => {\n' +
                '        ubolog(`loadFilterLists() All filters in memory at ${elapsed()}`);\n' +
                '\n' +
                '        staticNetFilteringEngine.freeze();\n',
                '    const onDone = async ( ) => {\n' +
                '        ubolog(`loadFilterLists() All filters in memory at ${elapsed()}`);\n' +
                '\n' +
                '        // [uBlock-UXP] tools/uxp-patches.mjs\n' +
                '        await buildNetworkEngine();\n' +
                '\n' +
                '        staticNetFilteringEngine.freeze();\n',
            ],
            [
                '        }).then(( ) => {\n' +
                '            onDone();\n' +
                '        });\n' +
                '        return loadingPromise;\n',
                '        }).then(( ) => {\n' +
                '            // [uBlock-UXP] tools/uxp-patches.mjs: onDone() waits for\n' +
                '            // the network engine\'s worker, and so does whoever awaits\n' +
                '            // loadFilterLists() (start.js before readyToFilter).\n' +
                '            return onDone();\n' +
                '        });\n' +
                '        return loadingPromise;\n',
            ],
            [
                '    const applyCompiledFilters = (assetKey, compiled) => {\n' +
                '        ubolog(`loadFilterLists() Loading filters from ${assetKey} at ${elapsed()}`);\n' +
                '        const snfe = staticNetFilteringEngine;\n' +
                '        const sxfe = staticExtFilteringEngine;\n' +
                '        let acceptedCount = snfe.acceptedCount + sxfe.acceptedCount;\n' +
                '        let discardedCount = snfe.discardedCount + sxfe.discardedCount;\n' +
                '        µb.applyCompiledFilters(compiled, assetKey === µb.userFiltersPath);\n' +
                '        if ( Object.hasOwn(µb.availableFilterLists, assetKey) ) {\n' +
                '            const entry = µb.availableFilterLists[assetKey];\n' +
                '            entry.entryCount = snfe.acceptedCount + sxfe.acceptedCount -\n' +
                '                acceptedCount;\n' +
                '            entry.entryUsedCount = entry.entryCount -\n' +
                '                (snfe.discardedCount + sxfe.discardedCount - discardedCount);\n' +
                '        }\n' +
                '        loadedListKeys.push(assetKey);\n' +
                '    };\n',
                '    // [uBlock-UXP] tools/uxp-patches.mjs: each list\'s network part, kept\n' +
                '    // for onDone(), with what its cosmetic part counted.\n' +
                '    const networkLists = [];\n' +
                '\n' +
                '    const applyCompiledFilters = (assetKey, compiled) => {\n' +
                '        ubolog(`loadFilterLists() Loading filters from ${assetKey} at ${elapsed()}`);\n' +
                '        const sxfe = staticExtFilteringEngine;\n' +
                '        const acceptedCount = sxfe.acceptedCount;\n' +
                '        const discardedCount = sxfe.discardedCount;\n' +
                '        µb.applyCompiledFilters(compiled, assetKey === µb.userFiltersPath, false);\n' +
                '        networkLists.push({\n' +
                '            key: assetKey,\n' +
                '            compiled,\n' +
                '            accepted: sxfe.acceptedCount - acceptedCount,\n' +
                '            discarded: sxfe.discardedCount - discardedCount,\n' +
                '        });\n' +
                '        loadedListKeys.push(assetKey);\n' +
                '    };\n' +
                '\n' +
                '    // [uBlock-UXP] The network engine, from the lists\' network parts:\n' +
                '    // built in a worker and loaded from its selfie, or, if that fails,\n' +
                '    // built here as upstream does. A list\'s counts are what its\n' +
                '    // cosmetic and its network filters counted.\n' +
                '    const buildNetworkEngine = async ( ) => {\n' +
                '        const lists = networkLists.splice(0);\n' +
                '        const snfe = staticNetFilteringEngine;\n' +
                '        let counts;\n' +
                '        try {\n' +
                '            const built = await uxpBuildNetworkEngine(lists);\n' +
                '            if ( snfe.fromSelfie(built.selfie) !== true ) {\n' +
                '                throw new Error(\'fromSelfie() failed\');\n' +
                '            }\n' +
                '            counts = built.counts;\n' +
                '            ubolog(`loadFilterLists() Network filters built in a worker at ${elapsed()}`);\n' +
                '        } catch (reason) {\n' +
                '            ubolog(`loadFilterLists() Network filters built on the page: ${reason}`);\n' +
                '            snfe.reset();\n' +
                '            counts = {};\n' +
                '            for ( const { key, compiled } of lists ) {\n' +
                '                const accepted = snfe.acceptedCount;\n' +
                '                const discarded = snfe.discardedCount;\n' +
                '                if ( compiled !== \'\' ) {\n' +
                '                    snfe.fromCompiled(new CompiledListReader(compiled));\n' +
                '                }\n' +
                '                counts[key] = [ snfe.acceptedCount - accepted, snfe.discardedCount - discarded ];\n' +
                '            }\n' +
                '        }\n' +
                '        for ( const { key, accepted, discarded } of lists ) {\n' +
                '            if ( Object.hasOwn(µb.availableFilterLists, key) === false ) { continue; }\n' +
                '            const [ netAccepted, netDiscarded ] = counts[key] || [ 0, 0 ];\n' +
                '            const entry = µb.availableFilterLists[key];\n' +
                '            entry.entryCount = accepted + netAccepted;\n' +
                '            entry.entryUsedCount = entry.entryCount - (discarded + netDiscarded);\n' +
                '        }\n' +
                '    };\n',
            ],
            [
                '        staticExtFilteringEngine.reset();\n' +
                '        staticNetFilteringEngine.reset();\n' +
                '        µb.selfieManager.destroy();\n',
                '        staticExtFilteringEngine.reset();\n' +
                '        staticNetFilteringEngine.reset();\n' +
                '        // [uBlock-UXP] tools/uxp-patches.mjs\n' +
                '        networkLists.length = 0;\n' +
                '        µb.selfieManager.destroy();\n',
            ],
            [
                '            if ( µb.inMemoryFiltersCompiled !== \'\' ) {\n' +
                '                toLoad.push(\n' +
                '                    µb.applyCompiledFilters(µb.inMemoryFiltersCompiled, true)\n' +
                '                );\n' +
                '            }\n',
                '            if ( µb.inMemoryFiltersCompiled !== \'\' ) {\n' +
                '                // [uBlock-UXP] tools/uxp-patches.mjs\n' +
                '                µb.applyCompiledFilters(µb.inMemoryFiltersCompiled, true, false);\n' +
                '                networkLists.push({\n' +
                '                    key: \'in-memory\',\n' +
                '                    compiled: µb.inMemoryFiltersCompiled,\n' +
                '                    accepted: 0,\n' +
                '                    discarded: 0,\n' +
                '                });\n' +
                '            }\n',
            ],
            [
                'µb.applyCompiledFilters = function(rawText, firstparty) {\n' +
                '    if ( rawText === \'\' ) { return; }\n' +
                '    const reader = new CompiledListReader(rawText);\n' +
                '    staticNetFilteringEngine.fromCompiled(reader);\n',
                '// [uBlock-UXP] tools/uxp-patches.mjs: withNetwork false leaves the\n' +
                '// network filters to loadFilterLists(), which builds that engine in a\n' +
                '// worker.\n' +
                'µb.applyCompiledFilters = function(rawText, firstparty, withNetwork = true) {\n' +
                '    if ( rawText === \'\' ) { return; }\n' +
                '    const reader = new CompiledListReader(rawText);\n' +
                '    if ( withNetwork ) {\n' +
                '        staticNetFilteringEngine.fromCompiled(reader);\n' +
                '    }\n',
            ],
        ],
    },
];

// The patches applied to the package at `des`; throws, naming the file and
// the edit, if one doesn't apply.
export const applyPatches = function(des) {
    const applied = [];
    for ( const { file, edits } of PATCHES ) {
        const filePath = path.join(des, file);
        let text = fs.readFileSync(filePath, 'utf8');
        for ( const [ find, replace ] of edits ) {
            const at = text.indexOf(find);
            if ( at === -1 || text.indexOf(find, at + 1) !== -1 ) {
                throw new Error(`patch for ${file}: ${at === -1 ? 'not found' : 'found more than once'}: ${find.split('\n')[0].trim()}`);
            }
            text = text.slice(0, at) + replace + text.slice(at + find.length);
        }
        fs.writeFileSync(filePath, text);
        applied.push(`${file} (${edits.length} edits)`);
    }
    return applied;
};

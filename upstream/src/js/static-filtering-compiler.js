/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2014-present Raymond Hill

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

    Home: https://github.com/gorhill/uBlock
*/

// [uBlock-UXP] µb.compileFilters()'s loop (storage.js), in a module of its
// own so that the worker which compiles filter lists off the main thread
// (platform/uxp/engine/worker.js) runs the very code the background page
// runs. What the loop read from the background page comes in `options`.

/******************************************************************************/

import * as sfp from './static-filtering-parser.js';

import { CompiledListWriter } from './static-filtering-io.js';
import { LineIterator } from './text-utils.js';
import logger from './logger.js';
import staticExtFilteringEngine from './static-ext-filtering.js';
import staticNetFilteringEngine from './static-net-filtering.js';

/******************************************************************************/

// options:
//   assetKey               the list's key, for the compiled list's name and
//                          for error messages
//   trustedSource          whether the list may use filters requiring trust
//   env                    vAPI.webextFlavor.env
//   canFilterResponseBody  µb.canFilterResponseData
//   trustedTokens          getTrustedTokens() (trusted-tokens.js)
//   compiledMagic          µb.systemSettings.compiledMagic

export function compileFilterList(rawText, options) {
    const writer = new CompiledListWriter();

    // Populate the writer with information potentially useful to the
    // client compilers.
    if ( options.assetKey ) {
        writer.properties.set('name', options.assetKey);
    }
    const assetName = options.assetKey ? options.assetKey : '?';
    const parser = new sfp.AstFilterParser({
        trustedSource: options.trustedSource === true,
        maxTokenLength: staticNetFilteringEngine.MAX_TOKEN_LENGTH,
        nativeCssHas: options.env.includes('native_css_has'),
        canFilterResponseBody: options.canFilterResponseBody,
        trustedTokens: options.trustedTokens,
    });
    const compiler = staticNetFilteringEngine.createCompiler(parser);
    const lineIter = new LineIterator(
        sfp.utils.preparser.prune(rawText, options.env)
    );

    compiler.start(writer);

    while ( lineIter.eot() === false ) {
        let line = lineIter.next();

        while ( line.endsWith(' \\') ) {
            if ( lineIter.peek(4) !== '    ' ) { break; }
            line = line.slice(0, -2).trim() + lineIter.next().trim();
        }

        parser.parse(line);

        if ( parser.isFilter() === false ) { continue; }
        if ( parser.hasError() ) {
            logger.writeOne({
                realm: 'message',
                type: 'error',
                text: `Invalid filter (${assetName}): ${parser.raw}`
            });
            continue;
        }

        if ( parser.isExtendedFilter() ) {
            staticExtFilteringEngine.compile(parser, writer);
            continue;
        }

        if ( parser.isNetworkFilter() === false ) { continue; }

        if ( compiler.compile(parser, writer) ) { continue; }
        if ( compiler.error !== undefined ) {
            logger.writeOne({
                realm: 'message',
                type: 'error',
                text: compiler.error
            });
        }
    }

    compiler.finish(writer);
    parser.finish();

    // https://github.com/uBlockOrigin/uBlock-issues/issues/1365
    //   Embed version into compiled list itself: it is encoded in as the
    //   first digits followed by a whitespace.
    return `${options.compiledMagic}\n` + writer.toString();
}

/******************************************************************************/

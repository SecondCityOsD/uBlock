/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2017-present Raymond Hill

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

'use strict';

/******************************************************************************/

µBlock.scriptletFilteringEngine = (( ) => {
    const api = {},

        µb = µBlock,
        duplicates = new Set(),
        scriptletCache = new µb.MRUCache(32),
        exceptionsRegister = new Set(),
        scriptletsRegister = new Map();

    let scriptletDB = new µb.staticExtFilteringEngine.HostnameBasedDB(),
        acceptedCount = 0,
        discardedCount = 0;

    const ArgListParser = new class {
        constructor(separatorChar = ',', mustQuote = false) {
            this.separatorChar = this.actualSeparatorChar = separatorChar;
            this.separatorCode = this.actualSeparatorCode = separatorChar.charCodeAt(0);
            this.mustQuote = mustQuote;
            this.quoteBeg = 0; this.quoteEnd = 0;
            this.argBeg = 0; this.argEnd = 0;
            this.separatorBeg = 0; this.separatorEnd = 0;
            this.transform = false;
            this.failed = false;
            this.reWhitespaceStart = /^\s+/;
            this.reWhitespaceEnd = /\s+$/;
            this.reOddTrailingEscape = /(?:^|[^\\])(?:\\\\)*\\$/;
            this.reTrailingEscapeChars = /\\+$/;
        }
        nextArg(pattern, beg = 0) {
            const len = pattern.length;
            this.quoteBeg = beg + this.leftWhitespaceCount(pattern.slice(beg));
            this.failed = false;
            const qc = pattern.charCodeAt(this.quoteBeg);
            if ( qc === 0x22 /* " */ || qc === 0x27 /* ' */ || qc === 0x60 /* ` */ ) {
                this.indexOfNextArgSeparator(pattern, qc);
                if ( this.argEnd !== len ) {
                    this.quoteEnd = this.argEnd + 1;
                    this.separatorBeg = this.separatorEnd = this.quoteEnd;
                    this.separatorEnd += this.leftWhitespaceCount(pattern.slice(this.quoteEnd));
                    if ( this.separatorEnd === len ) { return this; }
                    if ( pattern.charCodeAt(this.separatorEnd) === this.separatorCode ) {
                        this.separatorEnd += 1;
                        return this;
                    }
                }
            }
            this.indexOfNextArgSeparator(pattern, this.separatorCode);
            this.separatorBeg = this.separatorEnd = this.argEnd;
            if ( this.separatorBeg < len ) {
                this.separatorEnd += 1;
            }
            this.argEnd -= this.rightWhitespaceCount(pattern.slice(0, this.separatorBeg));
            this.quoteEnd = this.argEnd;
            if ( this.mustQuote ) {
                this.failed = true;
            }
            return this;
        }
        normalizeArg(s, char = '') {
            if ( char === '' ) { char = this.actualSeparatorChar; }
            let out = '';
            let pos = 0;
            while ( (pos = s.lastIndexOf(char)) !== -1 ) {
                out = s.slice(pos) + out;
                s = s.slice(0, pos);
                const match = this.reTrailingEscapeChars.exec(s);
                if ( match === null ) { continue; }
                const tail = (match[0].length & 1) !== 0
                    ? match[0].slice(0, -1)
                    : match[0];
                out = tail + out;
                s = s.slice(0, -match[0].length);
            }
            if ( out === '' ) { return s; }
            return s + out;
        }
        leftWhitespaceCount(s) {
            const match = this.reWhitespaceStart.exec(s);
            return match === null ? 0 : match[0].length;
        }
        rightWhitespaceCount(s) {
            const match = this.reWhitespaceEnd.exec(s);
            return match === null ? 0 : match[0].length;
        }
        indexOfNextArgSeparator(pattern, separatorCode) {
            this.argBeg = this.argEnd = separatorCode !== this.separatorCode
                ? this.quoteBeg + 1
                : this.quoteBeg;
            this.transform = false;
            if ( separatorCode !== this.actualSeparatorCode ) {
                this.actualSeparatorCode = separatorCode;
                this.actualSeparatorChar = String.fromCharCode(separatorCode);
            }
            while ( this.argEnd < pattern.length ) {
                const pos = pattern.indexOf(this.actualSeparatorChar, this.argEnd);
                if ( pos === -1 ) {
                    return (this.argEnd = pattern.length);
                }
                if ( this.reOddTrailingEscape.test(pattern.slice(0, pos)) === false ) {
                    return (this.argEnd = pos);
                }
                this.transform = true;
                this.argEnd = pos + 1;
            }
        }
    }();


    const lookupScriptlet = (raw, reng, toInject) => {
        if ( toInject.has(raw) ) { return; }
        if ( scriptletCache.resetTime < reng.modifyTime ) {
            scriptletCache.reset();
        }
        let content = scriptletCache.lookup(raw);
        if ( content === undefined ) {
            let token, args;
            const pos = raw.indexOf(',');
            if ( pos === -1 ) {
                token = raw;
            } else {
                token = raw.slice(0, pos).trim();
                args = raw.slice(pos + 1).trim();
            }
            if ( !token.endsWith('.js') ) {
                token += '.js';
            }
            content = reng.resourceContentFromName(token, 'application/javascript');
            if ( !content ) { return; }
            const argList = [];
            if ( args ) {
                let i = 0;
                const argsEnd = args.length;
                do {
                    const details = ArgListParser.nextArg(args, i);
                    let arg = args.slice(details.argBeg, details.argEnd);
                    if ( details.transform ) {
                        arg = ArgListParser.normalizeArg(arg);
                    }
                    argList.push(arg);
                    i = details.separatorEnd;
                } while ( i < argsEnd )
            }
            content = patchScriptlet(content, argList);
            content =
                'try {\n' +
                    content + '\n' +
                '} catch ( e ) { }';
            scriptletCache.add(raw, content);
        }
        toInject.set(raw, content);
    };

    // Fill-in scriptlet argument placeholders.
    const patchScriptlet = (content, argList) => {
        if ( content.startsWith('function') && content.endsWith('}') ) {
            content = `(${content})({{args}});`;
        }
        for ( let i = 0; i < argList.length; i++ ) {
            content = content.replace(`{{${i+1}}}`, argList[i]);
        }
        return content.replace('{{args}}',
            JSON.stringify(argList).slice(1,-1).replace(/\$/g, '$$$')
        );
    };

    const logOne = (isException, token, details) => {
        µb.logger.writeOne(
            details.tabId,
            'cosmetic',
            {
                source: 'cosmetic',
                raw: (isException ? '#@#' : '##') + '+js(' + token + ')'
            },
            'dom',
            details.url,
            null,
            details.hostname
        );
    };

    api.reset = function() {
        scriptletDB.clear();
        duplicates.clear();
        acceptedCount = 0;
        discardedCount = 0;
    };

    api.freeze = function() {
        duplicates.clear();
    };

    api.compile = function(parsed, writer) {
        // 1001 = scriptlet injection
        writer.select(1001);

        // Only exception filters are allowed to be global.

        if ( parsed.hostnames.length === 0 ) {
            if ( parsed.exception ) {
                writer.push([ 32, '!', '', parsed.suffix ]);
            }
            return;
        }

        // https://github.com/gorhill/uBlock/issues/3375
        //   Ignore instances of exception filter with negated hostnames,
        //   because there is no way to create an exception to an exception.

        let µburi = µb.URI;

        for ( let hostname of parsed.hostnames ) {
            let negated = hostname.charCodeAt(0) === 0x7E /* '~' */;
            if ( negated ) {
                hostname = hostname.slice(1);
            }
            let hash = µburi.domainFromHostname(hostname);
            if ( parsed.exception ) {
                if ( negated ) { continue; }
                hash = '!' + hash;
            } else if ( negated ) {
                hash = '!' + hash;
            }
            writer.push([ 32, hash, hostname, parsed.suffix ]);
        }
    };

    // 01234567890123456789
    // +js(token[, arg[, ...]])
    //     ^                 ^
    //     4                -1

    api.fromCompiledContent = function(reader) {
        // 1001 = scriptlet injection
        reader.select(1001);

        while ( reader.next() ) {
            acceptedCount += 1;
            let fingerprint = reader.fingerprint();
            if ( duplicates.has(fingerprint) ) {
                discardedCount += 1;
                continue;
            }
            duplicates.add(fingerprint);
            let args = reader.args();
            if ( args.length < 4 ) { continue; }
            scriptletDB.add(
                args[1],
                { hostname: args[2], token: args[3].slice(4, -1) }
            );
        }
    };

    api.retrieve = function(request) {
        if ( scriptletDB.size === 0 ) { return; }
        if ( µb.hiddenSettings.ignoreScriptInjectFilters ) { return; }

        var reng = µb.redirectEngine;
        if ( !reng ) { return; }

        var hostname = request.hostname;

        // https://github.com/gorhill/uBlock/issues/2835
        //   Do not inject scriptlets if the site is under an `allow` rule.
        if (
            µb.userSettings.advancedUserEnabled &&
            µb.sessionFirewall.evaluateCellZY(hostname, hostname, '*') === 2
        ) {
            return;
        }

        var domain = request.domain,
            entity = request.entity,
            entries, entry;

        entries = [];
        if ( domain !== '' ) {
            scriptletDB.retrieve(domain, hostname, entries);
            scriptletDB.retrieve(entity, entity, entries);
        }
        scriptletDB.retrieve('', hostname, entries);
        for ( entry of entries ) {
            lookupScriptlet(entry.token, reng, scriptletsRegister);
        }

        if ( scriptletsRegister.size === 0 ) { return; }

        // Collect exception filters.
        entries.length = 0;
        if ( domain !== '' ) {
            scriptletDB.retrieve('!' + domain, hostname, entries);
            scriptletDB.retrieve('!' + entity, entity, entries);
        }
        scriptletDB.retrieve('!', hostname, entries);
        for ( entry of entries ) {
            exceptionsRegister.add(entry.token);
        }

        // Return an array of scriptlets, and log results if needed.
        var out = [],
            logger = µb.logger.isEnabled() ? µb.logger : null,
            isException;
        for ( entry of scriptletsRegister ) {
            if ( (isException = exceptionsRegister.has(entry[0])) === false ) {
                out.push(entry[1]);
            }
            if ( logger !== null ) {
                logOne(isException, entry[0], request);
            }
        }

        scriptletsRegister.clear();
        exceptionsRegister.clear();

        if ( out.length === 0 ) { return; }

        return out.join('\n');
    };

    api.toSelfie = function() {
        return scriptletDB.toSelfie();
    };

    api.fromSelfie = function(selfie) {
        scriptletDB = new µb.staticExtFilteringEngine.HostnameBasedDB(selfie);
    };

    Object.defineProperties(api, {
        acceptedCount: {
            get: function() {
                return acceptedCount;
            }
        },
        discardedCount: {
            get: function() {
                return discardedCount;
            }
        }
    });

    return api;
})();

/******************************************************************************/

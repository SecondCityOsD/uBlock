/*******************************************************************************

    uBlock Origin for UXP - build-time rewrites for UXP's JavaScript engine
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

// Rewrites applied to the package's copy of upstream's code (upstream/
// itself stays as published), for constructs UXP's JavaScript engine runs
// far slower than Firefox's (a call through `super`, some 1000 times). A
// rewrite keeps the code's behavior exactly, and applies only where the
// source alone shows that; any other occurrence is left as it is, and
// reported.
//
// - A call through `super`, `super.name(args)` in a class method, runs
//   about 1000 times slower than the same call made by name. It becomes
//   `Parent.name.call(this, args)` in a static method,
//   `Parent.prototype.name.call(this, args)` in an instance method, where
//   `Parent` is the identifier the class extends.

import { parse } from 'acorn';

const PARSE_OPTIONS = { ecmaVersion: 'latest', allowHashBang: true, locations: true };

// Content scripts are plain scripts, uBO's own pages and background load
// modules.
const parseSource = function(source) {
    try {
        return { ast: parse(source, { ...PARSE_OPTIONS, sourceType: 'module' }), sourceType: 'module' };
    } catch {
        return { ast: parse(source, { ...PARSE_OPTIONS, sourceType: 'script' }), sourceType: 'script' };
    }
};

const isNode = value => value !== null && typeof value === 'object' && typeof value.type === 'string';

const childNodes = function(node) {
    const out = [];
    for ( const [ key, value ] of Object.entries(node) ) {
        if ( key === 'loc' ) { continue; }
        if ( Array.isArray(value) ) {
            for ( const item of value ) {
                if ( isNode(item) ) { out.push(item); }
            }
        } else if ( isNode(value) ) {
            out.push(value);
        }
    }
    return out;
};

const patternNames = function(pattern, out) {
    if ( pattern === null ) { return out; }
    switch ( pattern.type ) {
    case 'Identifier': out.push(pattern.name); break;
    case 'AssignmentPattern': patternNames(pattern.left, out); break;
    case 'RestElement': patternNames(pattern.argument, out); break;
    case 'ArrayPattern': for ( const item of pattern.elements ) { patternNames(item, out); } break;
    case 'ObjectPattern':
        for ( const prop of pattern.properties ) {
            patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
        }
        break;
    }
    return out;
};

// Every name a method's own code declares, at any depth: if the class's
// parent is among them, `Parent` there might not be the parent.
const declaredNames = function(root) {
    const names = new Set();
    const visit = node => {
        switch ( node.type ) {
        case 'VariableDeclarator':
            for ( const name of patternNames(node.id, []) ) { names.add(name); }
            break;
        case 'FunctionDeclaration':
        case 'ClassDeclaration':
            if ( node.id !== null ) { names.add(node.id.name); }
            break;
        case 'CatchClause':
            for ( const name of patternNames(node.param, []) ) { names.add(name); }
            break;
        }
        if ( node.type.includes('Function') ) {
            for ( const param of node.params ) {
                for ( const name of patternNames(param, []) ) { names.add(name); }
            }
        }
        for ( const child of childNodes(node) ) { visit(child); }
    };
    visit(root);
    return names;
};

// Names the code assigns to: a class bound to one of them may have been
// replaced since its subclasses were defined.
const assignedNames = function(root) {
    const names = new Set();
    const visit = node => {
        if ( node.type === 'AssignmentExpression' ) {
            for ( const name of patternNames(node.left, []) ) { names.add(name); }
        } else if ( node.type === 'UpdateExpression' && node.argument.type === 'Identifier' ) {
            names.add(node.argument.name);
        }
        for ( const child of childNodes(node) ) { visit(child); }
    };
    visit(root);
    return names;
};

// The rewrite of `super.name(args)`. The result: { code, rewritten, kept },
// kept listing the `super` uses left as they are, with why.
export const rewriteSuperCalls = function(source) {
    const { ast, sourceType } = parseSource(source);
    const reassigned = assignedNames(ast);
    const edits = [];
    const kept = [];
    let rewritten = 0;

    const keep = (node, reason) => {
        kept.push({ line: node.loc.start.line, reason });
    };

    // context: the class method `super` refers to, or why it can't be
    // rewritten there.
    const visit = (node, context) => {
        if ( node.type === 'ClassDeclaration' || node.type === 'ClassExpression' ) {
            if ( node.superClass !== null ) { visit(node.superClass, context); }
            const parent = node.superClass !== null && node.superClass.type === 'Identifier'
                ? node.superClass.name
                : null;
            for ( const member of node.body.body ) {
                if ( member.type !== 'MethodDefinition' ) {
                    visit(member, { reason: 'class field or static block' });
                    continue;
                }
                if ( member.computed ) { visit(member.key, context); }
                let memberContext;
                if ( parent === null ) {
                    memberContext = { reason: node.superClass === null ? 'class extends nothing' : 'class extends an expression' };
                } else if ( member.kind === 'constructor' ) {
                    memberContext = { reason: 'constructor' };
                } else if ( reassigned.has(parent) ) {
                    memberContext = { reason: `${parent} is assigned to` };
                } else if ( declaredNames(member.value).has(parent) ) {
                    memberContext = { reason: `${parent} is redeclared in the method` };
                } else {
                    memberContext = { parent, isStatic: member.static };
                }
                visit(member.value, memberContext);
            }
            return;
        }
        // Object literal methods: `super` is the object's prototype.
        if ( node.type === 'Property' && (node.method || node.kind !== 'init') ) {
            if ( node.computed ) { visit(node.key, context); }
            visit(node.value, { reason: 'object literal method' });
            return;
        }
        if ( node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
             node.callee.object.type === 'Super' ) {
            const { callee } = node;
            if ( context.parent === undefined ) {
                keep(node, context.reason);
            } else if ( callee.computed || callee.optional || node.optional ) {
                keep(node, 'computed or optional call');
            } else {
                const target = context.isStatic
                    ? `${context.parent}.${callee.property.name}`
                    : `${context.parent}.prototype.${callee.property.name}`;
                edits.push({ start: callee.start, end: callee.end, text: `${target}.call` });
                const first = node.arguments[0];
                if ( first === undefined ) {
                    edits.push({ start: node.end - 1, end: node.end - 1, text: 'this' });
                } else {
                    edits.push({ start: first.start, end: first.start, text: 'this, ' });
                }
                rewritten += 1;
            }
            for ( const arg of node.arguments ) { visit(arg, context); }
            return;
        }
        if ( node.type === 'MemberExpression' && node.object.type === 'Super' ) {
            keep(node, 'not a call');
            if ( node.computed ) { visit(node.property, context); }
            return;
        }
        for ( const child of childNodes(node) ) { visit(child, context); }
    };
    visit(ast, { reason: 'outside any method' });

    // Right to left, the longer edit first where two start together: an
    // insertion before a rewritten callee lands in front of it.
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    let code = source;
    for ( const edit of edits ) {
        code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
    }
    if ( rewritten !== 0 ) {
        parse(code, { ...PARSE_OPTIONS, sourceType });
    }
    return { code, rewritten, kept };
};

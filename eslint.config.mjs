/*******************************************************************************

    uBlock Origin for UXP - ESLint configuration
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

// Lints the code written here, platform/uxp/ and tools/, with upstream uBO's
// own rules (upstream/eslint.config.mjs). upstream/ is uBO's to lint.
//
// Usage: npm run lint

import globals from 'globals';
import js from '@eslint/js';

// Upstream's rules, verbatim.
const upstreamRules = {
    eqeqeq: [ 'warn', 'always' ],
    indent: [ 'error', 4, {
        ignoredNodes: [
            'Program > BlockStatement',
            'Program > ExpressionStatement > CallExpression > ArrowFunctionExpression > BlockStatement',
            'Program > ExpressionStatement > CallExpression > FunctionExpression > BlockStatement',
            'Program > IfStatement > BlockStatement',
            'Program > VariableDeclaration > VariableDeclarator > CallExpression > ArrowFunctionExpression > BlockStatement',
            'CallExpression > MemberExpression',
            'ArrayExpression > *',
            'ObjectExpression > *',
        ],
    } ],
    'no-control-regex': 'off',
    'no-empty': 'off',
    'sort-imports': 'error',
    strict: 'error',
};

// What every privileged script of Gecko gets. Anything else is either
// declared by the script itself (Cu.import(), Cu.importGlobalProperties())
// or shared with the scripts loaded into the same global, which each one
// names in a /* global */ comment.
const chromeGlobals = {
    Components: 'readonly',
};

// Set by the Add-ons Manager in bootstrap.js's scope.
const bootstrapGlobals = {
    APP_STARTUP: 'readonly',
    APP_SHUTDOWN: 'readonly',
    ADDON_ENABLE: 'readonly',
    ADDON_DISABLE: 'readonly',
    ADDON_INSTALL: 'readonly',
    ADDON_UNINSTALL: 'readonly',
    ADDON_UPGRADE: 'readonly',
    ADDON_DOWNGRADE: 'readonly',
};

export default [
    {
        ignores: [ 'upstream/', 'dist/', '.uxp-test/' ],
    },
    {
        files: [ '**/*.js', '**/*.jsm', '**/*.mjs' ],
        ...js.configs.recommended,
    },
    {
        files: [ '**/*.js', '**/*.jsm', '**/*.mjs' ],
        rules: upstreamRules,
    },
    // The add-on: bootstrap.js, the runtime (modules/), the test harness
    // (debug/). Plain scripts, run with chrome privileges, each strict as a
    // whole (upstream's are modules, strict by definition).
    {
        files: [ 'platform/uxp/**/*.js', 'platform/uxp/**/*.jsm' ],
        ignores: [ 'platform/uxp/engine/**' ],
        languageOptions: {
            sourceType: 'script',
            globals: chromeGlobals,
        },
        rules: {
            strict: [ 'error', 'global' ],
        },
    },
    {
        files: [ 'platform/uxp/bootstrap.js' ],
        languageOptions: {
            globals: bootstrapGlobals,
        },
    },
    {
        files: [ 'platform/uxp/**/*.jsm' ],
        languageOptions: {
            globals: { __URI__: 'readonly' },
        },
    },
    // Code that runs as part of uBO's own: modules bundled with uBO's into
    // the package (tools/make-uxp.mjs). worker.js runs in a worker.
    {
        files: [ 'platform/uxp/engine/**/*.js' ],
        languageOptions: {
            sourceType: 'module',
        },
    },
    {
        files: [ 'platform/uxp/engine/worker.js' ],
        languageOptions: {
            globals: globals.worker,
        },
    },
    // Build and test tools, run by Node.
    {
        files: [ 'tools/**/*.mjs', 'eslint.config.mjs' ],
        languageOptions: {
            sourceType: 'module',
            globals: globals.node,
        },
    },
];

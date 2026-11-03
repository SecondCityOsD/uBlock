/*******************************************************************************

    uBlock Origin for UXP - test launcher
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

// Runs a debug build (tools/make-uxp.mjs --debug) in Pale Moon and/or
// Basilisk with a throwaway profile, then prints what the debug harness
// (platform/uxp/debug/harness.js) recorded.
//
// Usage: node tools/uxp-test.mjs [--browser=palemoon|basilisk|all]
//            [--scenario=probe] [--xpi=<path>] [--timeout=<seconds>]
//            [--keep-profile]
//
// Profiles live in .uxp-test/<browser>/profile and are recreated on every
// run unless --keep-profile is given. Browsers start with -no-remote, so
// running instances and real profiles are never touched. Executable paths
// can be overridden with UXP_PALEMOON / UXP_BASILISK.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/******************************************************************************/

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PROFILES = path.join(ROOT, '.uxp-test');

const BROWSERS = {
    palemoon: {
        name: 'Pale Moon',
        exe: process.env.UXP_PALEMOON || 'C:\\Program Files\\Pale Moon\\palemoon.exe',
    },
    basilisk: {
        name: 'Basilisk',
        exe: process.env.UXP_BASILISK || 'C:\\Program Files\\Basilisk\\basilisk.exe',
    },
};

const ADDON_ID = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'upstream', 'platform', 'firefox', 'manifest.json'), 'utf8')
).browser_specific_settings.gecko.id;

// Quiet, deterministic startup: no first-run pages, no update checks, no
// prompts, sideloaded add-ons enabled without confirmation.
const BASE_PREFS = {
    'app.update.enabled': false,
    'app.update.auto': false,
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.page': 0,
    'browser.startup.homepage': 'about:blank',
    'browser.startup.homepage_override.mstone': 'ignore',
    'startup.homepage_welcome_url': '',
    'startup.homepage_override_url': '',
    'browser.sessionstore.resume_from_crash': false,
    'toolkit.startup.max_resumed_crashes': -1,
    'browser.tabs.warnOnClose': false,
    'browser.warnOnQuit': false,
    'browser.safebrowsing.enabled': false,
    'browser.safebrowsing.malware.enabled': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'general.warnOnAboutConfig': false,
    'extensions.autoDisableScopes': 0,
    'extensions.enabledScopes': 15,
    'extensions.update.enabled': false,
    'extensions.update.autoUpdateDefault': false,
    'extensions.getAddons.cache.enabled': false,
    'extensions.blocklist.enabled': false,
    'extensions.showMismatchUI': false,
    'extensions.logging.enabled': true,
    'devtools.chrome.enabled': true,
    'javascript.options.showInConsole': true,
};

/******************************************************************************/

const parseArgs = function() {
    const options = {
        browser: 'all',
        scenario: 'probe',
        xpi: '',
        timeout: 300,
        keepProfile: false,
    };
    for ( const arg of process.argv.slice(2) ) {
        const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
        if ( match === null ) { throw new Error(`unknown argument: ${arg}`); }
        const [ , name, value ] = match;
        switch ( name ) {
        case 'browser': options.browser = value; break;
        case 'scenario': options.scenario = value; break;
        case 'xpi': options.xpi = path.resolve(value); break;
        case 'timeout': options.timeout = parseInt(value, 10); break;
        case 'keep-profile': options.keepProfile = true; break;
        default: throw new Error(`unknown argument: ${arg}`);
        }
    }
    return options;
};

const latestDebugXPI = function() {
    const candidates = fs.existsSync(DIST)
        ? fs.readdirSync(DIST).filter(name => name.endsWith('.uxp-debug.xpi'))
        : [];
    if ( candidates.length === 0 ) {
        throw new Error('no debug build in dist/ -- run: node tools/make-uxp.mjs --debug');
    }
    return candidates
        .map(name => path.join(DIST, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
};

// The `update` scenario checks the update manifest a release build
// (make-uxp.mjs without --debug) wrote next to its XPI, for the release of
// the version under test. The XPI's hash is computed here, independently.
const updateScenarioPrefs = function(xpi) {
    const match = /^uBlock0_(.+)\.uxp-debug\.xpi$/.exec(path.basename(xpi));
    const version = match !== null ? match[1] : null;
    const file = `uBlock0_${version}.uxp.xpi`;
    const release = path.join(DIST, file);
    const manifest = path.join(DIST, 'update.rdf');
    if ( version === null || fs.existsSync(release) === false || fs.existsSync(manifest) === false ) {
        throw new Error(`no release build for ${path.basename(xpi)} in dist/ -- run: node tools/make-uxp.mjs`);
    }
    const hash = createHash('sha256').update(fs.readFileSync(release)).digest('hex');
    return {
        'extensions.ublock0.uxpTest.updateManifest': manifest,
        'extensions.ublock0.uxpTest.updateExpected': JSON.stringify({ version, file, hash: `sha256:${hash}` }),
    };
};

const writeUserJS = function(profileDir, prefs) {
    const lines = Object.entries(prefs).map(([ name, value ]) =>
        `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`
    );
    fs.writeFileSync(path.join(profileDir, 'user.js'), lines.join('\n') + '\n');
};

const prepareProfile = function(key, xpi, options) {
    const profileDir = path.join(PROFILES, key, 'profile');
    if ( options.keepProfile === false ) {
        fs.rmSync(profileDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(profileDir, 'extensions'), { recursive: true });
    fs.rmSync(path.join(profileDir, 'uxp-test'), { recursive: true, force: true });
    writeUserJS(profileDir, {
        ...BASE_PREFS,
        ...options.scenarioPrefs,
        'extensions.ublock0.uxpTest.scenario': options.scenario,
        'extensions.ublock0.uxpTest.autoQuit': true,
    });
    fs.copyFileSync(xpi, path.join(profileDir, 'extensions', `${ADDON_ID}.xpi`));
    return profileDir;
};

const killTree = function(child) {
    try {
        if ( process.platform === 'win32' ) {
            execFileSync('taskkill', [ '/PID', String(child.pid), '/T', '/F' ], { stdio: 'ignore' });
        } else {
            child.kill('SIGKILL');
        }
    } catch {
    }
};

// Resolves with 'done' (harness finished), 'exited' (browser quit without
// finishing) or 'timeout'.
const waitForRun = function(child, doneFile, timeoutMs) {
    return new Promise(resolve => {
        let exited = false;
        child.on('exit', ( ) => { exited = true; });
        const started = Date.now();
        const tick = ( ) => {
            if ( fs.existsSync(doneFile) ) { return resolve('done'); }
            if ( exited ) { return resolve('exited'); }
            if ( Date.now() - started > timeoutMs ) { return resolve('timeout'); }
            setTimeout(tick, 250);
        };
        tick();
    });
};

const waitForExit = function(child, timeoutMs) {
    return new Promise(resolve => {
        if ( child.exitCode !== null ) { return resolve(true); }
        const timer = setTimeout(( ) => { resolve(false); }, timeoutMs);
        child.on('exit', ( ) => {
            clearTimeout(timer);
            resolve(true);
        });
    });
};

/******************************************************************************/

const printSummary = function(summary, indent = '  ') {
    for ( const [ key, value ] of Object.entries(summary) ) {
        if ( Array.isArray(value) ) {
            console.log(`${indent}${key}: ${value.length === 0 ? '(none)' : ''}`);
            for ( const item of value ) {
                console.log(`${indent}  - ${typeof item === 'string' ? item : JSON.stringify(item)}`);
            }
        } else if ( value instanceof Object ) {
            console.log(`${indent}${key}: ${JSON.stringify(value)}`);
        } else {
            console.log(`${indent}${key}: ${value}`);
        }
    }
};

const countConsole = function(file) {
    if ( fs.existsSync(file) === false ) { return null; }
    const text = fs.readFileSync(file, 'utf8');
    // Skip what was logged before the add-on started.
    const ownPart = text.slice(text.indexOf('--- end of earlier messages ---'));
    return {
        errors: (ownPart.match(/ \[error\] /g) || []).length,
        warnings: (ownPart.match(/ \[warn\] /g) || []).length,
    };
};

const runBrowser = async function(key, xpi, options) {
    const browser = BROWSERS[key];
    if ( fs.existsSync(browser.exe) === false ) {
        console.log(`== ${browser.name}: not found at ${browser.exe} (skipped)`);
        return true;
    }
    const profileDir = prepareProfile(key, xpi, options);
    const outDir = path.join(profileDir, 'uxp-test');
    const started = Date.now();
    const child = spawn(browser.exe, [ '-no-remote', '-profile', profileDir, 'about:blank' ], {
        stdio: 'ignore',
        env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: '1' },
    });
    const outcome = await waitForRun(child, path.join(outDir, 'done'), options.timeout * 1000);
    if ( outcome === 'done' && await waitForExit(child, 15000) === false ) {
        killTree(child);
    } else if ( outcome === 'timeout' ) {
        killTree(child);
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`== ${browser.name}: ${outcome} after ${seconds} s`);
    const resultFile = path.join(outDir, `${options.scenario}.json`);
    let ok = outcome === 'done';
    if ( fs.existsSync(resultFile) ) {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        if ( result.error ) {
            ok = false;
            console.log(`  harness error: ${result.error}`);
        }
        if ( result.summary ) {
            printSummary(result.summary);
        }
        console.log(`  full report: ${path.relative(ROOT, resultFile)}`);
    }
    const consoleFile = path.join(outDir, 'console.log');
    const counts = countConsole(consoleFile);
    if ( counts !== null ) {
        console.log(`  console: ${counts.errors} errors, ${counts.warnings} warnings -- ${path.relative(ROOT, consoleFile)}`);
    } else {
        console.log('  console: no log written (add-on did not start?)');
    }
    return ok;
};

/******************************************************************************/

const main = async ( ) => {
    const options = parseArgs();
    const xpi = options.xpi || latestDebugXPI();
    options.scenarioPrefs = options.scenario === 'update' ? updateScenarioPrefs(xpi) : {};
    const keys = options.browser === 'all' ? Object.keys(BROWSERS) : [ options.browser ];
    for ( const key of keys ) {
        if ( BROWSERS[key] === undefined ) { throw new Error(`unknown browser: ${key}`); }
    }
    console.log(`Testing ${path.relative(ROOT, xpi)} -- scenario "${options.scenario}"`);
    let ok = true;
    for ( const key of keys ) {
        ok = await runBrowser(key, xpi, options) && ok;
    }
    process.exitCode = ok ? 0 : 1;
};

main().catch(reason => {
    console.error(reason);
    process.exitCode = 1;
});

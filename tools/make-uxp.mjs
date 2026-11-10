/*******************************************************************************

    uBlock Origin for UXP - build script
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

// Assembles dist/uBlock0_<version>.uxp.xpi from:
//   upstream/      uBlock Origin's release tree, with our changes to its code
//                  marked [uBlock-UXP] (see PRISTINE_COMMIT)
//   platform/uxp/  the WebExtension runtime for UXP, and the worker that
//                  builds uBO's network filtering engine (engine/)
//
// The upstream steps mirror upstream's own Firefox build, so the package
// holds what uBO's Firefox XPI holds, plus the UXP overlay:
//   tools/copy-common-files.sh, tools/make-firefox.sh,
//   tools/make-firefox-meta.py, tools/make-assets.sh
// Constructs UXP's JavaScript engine runs far slower than Firefox's are
// rewritten in the package's copy, behavior unchanged (tools/uxp-compat.mjs),
// and the engine's worker is bundled with that copy of uBO's modules into
// js/uxp-engine-worker.js.
//
// A release build also writes dist/update.rdf, the update manifest that
// offers it: committed at the repository's root, it is what installs check
// (em:updateURL), the XPI being the asset of the GitHub release tagged with
// its em:version.
//
// Usage: node tools/make-uxp.mjs [--debug] [--no-assets] [--refresh-assets]
//            [--pristine]
//   --debug           include the test harness (platform/uxp/debug/)
//   --no-assets       don't bundle filter lists (uBO fetches them at runtime)
//   --refresh-assets  re-download the bundled filter lists
//   --pristine        build uBO's code as released, without our changes, to
//                     compare (debug builds only)

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { rewriteSuperCalls } from './uxp-compat.mjs';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';

/******************************************************************************/

// em:version is the upstream version, then .<UXP_REVISION> for the port's
// own releases of that upstream version: 1.76.0, 1.76.0.1, 1.76.0.2...
// (0 for a new upstream version). manifest.json keeps the plain upstream
// version: uBO treats any version not matching \d+.\d+.\d+ exactly as a dev
// build (vapi-common.js), which changes its behavior.
const UXP_REVISION = 0;

// Not legacy uBO's `ublock0`: both may be registered at once. bootstrap.js
// loads the runtime from it.
const CHROME_PACKAGE = 'ublock-uxp';

const TARGET_APPLICATIONS = [
    {   // Pale Moon
        id: '{8de7fcbb-c55c-4fbe-bfc5-fc555c87dbc4}',
        minVersion: '35.0',
        maxVersion: '35.*',
    },
    {   // Basilisk: Firefox GUID, em:basilisk marks a Basilisk-aware add-on
        id: '{ec8030f7-c20a-464f-9b0e-13a3a9e97384}',
        minVersion: '52.9.2026',
        maxVersion: '52.9.*',
        basilisk: true,
    },
];

// The fork's own identity, not uBO's: legacy uBO 1.16 (uBlock0@raymondhill.net)
// may be installed beside it, and each must stay its own add-on. uBO's
// authors stay credited (em:contributor).
const ADDON_ID = 'ublock@sinfulosd';
const AUTHOR = 'SinfulOsD';

// Releases are published on GitHub: the update manifest is served from the
// release branch, each XPI is an asset of the GitHub release tagged with its
// em:version.
const REPOSITORY = 'SecondCityOsD/uBlock';
const RELEASE_BRANCH = 'main';
const HOMEPAGE_URL = `https://github.com/${REPOSITORY}`;
const UPDATE_URL = `https://raw.githubusercontent.com/${REPOSITORY}/${RELEASE_BRANCH}/update.rdf`;
const releaseAssetURL = (emVersion, file) =>
    `https://github.com/${REPOSITORY}/releases/download/${emVersion}/${file}`;

// Filter lists shipped in the package so a fresh install filters before its
// first list update. Same set as upstream's tools/make-assets.sh.
const UASSETS_PROD = 'https://ublockorigin.github.io/uAssets/';
const UASSETS_MAIN = 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/';
const BUNDLED_ASSETS = [
    [ 'ublock/badlists.txt', `${UASSETS_PROD}filters/badlists.txt` ],
    [ 'ublock/badware.min.txt', `${UASSETS_PROD}filters/badware.min.txt` ],
    [ 'ublock/filters.min.txt', `${UASSETS_PROD}filters/filters.min.txt` ],
    [ 'ublock/privacy.min.txt', `${UASSETS_PROD}filters/privacy.min.txt` ],
    [ 'ublock/quick-fixes.min.txt', `${UASSETS_PROD}filters/quick-fixes.min.txt` ],
    [ 'ublock/unbreak.min.txt', `${UASSETS_PROD}filters/unbreak.min.txt` ],
    [ 'thirdparties/easylist/easylist.txt', `${UASSETS_PROD}thirdparties/easylist.txt` ],
    [ 'thirdparties/easylist/easyprivacy.txt', `${UASSETS_PROD}thirdparties/easyprivacy.txt` ],
    [ 'thirdparties/pgl.yoyo.org/as/serverlist', `${UASSETS_MAIN}thirdparties/pgl.yoyo.org/as/serverlist` ],
    [ 'thirdparties/publicsuffix.org/list/effective_tld_names.dat', `${UASSETS_MAIN}thirdparties/publicsuffix.org/list/effective_tld_names.dat` ],
    [ 'thirdparties/urlhaus-filter/urlhaus-filter-online.txt', `${UASSETS_MAIN}thirdparties/urlhaus-filter/urlhaus-filter-online.txt` ],
];

/******************************************************************************/

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = path.join(ROOT, 'upstream');
const PLATFORM = path.join(ROOT, 'platform', 'uxp');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(DIST, 'build', 'uBlock0.uxp');
const ASSETS_CACHE = path.join(DIST, 'uAssets-cache');

// The commit that imported upstream/ as uBO released it. Our changes to its
// code came after, each marked [uBlock-UXP]. A new release of uBO is
// imported over this commit, on a branch of its own (upstream/ replaced by
// `git -c core.autocrlf=false archive` of the release's tag, without its
// submodules), merged, and becomes the new PRISTINE_COMMIT.
const PRISTINE_COMMIT = 'c18511d5299cfcf1b7ad081a10e2550a87dec873';
const CHANGE_MARK = '[uBlock-UXP]';

/******************************************************************************/

const copyDir = (from, to) => {
    fs.cpSync(from, to, { recursive: true });
};

// Copy the files directly inside `fromDir` whose name matches `re`.
const copyMatching = (fromDir, re, toDir) => {
    fs.mkdirSync(toDir, { recursive: true });
    for ( const entry of fs.readdirSync(fromDir, { withFileTypes: true }) ) {
        if ( entry.isFile() === false || re.test(entry.name) === false ) { continue; }
        fs.copyFileSync(path.join(fromDir, entry.name), path.join(toDir, entry.name));
    }
};

const sortKeysDeep = value => {
    if ( Array.isArray(value) ) { return value.map(sortKeysDeep); }
    if ( value instanceof Object === false ) { return value; }
    const out = {};
    for ( const key of Object.keys(value).sort() ) {
        out[key] = sortKeysDeep(value[key]);
    }
    return out;
};

const escapeXML = s => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/******************************************************************************/

// upstream/ as of PRISTINE_COMMIT, extracted once into dist/.
const pristineUpstream = ( ) => {
    const des = path.join(DIST, `pristine-${PRISTINE_COMMIT.slice(0, 12)}`);
    if ( fs.existsSync(des) ) { return path.join(des, 'upstream'); }
    const tmp = `${des}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    // Relative paths: the GNU tar of Git for Windows takes "D:" for a host.
    const run = (cwd, command, args) => {
        const result = spawnSync(command, args, {
            cwd,
            encoding: 'utf8',
            stdio: [ 'ignore', 'ignore', 'pipe' ],
        });
        if ( result.status !== 0 ) {
            throw new Error(`${command} ${args.join(' ')}: ${result.error || result.stderr.trim()}`);
        }
    };
    run(ROOT, 'git', [ 'archive', '--format=tar', `--output=${path.relative(ROOT, tmp)}/upstream.tar`, PRISTINE_COMMIT, 'upstream' ]);
    run(tmp, 'tar', [ '-xf', 'upstream.tar' ]);
    fs.rmSync(path.join(tmp, 'upstream.tar'));
    fs.renameSync(tmp, des);
    return path.join(des, 'upstream');
};

// tools/copy-common-files.sh + tools/make-firefox.sh
const assembleUpstream = (des, upstream) => {
    const src = path.join(upstream, 'src');
    copyDir(path.join(src, 'css'), path.join(des, 'css'));
    copyDir(path.join(src, 'img'), path.join(des, 'img'));
    copyMatching(path.join(src, 'js'), /\.js$/, path.join(des, 'js'));
    for ( const dir of [ 'resources', 'codemirror', 'scriptlets', 'wasm' ] ) {
        copyDir(path.join(src, 'js', dir), path.join(des, 'js', dir));
    }
    copyDir(path.join(src, 'lib'), path.join(des, 'lib'));
    copyDir(path.join(src, 'web_accessible_resources'), path.join(des, 'web_accessible_resources'));
    copyDir(path.join(src, '_locales'), path.join(des, '_locales'));
    copyMatching(src, /\.html$/, des);
    copyMatching(path.join(upstream, 'platform', 'common'), /\.js$/, path.join(des, 'js'));
    copyMatching(path.join(upstream, 'platform', 'common'), /\.json$/, des);
    fs.copyFileSync(path.join(upstream, 'LICENSE.txt'), path.join(des, 'LICENSE.txt'));

    // Firefox-specific
    copyMatching(path.join(upstream, 'platform', 'firefox'), /\.json$/, des);
    copyMatching(path.join(upstream, 'platform', 'firefox'), /\.js$/, path.join(des, 'js'));
    copyDir(path.join(des, '_locales', 'nb'), path.join(des, '_locales', 'no'));
    fs.rmSync(path.join(des, 'img', 'icon_128.png'));
};

// The package's files that hold changes to uBO's code, and how many marked
// spots each: what the build log shows of them.
const changedFiles = des => {
    const out = [];
    for ( const rel of listFiles(des) ) {
        if ( rel.endsWith('.js') === false ) { continue; }
        const count = fs.readFileSync(path.join(des, rel), 'utf8').split(CHANGE_MARK).length - 1;
        if ( count !== 0 ) { out.push(`${rel} (${count})`); }
    }
    return out;
};

// tools/uxp-compat.mjs over upstream's scripts, before the UXP overlay. A
// file that can't be rewritten ships as it is: slower, not wrong.
const rewriteForUXP = des => {
    const summary = { rewritten: 0, files: 0, kept: 0, failed: [] };
    for ( const rel of listFiles(des) ) {
        if ( rel.endsWith('.js') === false ) { continue; }
        const file = path.join(des, rel);
        const source = fs.readFileSync(file, 'utf8');
        if ( /\bsuper\b/.test(source) === false ) { continue; }
        let result;
        try {
            result = rewriteSuperCalls(source);
        } catch (ex) {
            summary.failed.push(`${rel}: ${ex.message}`);
            continue;
        }
        summary.kept += result.kept.length;
        if ( result.rewritten === 0 ) { continue; }
        fs.writeFileSync(file, result.code);
        summary.rewritten += result.rewritten;
        summary.files += 1;
    }
    return summary;
};

// The filtering engine's worker: platform/uxp/engine/worker.js and the
// modules it imports from the package's copy of uBO, rewrites included,
// bundled into one plain worker script (UXP has no module workers); its
// imports are relative to the package's root, where it and worker-env.js
// are placed for the time of the bundling. And its page side, which
// storage.js imports.
const ENGINE_WORKER = 'js/uxp-engine-worker.js';
const ENGINE_CLIENT = 'js/uxp-engine.js';

// The modules the worker's modules import that it can't have, and the
// module standing in for each in the bundle (paths relative to the
// package's root): exports of worker-env.js for those of uBO's background
// page, and for the built-in scriptlets, which redirect-engine.js imports
// with import(), which UXP's workers can't even parse; and in place of the
// modules with a top-level await, which a classic script can't have, what
// the worker uses of them.
const WORKER_STAND_INS = new Map([
    [ 'js/background.js', `export { µb as default } from './worker-env.js';` ],
    [ 'js/broadcast.js', `export { onBroadcast } from './worker-env.js';` ],
    [ 'js/logger.js', `export { logger as default } from './worker-env.js';` ],
    [ 'js/resources/scriptlets.js', `export { builtinScriptlets } from './worker-env.js';` ],
    // 1.76: awaits the import of uBO's own list where the browser has no
    // publicSuffix API, as UXP has none.
    [ 'js/publicsuffix.js', `export { default } from './lib/publicsuffixlist/publicsuffixlist.js';` ],
    // 1.76: awaits the fetch of its injection templates; the worker only
    // compiles filters, which the core engine does.
    [ 'js/scriptlet-filtering.js', [
        `import { ScriptletFilteringEngine } from './js/scriptlet-filtering-core.js';`,
        'export default new ScriptletFilteringEngine();',
    ].join('\n') ],
]);

const standInsPlugin = des => ({
    name: 'uxp-engine-stand-ins',
    setup(bundler) {
        bundler.onResolve({ filter: /\.js$/ }, args => {
            if ( args.kind === 'entry-point' ) { return; }
            // uBO's absolute paths are relative to the package's root.
            const resolved = args.path.startsWith('/')
                ? path.join(des, args.path)
                : path.resolve(args.resolveDir, args.path);
            const rel = path.relative(des, resolved).split(path.sep).join('/');
            if ( WORKER_STAND_INS.has(rel) === false ) { return; }
            return { path: rel, namespace: 'uxp-stand-in' };
        });
        bundler.onLoad({ filter: /.*/, namespace: 'uxp-stand-in' }, args => ({
            contents: `${WORKER_STAND_INS.get(args.path)}\n`,
            resolveDir: des,
            loader: 'js',
        }));
    },
});

const addEngine = async des => {
    fs.copyFileSync(path.join(PLATFORM, 'engine', 'client.js'), path.join(des, ENGINE_CLIENT));
    const entry = path.join(des, 'uxp-engine-worker.entry.js');
    const env = path.join(des, 'worker-env.js');
    fs.copyFileSync(path.join(PLATFORM, 'engine', 'worker.js'), entry);
    fs.copyFileSync(path.join(PLATFORM, 'engine', 'worker-env.js'), env);
    try {
        await build({
            absWorkingDir: des,
            entryPoints: [ entry ],
            outfile: path.join(des, ENGINE_WORKER),
            bundle: true,
            format: 'iife',
            charset: 'utf8',
            legalComments: 'none',
            logLevel: 'warning',
            plugins: [ standInsPlugin(des) ],
            banner: {
                js: '// Built by tools/make-uxp.mjs from platform/uxp/engine/worker.js and uBlock Origin\'s modules (GPLv3, see LICENSE.txt).',
            },
        });
    } finally {
        fs.rmSync(entry);
        fs.rmSync(env);
    }
    // A worker script that UXP can't parse never runs at all: the page then
    // does the work itself, silently slower.
    const code = fs.readFileSync(path.join(des, ENGINE_WORKER), 'utf8');
    if ( /\bimport\s*\(/.test(code) ) {
        throw new Error(`${ENGINE_WORKER} has an import(), which UXP's workers can't parse: give the module a stand-in (WORKER_STAND_INS)`);
    }
    return Buffer.byteLength(code);
};

// tools/make-firefox-meta.py
const writeFirefoxMeta = (des, version, emVersion) => {
    const file = path.join(des, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Upstream drops sidebar_action from stable (3-part) releases.
    if ( /^\d+\.\d+\.\d+\.\d+$/.test(version) === false ) {
        delete manifest.sidebar_action;
    }
    manifest.version = version;
    // The fork's version, as the add-ons manager shows it, for uBO's pages
    // to show (About, troubleshooting info): `version` must stay upstream's.
    manifest.uxp_version = emVersion;
    const upstreamAuthor = manifest.author;
    manifest.browser_specific_settings.gecko.id = ADDON_ID;
    manifest.author = AUTHOR;
    fs.writeFileSync(file, JSON.stringify(sortKeysDeep(manifest), null, 2) + '\n');
    return { manifest, upstreamAuthor };
};

// tools/make-assets.sh
const bundleAssets = async (des, upstream, version, options) => {
    const assetsDir = path.join(des, 'assets');
    copyDir(path.join(upstream, 'assets'), assetsDir);
    const isRelease = /^\d+\.\d+\.\d+$/.test(version);
    fs.rmSync(path.join(assetsDir, isRelease ? 'assets.dev.json' : 'assets.json'));
    if ( options.noAssets ) { return { bundled: 0, missing: [] }; }

    const missing = [];
    let bundled = 0;
    for ( const [ rel, url ] of BUNDLED_ASSETS ) {
        const cached = path.join(ASSETS_CACHE, rel);
        if ( options.refreshAssets || fs.existsSync(cached) === false ) {
            try {
                const response = await fetch(url);
                if ( response.ok === false ) { throw new Error(`HTTP ${response.status}`); }
                const data = Buffer.from(await response.arrayBuffer());
                if ( data.length === 0 ) { throw new Error('empty response'); }
                fs.mkdirSync(path.dirname(cached), { recursive: true });
                fs.writeFileSync(cached, data);
            } catch (reason) {
                missing.push(`${rel} (${reason.message})`);
            }
        }
        if ( fs.existsSync(cached) === false ) { continue; }
        fs.mkdirSync(path.dirname(path.join(assetsDir, rel)), { recursive: true });
        fs.copyFileSync(cached, path.join(assetsDir, rel));
        bundled += 1;
    }
    return { bundled, missing };
};

/******************************************************************************/

const overlayPlatform = (des, options) => {
    fs.copyFileSync(path.join(PLATFORM, 'bootstrap.js'), path.join(des, 'bootstrap.js'));
    if ( fs.existsSync(path.join(PLATFORM, 'modules')) ) {
        copyDir(path.join(PLATFORM, 'modules'), path.join(des, 'uxp'));
    }
    if ( options.debug ) {
        copyDir(path.join(PLATFORM, 'debug'), path.join(des, 'uxp-debug'));
    }
    // The add-on manager picks these up for about:addons.
    fs.copyFileSync(path.join(des, 'img', 'icon_32.png'), path.join(des, 'icon.png'));
    fs.copyFileSync(path.join(des, 'img', 'icon_64.png'), path.join(des, 'icon64.png'));
};

const writeInstallRdf = (des, manifest, upstreamAuthor, emVersion, options) => {
    const messages = JSON.parse(
        fs.readFileSync(path.join(des, '_locales', 'en', 'messages.json'), 'utf8')
    );
    const description = messages.extShortDesc.message;
    const name = options.debug ? `${manifest.name} (UXP debug)` : manifest.name;
    const targets = TARGET_APPLICATIONS.map(app => [
        '    <em:targetApplication>',
        '      <Description>',
        `        <em:id>${app.id}</em:id>`,
        `        <em:minVersion>${app.minVersion}</em:minVersion>`,
        `        <em:maxVersion>${app.maxVersion}</em:maxVersion>`,
        app.basilisk ? '        <em:basilisk>true</em:basilisk>' : '',
        '      </Description>',
        '    </em:targetApplication>',
    ].filter(s => s !== '').join('\n'));
    const rdf = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#"',
        '     xmlns:em="http://www.mozilla.org/2004/em-rdf#">',
        '  <Description about="urn:mozilla:install-manifest">',
        `    <em:id>${escapeXML(manifest.browser_specific_settings.gecko.id)}</em:id>`,
        '    <em:type>2</em:type>',
        `    <em:version>${emVersion}</em:version>`,
        `    <em:name>${escapeXML(name)}</em:name>`,
        `    <em:description>${escapeXML(description)}</em:description>`,
        `    <em:creator>${escapeXML(manifest.author)}</em:creator>`,
        `    <em:contributor>${escapeXML(`${upstreamAuthor} (uBlock Origin)`)}</em:contributor>`,
        `    <em:homepageURL>${HOMEPAGE_URL}</em:homepageURL>`,
        // Debug builds never update themselves: a test runs the build under
        // test, and only that.
        ...(options.debug ? [] : [ `    <em:updateURL>${UPDATE_URL}</em:updateURL>` ]),
        '    <em:bootstrap>true</em:bootstrap>',
        '    <em:multiprocessCompatible>true</em:multiprocessCompatible>',
        ...targets,
        '  </Description>',
        '</RDF>',
        '',
    ].join('\n');
    fs.writeFileSync(path.join(des, 'install.rdf'), rdf);
};

// The update manifest offering the release XPI at xpiPath to the browsers
// it targets. The browser checks the downloaded XPI against its hash.
const writeUpdateRdf = (file, addonId, emVersion, xpiPath) => {
    const hash = createHash('sha256').update(fs.readFileSync(xpiPath)).digest('hex');
    const link = releaseAssetURL(emVersion, path.basename(xpiPath));
    const targets = TARGET_APPLICATIONS.map(app => [
        '            <em:targetApplication>',
        '              <Description>',
        `                <em:id>${app.id}</em:id>`,
        `                <em:minVersion>${app.minVersion}</em:minVersion>`,
        `                <em:maxVersion>${app.maxVersion}</em:maxVersion>`,
        `                <em:updateLink>${escapeXML(link)}</em:updateLink>`,
        `                <em:updateHash>sha256:${hash}</em:updateHash>`,
        '              </Description>',
        '            </em:targetApplication>',
    ].join('\n'));
    const rdf = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#"',
        '     xmlns:em="http://www.mozilla.org/2004/em-rdf#">',
        `  <Description about="urn:mozilla:extension:${escapeXML(addonId)}">`,
        '    <em:updates>',
        '      <Seq>',
        '        <li>',
        '          <Description>',
        `            <em:version>${emVersion}</em:version>`,
        ...targets,
        '          </Description>',
        '        </li>',
        '      </Seq>',
        '    </em:updates>',
        '  </Description>',
        '</RDF>',
        '',
    ].join('\n');
    fs.writeFileSync(file, rdf);
};

const writeChromeManifest = des => {
    fs.writeFileSync(
        path.join(des, 'chrome.manifest'),
        `content ${CHROME_PACKAGE} ./\n`
    );
};

/******************************************************************************/

const listFiles = (dir, prefix = '') => {
    const out = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name < b.name ? -1 : 1);
    for ( const entry of entries ) {
        const rel = prefix + entry.name;
        if ( entry.isDirectory() ) {
            out.push(...listFiles(path.join(dir, entry.name), `${rel}/`));
        } else {
            out.push(rel);
        }
    }
    return out;
};

// Minimal zip writer: forward-slash names, deflate when it helps, fixed
// timestamp so identical inputs give an identical XPI.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

const makeZip = (rootDir, names) => {
    const parts = [];
    const central = [];
    let offset = 0;
    for ( const name of names ) {
        const data = fs.readFileSync(path.join(rootDir, name));
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = zlib.crc32(data);
        const deflated = zlib.deflateRawSync(data, { level: 9 });
        const method = deflated.length < data.length ? 8 : 0;
        const body = method === 8 ? deflated : data;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        parts.push(local, nameBuf, body);

        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(20, 6);
        header.writeUInt16LE(0x0800, 8);
        header.writeUInt16LE(method, 10);
        header.writeUInt16LE(DOS_TIME, 12);
        header.writeUInt16LE(DOS_DATE, 14);
        header.writeUInt32LE(crc, 16);
        header.writeUInt32LE(body.length, 20);
        header.writeUInt32LE(data.length, 24);
        header.writeUInt16LE(nameBuf.length, 28);
        header.writeUInt32LE(offset, 42);
        central.push(header, nameBuf);

        offset += local.length + nameBuf.length + body.length;
    }
    const centralSize = central.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(names.length, 8);
    end.writeUInt16LE(names.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([ ...parts, ...central, end ]);
};

/******************************************************************************/

const main = async ( ) => {
    const args = new Set(process.argv.slice(2));
    const options = {
        debug: args.has('--debug'),
        noAssets: args.has('--no-assets'),
        refreshAssets: args.has('--refresh-assets'),
        pristine: args.has('--pristine'),
    };
    if ( options.pristine && options.debug === false ) {
        throw new Error('--pristine builds are for comparing, not for release: add --debug');
    }

    const upstream = options.pristine ? pristineUpstream() : UPSTREAM;
    const version = fs.readFileSync(path.join(upstream, 'dist', 'version'), 'utf8').trim();
    const emVersion = UXP_REVISION === 0 ? version : `${version}.${UXP_REVISION}`;

    fs.rmSync(BUILD, { recursive: true, force: true });
    fs.mkdirSync(BUILD, { recursive: true });

    const assets = await bundleAssets(BUILD, upstream, version, options);
    assembleUpstream(BUILD, upstream);
    const changed = changedFiles(BUILD);
    const compat = rewriteForUXP(BUILD);
    // uBO's code as released doesn't use the engine's worker.
    const workerSize = options.pristine ? 0 : await addEngine(BUILD);
    const { manifest, upstreamAuthor } = writeFirefoxMeta(BUILD, version, emVersion);
    overlayPlatform(BUILD, options);
    writeInstallRdf(BUILD, manifest, upstreamAuthor, emVersion, options);
    writeChromeManifest(BUILD);

    const names = listFiles(BUILD);
    const flavor = options.debug ? 'uxp-debug' : 'uxp';
    const xpiPath = path.join(DIST, `uBlock0_${emVersion}.${flavor}.xpi`);
    fs.writeFileSync(xpiPath, makeZip(BUILD, names));

    const size = (fs.statSync(xpiPath).size / 1048576).toFixed(2);
    console.log(`Built ${path.relative(ROOT, xpiPath)} (${names.length} files, ${size} MB)`);
    console.log(`  upstream ${version}, em:version ${emVersion}, ${options.debug ? 'debug' : 'release'}`);
    if ( options.pristine ) {
        console.log(`  uBO's code as released (${PRISTINE_COMMIT.slice(0, 7)}, --pristine): ${changed.length === 0 ? 'no changes' : `WARNING: changes in ${changed.join(', ')}`}`);
    } else {
        console.log(`  changes to uBO's code (${CHANGE_MARK}): ${changed.join(', ')}`);
    }
    console.log(`  UXP rewrites: ${compat.rewritten} super calls in ${compat.files} files (${compat.kept} other uses of super left as they are)`);
    for ( const entry of compat.failed ) {
        console.warn(`  WARNING: not rewritten: ${entry}`);
    }
    console.log(options.pristine
        ? '  engine worker: not added (--pristine)'
        : `  engine worker: ${ENGINE_WORKER} (${(workerSize / 1024).toFixed(0)} KB)`
    );
    if ( options.noAssets ) {
        console.log('  filter lists: not bundled (--no-assets)');
    } else {
        console.log(`  filter lists: ${assets.bundled}/${BUNDLED_ASSETS.length} bundled`);
        for ( const entry of assets.missing ) {
            console.warn(`  WARNING: not bundled: ${entry}`);
        }
    }
    if ( options.debug === false ) {
        const updateRdf = path.join(DIST, 'update.rdf');
        writeUpdateRdf(updateRdf, manifest.browser_specific_settings.gecko.id, emVersion, xpiPath);
        console.log(`  update manifest: ${path.relative(ROOT, updateRdf)}, for ${UPDATE_URL}`);
    }
};

main().catch(reason => {
    console.error(reason);
    process.exitCode = 1;
});

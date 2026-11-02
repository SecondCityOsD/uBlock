/*******************************************************************************

    uBlock Origin for UXP - bootstrap
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

/* exported startup, shutdown, install, uninstall */

'use strict';

// Add-on entry point: starts the WebExtension runtime (uxp/Extension.jsm),
// which runs upstream uBO. Debug builds also ship uxp-debug/harness.js.

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;
const { Services } = Cu.import('resource://gre/modules/Services.jsm', {});

const RUNTIME_URL = 'chrome://ublock0/content/uxp/Extension.jsm';

let extension = null;
let harness = null;

/******************************************************************************/

const packageHasFile = function(data, path) {
    const installPath = data.installPath;
    if ( installPath.isDirectory() ) {
        const file = installPath.clone();
        for ( const part of path.split('/') ) {
            file.append(part);
        }
        return file.exists();
    }
    const reader = Cc['@mozilla.org/libjar/zip-reader;1']
        .createInstance(Ci.nsIZipReader);
    reader.open(installPath);
    try {
        return reader.hasEntry(path);
    } finally {
        reader.close();
    }
};

const startExtension = function(data, reason) {
    const { Extension } = Cu.import(RUNTIME_URL, {});
    extension = new Extension(data, reason, {
        // runtime.reload()
        reload: ( ) => {
            stopExtension();
            startExtension(data, ADDON_ENABLE);
        },
    });
    if ( harness !== null ) {
        harness.attach(extension);
    }
    extension.startup().catch(reason => { Cu.reportError(reason); });
};

const stopExtension = function() {
    if ( extension === null ) { return; }
    extension.shutdown();
    extension = null;
};

/******************************************************************************/

function startup(data, reason) {
    if ( packageHasFile(data, 'uxp-debug/harness.js') ) {
        const scope = {};
        Services.scriptloader.loadSubScript(
            `${data.resourceURI.spec}uxp-debug/harness.js`,
            scope,
            'UTF-8'
        );
        harness = scope.harness;
        harness.start(data, reason);
    }
    startExtension(data, reason);
}

function shutdown(data, reason) {
    if ( reason === APP_SHUTDOWN ) { return; }
    stopExtension();
    Cu.unload(RUNTIME_URL);
    if ( harness !== null ) {
        harness.stop();
        harness = null;
    }
}

function install() {
}

function uninstall() {
}

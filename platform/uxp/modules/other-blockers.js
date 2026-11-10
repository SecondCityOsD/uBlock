/*******************************************************************************

    uBlock Origin for UXP - WebExtension runtime
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

// Another ad blocker enabled beside the port (legacy uBO 1.16, another uBO
// fork, Adblock Plus, AdBlock Latitude, AdGuard...): every page filtered
// twice, and their filters add up to breakage hard to trace. A notice at
// the bottom of the browser window names them and offers to disable them;
// nothing is disabled without the user's click. "Keep ... enabled" is
// remembered per add-on, so only a blocker not kept before brings the
// notice back. Its close box hides it until the port starts again.
//
// Loaded into Extension.jsm's global (see there).

/* global Cu, Services, dispatch, NAME_PREFIX, PREF_BRANCH */
/* exported createOtherBlockersNotice */

'use strict';

var { createOtherBlockersNotice } = (( ) => {

const { AddonManager } = Cu.import('resource://gre/modules/AddonManager.jsm', {});

// Ad blockers by their names, in any language they are published in.
const BLOCKER_NAME = /\b(?:u|ad\s?|ad-)block|\badguard\b/i;
// Ad blockers whose names don't say so.
const BLOCKER_IDS = new Set([
    'adnauseam@rednoise.org',               // AdNauseam
    'firefox@ghostery.com',                 // Ghostery
]);
const NOTICE_VALUE = `${NAME_PREFIX}-other-blockers`;
// The IDs of the ad blockers the user chose to keep beside the port.
const PREF_KEPT = `${PREF_BRANCH}otherBlockersKept`;
// A browser window has finished starting up: its notification box is there.
const WINDOW_READY_TOPIC = 'browser-delayed-startup-finished';

const noticeBoxOf = win =>
    win.document.getElementById('global-notificationbox') || win.gBrowser.getNotificationBox();

const browserWindows = function*() {
    const windows = Services.wm.getEnumerator('navigator:browser');
    while ( windows.hasMoreElements() ) {
        const win = windows.getNext();
        if ( win.closed === false && win.gBrowser ) { yield win; }
    }
};

const keptIds = ( ) => {
    try {
        const ids = JSON.parse(Services.prefs.getCharPref(PREF_KEPT));
        return new Set(Array.isArray(ids) ? ids : []);
    } catch {
    }
    return new Set();
};

const OtherBlockersNotice = class {
    constructor(extension) {
        this.extension = extension;
        this.stopped = false;
        this.windowObserver = null;
        // Which blockers the notice shown names, to replace it when that
        // changes.
        this.shownFor = '';
        const onChange = addon => {
            if ( addon.type === 'extension' && addon.id !== extension.id ) { this.check(); }
        };
        this.addonListener = {
            onEnabled: onChange,
            onInstalled: onChange,
            onDisabled: onChange,
            onUninstalled: onChange,
        };
        AddonManager.addAddonListener(this.addonListener);
        extension.onShutdown(( ) => { this.stop(); });
        this.check();
    }

    isBlocker(addon) {
        return addon.id !== this.extension.id &&
            (BLOCKER_IDS.has(addon.id) || BLOCKER_NAME.test(addon.name));
    }

    check() {
        AddonManager.getAddonsByTypes([ 'extension' ], addons => {
            if ( this.stopped ) { return; }
            const kept = keptIds();
            const blockers = addons.filter(addon =>
                addon.isActive && this.isBlocker(addon) && kept.has(addon.id) === false
            );
            if ( blockers.length === 0 ) {
                this.hide();
                return;
            }
            this.show(blockers);
        });
    }

    show(blockers) {
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        if ( win === null || win.gBrowser === undefined || win.document.readyState !== 'complete' ) {
            this.waitForWindow();
            return;
        }
        const shownFor = blockers.map(addon => addon.id).sort().join(' ');
        const box = noticeBoxOf(win);
        if ( box.getNotificationWithValue(NOTICE_VALUE) !== null && shownFor === this.shownFor ) {
            return;
        }
        this.hide();
        this.shownFor = shownFor;
        const l10n = (key, ...args) => this.extension.localize(key, args);
        const names = blockers.map(addon => `${addon.name} ${addon.version}`);
        const one = blockers.length === 1;
        box.appendNotification(
            l10n(one ? 'uxpOtherBlockerNotice' : 'uxpOtherBlockersNotice', names.join(', ')),
            NOTICE_VALUE,
            this.extension.getURL('img/icon_16.png'),
            box.PRIORITY_WARNING_MEDIUM,
            [
                {
                    label: one ? l10n('uxpOtherBlockerDisable', names[0]) : l10n('uxpOtherBlockersDisable'),
                    accessKey: '',
                    callback: ( ) => {
                        for ( const addon of blockers ) { addon.userDisabled = true; }
                    },
                },
                {
                    label: l10n(one ? 'uxpOtherBlockerKeep' : 'uxpOtherBlockersKeep'),
                    accessKey: '',
                    callback: ( ) => {
                        const kept = keptIds();
                        for ( const addon of blockers ) { kept.add(addon.id); }
                        Services.prefs.setCharPref(PREF_KEPT, JSON.stringify(Array.from(kept)));
                    },
                },
            ]
        );
    }

    // At the browser's launch the port starts before any window is ready.
    waitForWindow() {
        if ( this.windowObserver !== null ) { return; }
        this.windowObserver = {
            observe: ( ) => {
                this.stopWaiting();
                dispatch(( ) => { this.check(); });
            },
        };
        Services.obs.addObserver(this.windowObserver, WINDOW_READY_TOPIC, false);
    }

    stopWaiting() {
        if ( this.windowObserver === null ) { return; }
        Services.obs.removeObserver(this.windowObserver, WINDOW_READY_TOPIC);
        this.windowObserver = null;
    }

    hide() {
        this.shownFor = '';
        for ( const win of browserWindows() ) {
            const box = noticeBoxOf(win);
            const notice = box.getNotificationWithValue(NOTICE_VALUE);
            if ( notice !== null ) { box.removeNotification(notice); }
        }
    }

    stop() {
        this.stopped = true;
        AddonManager.removeAddonListener(this.addonListener);
        this.stopWaiting();
        this.hide();
    }
};

const createOtherBlockersNotice = extension => new OtherBlockersNotice(extension);

return { createOtherBlockersNotice };

})();

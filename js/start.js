/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2014-2018 Raymond Hill

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

// Load all: executed once.

µBlock.restart = (( ) => {

/******************************************************************************/

const µb = µBlock;

/******************************************************************************/

vAPI.app.onShutdown = ( ) => {
    µb.staticFilteringReverseLookup.shutdown();
    µb.assets.updateStop();
    µb.staticNetFilteringEngine.reset();
    µb.staticExtFilteringEngine.reset();
    µb.sessionFirewall.reset();
    µb.permanentFirewall.reset();
    µb.sessionURLFiltering.reset();
    µb.permanentURLFiltering.reset();
    µb.sessionSwitches.reset();
    µb.permanentSwitches.reset();
};

/******************************************************************************/

const processCallbackQueue = (queue, callback) => {
    const processOne = ( ) => {
        const fn = queue.pop();
        if ( fn ) {
            fn(processOne);
        } else if ( typeof callback === 'function' ) {
            callback();
        }
    };
    processOne();
};

/******************************************************************************/

// Final initialization steps after all needed assets are in memory.
// - Initialize internal state with maybe already existing tabs.
// - Schedule next update operation.

const onAllReady = ( ) => {
    // https://github.com/chrisaljoudi/uBlock/issues/184
    // Check for updates not too far in the future.
    µb.assets.addObserver(µb.assetObserver.bind(µb));
    µb.scheduleAssetUpdater(µb.userSettings.autoUpdate ? 7 * 60 * 1000 : 0);

    // vAPI.cloud is optional.
    if ( µb.cloudStorageSupported ) {
        vAPI.cloud.start([
            'tpFiltersPane',
            'myFiltersPane',
            'myRulesPane',
            'whitelistPane'
        ]);
    }

    µb.contextMenu.update(null);
    µb.firstInstall = false;

    processCallbackQueue(µb.onStartCompletedQueue);
};

/******************************************************************************/

// Filtering engines dependencies:
// - PSL

const onPSLReady = ( ) => {
    µb.selfieManager.load(function(valid) {
        if ( valid === true ) {
            return onAllReady();
        }
        µb.loadFilterLists(onAllReady);
    });
};

/******************************************************************************/

// To bring older versions up to date

const onVersionReady = lastVersion => {
    if ( lastVersion === vAPI.app.version ) { return; }

    // Update `assetSourceRegistry` if `assets.json` gets new `contentURL`.
    // https://github.com/gorhill/uBlock-for-firefox-legacy/issues/108
    µb.assets.fetchText(µb.assetsBootstrapLocation || 'assets/assets.json', details => {
        let assetDetails;
        const assetKey = 'assets.json';
        try {
            assetDetails = JSON.parse(details.content)[assetKey];
        } catch (ex) {
        }

        if ( assetDetails instanceof Object === false ) { return; }

        vAPI.storage.get('assetSourceRegistry', bin => {
            let current = bin.assetSourceRegistry[assetKey];
            if ( current && current.contentURL ) {
                current = current.contentURL.join();
            }

            let incoming;
            if ( Array.isArray(assetDetails.contentURL) ) {
                incoming = assetDetails.contentURL.join();
            } else {
                incoming = assetDetails.contentURL;
            }

            if ( incoming && current !== incoming ) {
                µb.assets.registerAssetSource(assetKey, assetDetails);
            }
        });
    });

    // Since built-in resources may have changed since last version, we
    // force a reload of all resources.
    µb.redirectEngine.invalidateResourcesSelfie();

    vAPI.storage.set({ version: vAPI.app.version });
};

/******************************************************************************/

// https://github.com/chrisaljoudi/uBlock/issues/226
// Whitelist in memory.
// Whitelist parser needs PSL to be ready.
// gorhill 2014-12-15: not anymore

const onNetWhitelistReady = netWhitelistRaw => {
    µb.netWhitelist = µb.whitelistFromString(netWhitelistRaw);
    µb.netWhitelistModifyTime = Date.now();
};

/******************************************************************************/

// User settings are in memory

const onUserSettingsReady = fetched => {
    const userSettings = µb.userSettings;

    fromFetch(userSettings, fetched);

    if ( µb.privacySettingsSupported ) {
        vAPI.browserSettings.set({
            'hyperlinkAuditing': !userSettings.hyperlinkAuditingDisabled,
            'prefetching': !userSettings.prefetchingDisabled,
            'webrtcIPAddress': !userSettings.webrtcIPAddressHidden
        });
    }

    µb.permanentFirewall.fromString(fetched.dynamicFilteringString);
    µb.sessionFirewall.assign(µb.permanentFirewall);
    µb.permanentURLFiltering.fromString(fetched.urlFilteringString);
    µb.sessionURLFiltering.assign(µb.permanentURLFiltering);
    µb.permanentSwitches.fromString(fetched.hostnameSwitchesString);
    µb.sessionSwitches.assign(µb.permanentSwitches);

    // https://github.com/gorhill/uBlock/issues/1892
    // For first installation on a battery-powered device, disable generic
    // cosmetic filtering.
    if ( µb.firstInstall && vAPI.battery ) {
        userSettings.ignoreGenericCosmeticFilters = true;
    }
};

/******************************************************************************/

// Housekeeping, as per system setting changes

const onSystemSettingsReady = fetched => {
    let mustSaveSystemSettings = false;
    if ( fetched.compiledMagic !== µb.systemSettings.compiledMagic ) {
        µb.assets.remove(/^compiled\//);
        mustSaveSystemSettings = true;
    }
    if ( fetched.selfieMagic !== µb.systemSettings.selfieMagic ) {
        mustSaveSystemSettings = true;
    }
    if ( mustSaveSystemSettings ) {
        fetched.selfie = null;
        µb.selfieManager.destroy();
        vAPI.storage.set(µb.systemSettings);
    }
};

/******************************************************************************/

const onFirstFetchReady = fetched => {
    // https://github.com/gorhill/uBlock/issues/747
    µb.firstInstall = fetched.version === '0.0.0.0';

    // Order is important -- do not change:
    onSystemSettingsReady(fetched);
    fromFetch(µb.localSettings, fetched);
    onUserSettingsReady(fetched);
    fromFetch(µb.restoreBackupSettings, fetched);
    onNetWhitelistReady(fetched.netWhitelist);
    onVersionReady(fetched.version);

    µb.loadPublicSuffixList(onPSLReady);
    µb.loadRedirectResources();
};

/******************************************************************************/

const toFetch = (from, fetched) => {
    for ( const k in from ) {
        if ( from.hasOwnProperty(k) === false ) {
            continue;
        }
        fetched[k] = from[k];
    }
};

const fromFetch = (to, fetched) => {
    for ( const k in to ) {
        if ( to.hasOwnProperty(k) === false ) {
            continue;
        }
        if ( fetched.hasOwnProperty(k) === false ) {
            continue;
        }
        to[k] = fetched[k];
    }
};

/******************************************************************************/

const onSelectedFilterListsLoaded = ( ) => {
    const fetchableProps = {
        'compiledMagic': '',
        'dynamicFilteringString': [
            'behind-the-scene * * noop',
            'behind-the-scene * image noop',
            'behind-the-scene * 3p noop',
            'behind-the-scene * inline-script noop',
            'behind-the-scene * 1p-script noop',
            'behind-the-scene * 3p-script noop',
            'behind-the-scene * 3p-frame noop'
        ].join('\n'),
        'urlFilteringString': '',
        'hostnameSwitchesString': [
            'no-large-media: behind-the-scene false',
            'no-scripting: behind-the-scene false'
        ].join('\n'),
        'lastRestoreFile': '',
        'lastRestoreTime': 0,
        'lastBackupFile': '',
        'lastBackupTime': 0,
        'netWhitelist': µb.netWhitelistDefault,
        'selfieMagic': '',
        'version': '0.0.0.0'
    };

    toFetch(µb.localSettings, fetchableProps);
    toFetch(µb.userSettings, fetchableProps);
    toFetch(µb.restoreBackupSettings, fetchableProps);

    vAPI.storage.get(fetchableProps, onFirstFetchReady);
};

/******************************************************************************/

// TODO(seamless migration):
// Eventually selected filter list keys will be loaded as a fetchable
// property. Until then we need to handle backward and forward
// compatibility, this means a special asynchronous call to load selected
// filter lists.

const onAdminSettingsRestored = ( ) => {
    µb.loadSelectedFilterLists(onSelectedFilterListsLoaded);
};

/******************************************************************************/

return ( ) => {
    processCallbackQueue(µb.onBeforeStartQueue, ( ) => {
        // https://github.com/gorhill/uBlock/issues/531
        µb.restoreAdminSettings(onAdminSettingsRestored);
    });
};

/******************************************************************************/

})();

/******************************************************************************/

µBlock.restart();

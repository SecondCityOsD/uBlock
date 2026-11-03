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

// browser.dns, on the browser's own resolver (uBO's CNAME uncloaking and
// `ipaddress=` filters), and browser.privacy, the network settings Firefox
// lets an extension control, on the same prefs Firefox uses.
//
// Loaded into Extension.jsm's global (see there).

/* global Cc, Ci, Cu, Services, XPCOMUtils, errorNameOf, EventManager,
          ExtensionError, apiAsync */
/* exported createNetworkAPIs */

'use strict';

var { createNetworkAPIs } = (( ) => {

const PREF_PRIVACY_SETTINGS = 'extensions.ublock0.privacySettings';

const hasOwn = (o, key) => Object.prototype.hasOwnProperty.call(o, key);

/******************************************************************************/

// dns.resolve() flags -> nsIDNSService flags. UXP has no DNS-over-HTTPS, so
// no RESOLVE_DISABLE_TRR: `disable_trr` has nothing to disable.
const DNS_FLAGS = {
    allow_name_collisions: 'RESOLVE_ALLOW_NAME_COLLISION',
    bypass_cache: 'RESOLVE_BYPASS_CACHE',
    canonical_name: 'RESOLVE_CANONICAL_NAME',
    disable_ipv4: 'RESOLVE_DISABLE_IPV4',
    disable_ipv6: 'RESOLVE_DISABLE_IPV6',
    disable_trr: 'RESOLVE_DISABLE_TRR',
    offline: 'RESOLVE_OFFLINE',
    priority_low: 'RESOLVE_PRIORITY_LOW',
    priority_medium: 'RESOLVE_PRIORITY_MEDIUM',
    speculate: 'RESOLVE_SPECULATE',
};

const dnsService = Cc['@mozilla.org/network/dns-service;1']
    .getService(Ci.nsIDNSService);

// Firefox's DNSRecord: { addresses, canonicalName (if asked for), isTRR }.
// Failures reject with the error's name, e.g. NS_ERROR_UNKNOWN_HOST.
const resolveHostname = function(hostname, flags) {
    if ( typeof hostname !== 'string' || hostname === '' ) {
        throw new ExtensionError('dns.resolve: hostname must be a non-empty string');
    }
    let mask = 0;
    for ( const flag of flags === undefined || flags === null ? [] : [].concat(flags) ) {
        if ( hasOwn(DNS_FLAGS, flag) === false ) {
            throw new ExtensionError(`dns.resolve: invalid flag ${JSON.stringify(flag)}`);
        }
        mask |= Ci.nsIDNSService[DNS_FLAGS[flag]] || 0;
    }
    const wantsCanonicalName = (mask & Ci.nsIDNSService.RESOLVE_CANONICAL_NAME) !== 0;
    return new Promise((resolve, reject) => {
        const listener = {
            onLookupComplete(request, record, status) {
                if ( Components.isSuccessCode(status) === false ) {
                    reject(new ExtensionError(errorNameOf(status)));
                    return;
                }
                const out = { addresses: [], isTRR: false };
                if ( wantsCanonicalName ) {
                    try {
                        out.canonicalName = record.canonicalName;
                    } catch {
                    }
                }
                while ( record.hasMore() ) {
                    out.addresses.push(record.getNextAddrAsString());
                }
                resolve(out);
            },
            QueryInterface: XPCOMUtils.generateQI([ Ci.nsIDNSListener ]),
        };
        try {
            // The listener runs on the main thread, not the resolver's.
            dnsService.asyncResolve(hostname, mask, listener, Services.tm.mainThread);
        } catch (ex) {
            reject(new ExtensionError(ex.result ? errorNameOf(ex.result) : String(ex)));
        }
    });
};

/******************************************************************************/

// Firefox's privacy settings (ext-privacy.js): the prefs each one controls,
// the pref values for a setting's value (undefined: the value the user had),
// and the setting's value read back from the prefs.

const WEBRTC_POLICIES = [
    'default',
    'default_public_and_private_interfaces',
    'default_public_interface_only',
    'disable_non_proxied_udp',
    'proxy_only',
];

const isBoolean = v => typeof v === 'boolean';

const SETTINGS = new Map([
    [ 'network.networkPredictionEnabled', {
        valid: isBoolean,
        prefs: [
            'network.predictor.enabled',
            'network.prefetch-next',
            'network.http.speculative-parallel-limit',
            'network.dns.disablePrefetch',
        ],
        toPrefs: value => ({
            'network.predictor.enabled': value,
            'network.prefetch-next': value,
            'network.http.speculative-parallel-limit': value ? undefined : 0,
            'network.dns.disablePrefetch': !value,
        }),
        // A pref the browser lacks enables nothing and disables nothing.
        fromPrefs: get =>
            get('network.predictor.enabled') !== false &&
            get('network.prefetch-next') !== false &&
            get('network.http.speculative-parallel-limit') !== 0 &&
            get('network.dns.disablePrefetch') !== true,
    } ],
    [ 'network.peerConnectionEnabled', {
        valid: isBoolean,
        prefs: [ 'media.peerconnection.enabled' ],
        toPrefs: value => ({ 'media.peerconnection.enabled': value }),
        fromPrefs: get => get('media.peerconnection.enabled') !== false,
    } ],
    [ 'network.webRTCIPHandlingPolicy', {
        valid: v => WEBRTC_POLICIES.includes(v),
        prefs: [
            'media.peerconnection.ice.default_address_only',
            'media.peerconnection.ice.no_host',
            'media.peerconnection.ice.proxy_only_if_behind_proxy',
            'media.peerconnection.ice.proxy_only',
        ],
        toPrefs: value => {
            const prefs = {};
            switch ( value ) {
            case 'default_public_and_private_interfaces':
                prefs['media.peerconnection.ice.default_address_only'] = true;
                break;
            case 'default_public_interface_only':
                prefs['media.peerconnection.ice.default_address_only'] = true;
                prefs['media.peerconnection.ice.no_host'] = true;
                break;
            case 'disable_non_proxied_udp':
                prefs['media.peerconnection.ice.default_address_only'] = true;
                prefs['media.peerconnection.ice.no_host'] = true;
                prefs['media.peerconnection.ice.proxy_only_if_behind_proxy'] = true;
                break;
            case 'proxy_only':
                prefs['media.peerconnection.ice.proxy_only'] = true;
                break;
            default:
                break;
            }
            return prefs;
        },
        fromPrefs: get => {
            if ( get('media.peerconnection.ice.proxy_only') ) { return 'proxy_only'; }
            if ( get('media.peerconnection.ice.default_address_only') !== true ) { return 'default'; }
            if ( get('media.peerconnection.ice.no_host') !== true ) {
                return 'default_public_and_private_interfaces';
            }
            return get('media.peerconnection.ice.proxy_only_if_behind_proxy')
                ? 'disable_non_proxied_udp'
                : 'default_public_interface_only';
        },
    } ],
    [ 'websites.hyperlinkAuditingEnabled', {
        valid: isBoolean,
        prefs: [ 'browser.send_pings' ],
        toPrefs: value => ({ 'browser.send_pings': value }),
        fromPrefs: get => get('browser.send_pings') === true,
    } ],
    [ 'websites.referrersEnabled', {
        valid: isBoolean,
        prefs: [ 'network.http.sendRefererHeader' ],
        // 0: never; 2: on navigation and for subresources.
        toPrefs: value => ({ 'network.http.sendRefererHeader': value ? 2 : 0 }),
        fromPrefs: get => get('network.http.sendRefererHeader') !== 0,
    } ],
]);

const readPref = function(name) {
    const prefs = Services.prefs;
    try {
        switch ( prefs.getPrefType(name) ) {
        case prefs.PREF_BOOL: return prefs.getBoolPref(name);
        case prefs.PREF_INT: return prefs.getIntPref(name);
        case prefs.PREF_STRING: return prefs.getCharPref(name);
        default: break;
        }
    } catch {
    }
    return undefined;
};

// undefined: the pref's default value.
const writePref = function(name, value) {
    const prefs = Services.prefs;
    try {
        if ( value === undefined ) {
            if ( prefs.prefHasUserValue(name) ) { prefs.clearUserPref(name); }
        } else if ( typeof value === 'boolean' ) {
            prefs.setBoolPref(name, value);
        } else if ( typeof value === 'number' ) {
            prefs.setIntPref(name, value);
        } else {
            prefs.setCharPref(name, String(value));
        }
    } catch (ex) {
        Cu.reportError(ex);
    }
};

// What Firefox's ExtensionPreferencesManager does for one extension: the
// first set() of a setting remembers the values the user had for its prefs,
// clear() puts them back. Kept in a pref, so that clear() works after a
// restart. The prefs keep the extension's values across browser restarts;
// when the extension stops for any other reason (disabled, removed,
// updated) the user's values come back, and the next start applies the
// extension's again -- as Firefox does when an extension is disabled and
// enabled again.

const PrivacySettings = class {
    constructor() {
        this.store = this.load();
        this.events = new Map();
        for ( const name of SETTINGS.keys() ) {
            this.events.set(name, new EventManager(`privacy.${name}.onChange`));
        }
    }

    load() {
        let store = {};
        try {
            store = JSON.parse(Services.prefs.getCharPref(PREF_PRIVACY_SETTINGS));
        } catch {
        }
        if ( store === null || typeof store !== 'object' ) { return {}; }
        for ( const [ name, entry ] of Object.entries(store) ) {
            const valid = SETTINGS.has(name) &&
                entry !== null && typeof entry === 'object' &&
                SETTINGS.get(name).valid(entry.value) &&
                entry.initial !== null && typeof entry.initial === 'object';
            if ( valid === false ) { delete store[name]; }
        }
        return store;
    }

    save() {
        if ( Object.keys(this.store).length === 0 ) {
            writePref(PREF_PRIVACY_SETTINGS, undefined);
        } else {
            writePref(PREF_PRIVACY_SETTINGS, JSON.stringify(this.store));
        }
    }

    controllable(name) {
        return SETTINGS.get(name).prefs.every(pref => Services.prefs.prefIsLocked(pref) === false);
    }

    details(name) {
        let levelOfControl = 'controllable_by_this_extension';
        if ( this.controllable(name) === false ) {
            levelOfControl = 'not_controllable';
        } else if ( hasOwn(this.store, name) ) {
            levelOfControl = 'controlled_by_this_extension';
        }
        return { value: SETTINGS.get(name).fromPrefs(readPref), levelOfControl };
    }

    apply(name) {
        const { value, initial } = this.store[name];
        const setting = SETTINGS.get(name);
        const wanted = setting.toPrefs(value);
        for ( const pref of setting.prefs ) {
            writePref(pref, wanted[pref] !== undefined ? wanted[pref] : initial[pref]);
        }
    }

    restore(name) {
        const { initial } = this.store[name];
        for ( const pref of SETTINGS.get(name).prefs ) {
            writePref(pref, initial[pref]);
        }
    }

    // Returns whether the extension now controls the setting.
    set(name, value) {
        if ( this.controllable(name) === false ) { return false; }
        const before = this.details(name);
        if ( hasOwn(this.store, name) === false ) {
            const initial = {};
            for ( const pref of SETTINGS.get(name).prefs ) {
                if ( Services.prefs.prefHasUserValue(pref) ) {
                    initial[pref] = readPref(pref);
                }
            }
            this.store[name] = { value, initial };
        } else {
            this.store[name].value = value;
        }
        this.apply(name);
        this.save();
        this.notify(name, before);
        return true;
    }

    // Returns whether the extension controlled the setting.
    clear(name) {
        if ( hasOwn(this.store, name) === false ) { return false; }
        if ( this.controllable(name) === false ) { return false; }
        const before = this.details(name);
        this.restore(name);
        delete this.store[name];
        this.save();
        this.notify(name, before);
        return true;
    }

    notify(name, before) {
        const after = this.details(name);
        if ( after.value === before.value && after.levelOfControl === before.levelOfControl ) { return; }
        this.events.get(name).fire(after);
    }

    applyAll() {
        for ( const name of Object.keys(this.store) ) {
            if ( this.controllable(name) ) { this.apply(name); }
        }
    }

    restoreAll() {
        for ( const name of Object.keys(this.store) ) {
            if ( this.controllable(name) ) { this.restore(name); }
        }
    }

    namespace() {
        const checkScope = details => {
            const scope = details !== null && typeof details === 'object' ? details.scope : undefined;
            if ( scope !== undefined && scope !== 'regular' ) {
                throw new ExtensionError(`Firefox does not support the ${scope} settings scope.`);
            }
        };
        const tree = {};
        for ( const [ name, setting ] of SETTINGS ) {
            const [ group, member ] = name.split('.');
            tree[group] = tree[group] || {};
            tree[group][member] = {
                get: apiAsync(( ) => this.details(name)),
                set: apiAsync((context, details) => {
                    checkScope(details);
                    const value = details !== null && typeof details === 'object' ? details.value : undefined;
                    if ( setting.valid(value) === false ) {
                        throw new ExtensionError(`privacy.${name}.set: invalid value ${JSON.stringify(value)}`);
                    }
                    return this.set(name, value);
                }),
                clear: apiAsync((context, details) => {
                    checkScope(details);
                    return this.clear(name);
                }),
                onChange: this.events.get(name),
            };
        }
        return tree;
    }
};

/******************************************************************************/

const createNetworkAPIs = function(extension) {
    const privacy = new PrivacySettings();
    privacy.applyAll();
    extension.onShutdown(( ) => { privacy.restoreAll(); });

    const tree = {
        dns: {
            resolve: apiAsync((context, hostname, flags) => resolveHostname(hostname, flags)),
        },
        privacy: privacy.namespace(),
    };

    return {
        build: ( ) => tree,
    };
};

/******************************************************************************/

return { createNetworkAPIs };

})();

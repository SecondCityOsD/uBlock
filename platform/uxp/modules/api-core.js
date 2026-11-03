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

// browser.runtime, browser.i18n, browser.storage and browser.alarms.
//
// Loaded into Extension.jsm's global (see there).

/* global Ci, Cu, Services, setTimeout, clearTimeout, indexedDB, dispatch,
          EventManager, ExtensionError, PageValue, apiSync, apiAsync */
/* exported createCoreAPIs, forgetCoreData, PREF_MANAGED_STORAGE */

'use strict';

var { createCoreAPIs, forgetCoreData, PREF_MANAGED_STORAGE } = (( ) => {

// Firefox's managed storage (admin settings): JSON in this pref, the
// admin's, which outlives the add-on.
const PREF_MANAGED_STORAGE = 'extensions.ublock0.managedStorage';
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

// bootstrap.js reasons
const APP_STARTUP = 1;
const ADDON_INSTALL = 5;
const ADDON_UPGRADE = 7;
const ADDON_DOWNGRADE = 8;

/******************************************************************************/

// A page event object backed by a plain Set of page functions.
const makeListenerSet = function(context, set) {
    const target = context.createObject();
    target.addListener = context.exportFunction(fn => {
        if ( typeof fn !== 'function' ) {
            throw context.pageError(new ExtensionError('listener must be a function'));
        }
        set.add(fn);
    }, target);
    target.removeListener = context.exportFunction(fn => { set.delete(fn); }, target);
    target.hasListener = context.exportFunction(fn => set.has(fn), target);
    return target;
};

/******************************************************************************/

// runtime.connect() ports. Each end belongs to one context; messages are
// structured-cloned and delivered asynchronously, as in Firefox.

const PortEnd = class {
    constructor(context, name, sender) {
        this.context = context;
        this.name = name;
        this.peers = new Set();
        this.messageListeners = new Set();
        this.disconnectListeners = new Set();
        this.disconnected = false;
        this.onUnload = ( ) => { this.disconnect(); };
        context.callOnUnload(this.onUnload);
        this.page = this.makePageObject(sender);
    }

    makePageObject(sender) {
        const context = this.context;
        const port = context.createObject();
        port.name = this.name;
        port.error = null;
        if ( sender !== undefined ) {
            port.sender = context.cloneOut(sender);
        }
        port.postMessage = context.exportFunction(message => {
            if ( this.disconnected ) {
                throw context.pageError(new ExtensionError('Attempt to postMessage on disconnected port'));
            }
            let data;
            try {
                data = context.cloneIn(message);
            } catch (ex) {
                throw context.pageError(new ExtensionError(`Could not clone message: ${ex.message}`));
            }
            for ( const peer of this.peers ) {
                peer.receive(data);
            }
        }, port);
        port.disconnect = context.exportFunction(( ) => { this.disconnect(); }, port);
        port.onMessage = makeListenerSet(context, this.messageListeners);
        port.onDisconnect = makeListenerSet(context, this.disconnectListeners);
        return port;
    }

    receive(data) {
        dispatch(( ) => {
            if ( this.disconnected || this.context.unloaded ) { return; }
            const message = this.context.cloneOut(data);
            for ( const fn of Array.from(this.messageListeners) ) {
                this.context.callPage(fn, [ message, this.page ]);
            }
        });
    }

    // This end closes the port.
    disconnect() {
        if ( this.disconnected ) { return; }
        this.close();
        for ( const peer of this.peers ) {
            peer.peers.delete(this);
            if ( peer.peers.size === 0 ) {
                peer.remoteDisconnected(null);
            }
        }
        this.peers.clear();
    }

    // The other end went away.
    remoteDisconnected(errorMessage) {
        dispatch(( ) => {
            if ( this.disconnected ) { return; }
            this.close();
            if ( this.context.unloaded ) { return; }
            if ( errorMessage !== null ) {
                this.page.error = this.context.pageError(new ExtensionError(errorMessage));
            }
            for ( const fn of Array.from(this.disconnectListeners) ) {
                this.context.callPage(fn, [ this.page ]);
            }
        });
    }

    close() {
        this.disconnected = true;
        this.context.forgetOnUnload(this.onUnload);
    }
};

const Messaging = class {
    constructor(extension) {
        this.extension = extension;
        this.onConnect = new EventManager('runtime.onConnect');
        this.onMessage = new EventManager('runtime.onMessage');
    }

    // As in Firefox, senders shown in a tab also send their tab.
    senderOf(context) {
        const sender = {
            id: this.extension.id,
            url: context.url,
            origin: context.origin,
            frameId: context.frameId,
            envType: context.isContentScript ? 'content_child' : 'addon_child',
        };
        const tracker = this.extension.tabTracker;
        const tab = tracker !== null ? tracker.tabForContext(context) : null;
        if ( tab !== null ) {
            sender.tab = tracker.convertTab(tab);
        }
        return sender;
    }

    // runtime.* messages reach extension pages only; content scripts are
    // reached through tabs.sendMessage() and tabs.connect() (api-content.js),
    // which pass their own `accept`.
    receiversOf(manager, context, accept = other => other.isContentScript === false) {
        const out = new Set();
        for ( const { context: other } of manager.listeners() ) {
            if ( other === context || other.unloaded || accept(other) === false ) { continue; }
            out.add(other);
        }
        return Array.from(out);
    }

    // connect([extensionId], [connectInfo])
    connect(context, ...args) {
        const info = args.find(a => a !== null && typeof a === 'object') || {};
        return this.connectTo(context, info.name, this.receiversOf(this.onConnect, context));
    }

    connectTo(context, portName, receivers) {
        const name = typeof portName === 'string' ? portName : '';
        const local = new PortEnd(context, name);
        if ( receivers.length === 0 ) {
            local.remoteDisconnected(NO_RECEIVER);
        }
        const sender = this.senderOf(context);
        for ( const other of receivers ) {
            const remote = new PortEnd(other, name, sender);
            remote.peers.add(local);
            local.peers.add(remote);
            dispatch(( ) => {
                if ( remote.disconnected ) { return; }
                this.onConnect.fireWith(( ) => [ remote.page ], other);
            });
        }
        return new PageValue(local.page);
    }

    // sendMessage([extensionId], message): resolves with the first response,
    // given through sendResponse() or a returned Promise.
    sendMessage(context, ...args) {
        const message = args.length > 1 && typeof args[0] === 'string' ? args[1] : args[0];
        return this.deliver(context, message, this.receiversOf(this.onMessage, context));
    }

    deliver(context, message, receivers) {
        if ( receivers.length === 0 ) {
            return Promise.reject(new ExtensionError(NO_RECEIVER));
        }
        const sender = this.senderOf(context);
        return new Promise((resolve, reject) => {
            dispatch(( ) => {
                let settled = false;
                let pending = 0;
                const settle = (ok, value) => {
                    if ( settled ) { return; }
                    settled = true;
                    (ok ? resolve : reject)(value);
                };
                for ( const other of receivers ) {
                    if ( other.unloaded ) { continue; }
                    const sendResponse = other.exportFunction(response => {
                        settle(true, other.cloneIn(response));
                    });
                    const results = this.onMessage.fireWith(ctx => [
                        ctx.cloneOut(message),
                        ctx.cloneOut(sender),
                        sendResponse,
                    ], other);
                    for ( const { value } of results ) {
                        if ( value === true ) {
                            pending += 1;
                            continue;
                        }
                        const waived = Cu.waiveXrays(value);
                        if ( waived === null || typeof waived !== 'object' ) { continue; }
                        if ( typeof waived.then !== 'function' ) { continue; }
                        pending += 1;
                        other.awaitPage(value).then(
                            v => { settle(true, v); },
                            e => { settle(false, e); }
                        );
                    }
                }
                if ( pending === 0 ) {
                    settle(true, undefined);
                }
            });
        });
    }
};

/******************************************************************************/

// storage.local and storage.sync live in a chrome IndexedDB database (one
// object store each, structured-clone values, like Firefox's own backend);
// storage.session in memory; storage.managed comes from a JSON pref, the
// natural admin channel on UXP (it can be locked through autoconfig).

const idbResult = request => new Promise((resolve, reject) => {
    request.onsuccess = ( ) => { resolve(request.result); };
    request.onerror = ( ) => { reject(request.error); };
});

const idbDone = transaction => new Promise((resolve, reject) => {
    transaction.oncomplete = ( ) => { resolve(); };
    transaction.onerror = transaction.onabort = ( ) => { reject(transaction.error); };
});

const normalizeKeys = function(keys) {
    if ( keys === null || keys === undefined ) {
        return { all: true, keys: [], defaults: null };
    }
    if ( typeof keys === 'string' ) {
        return { all: false, keys: [ keys ], defaults: null };
    }
    if ( Array.isArray(keys) ) {
        return { all: false, keys: keys.map(String), defaults: null };
    }
    if ( typeof keys === 'object' ) {
        return { all: false, keys: Object.keys(keys), defaults: keys };
    }
    throw new ExtensionError('Invalid storage keys');
};

const changeOf = (oldValue, newValue) => {
    const change = {};
    if ( oldValue !== undefined ) { change.oldValue = oldValue; }
    if ( newValue !== undefined ) { change.newValue = newValue; }
    return change;
};

// storage.local and storage.sync: one IndexedDB database of the browser's
// own (chrome) origin per extension.
const storageDatabaseName = addonId => `uxp-webext-storage:${addonId}`;

const StorageService = class {
    constructor(extension) {
        this.extension = extension;
        this.dbPromise = null;
        this.session = new Map();
        this.onChanged = new EventManager('storage.onChanged');
        this.areaChanged = {
            local: new EventManager('storage.local.onChanged'),
            session: new EventManager('storage.session.onChanged'),
            sync: new EventManager('storage.sync.onChanged'),
            managed: new EventManager('storage.managed.onChanged'),
        };
    }

    database() {
        if ( this.dbPromise === null ) {
            const request = indexedDB.open(storageDatabaseName(this.extension.id), 1);
            request.onupgradeneeded = ( ) => {
                const db = request.result;
                for ( const area of [ 'local', 'sync' ] ) {
                    if ( db.objectStoreNames.contains(area) ) { continue; }
                    db.createObjectStore(area);
                }
            };
            this.dbPromise = idbResult(request);
        }
        return this.dbPromise;
    }

    close() {
        if ( this.dbPromise !== null ) {
            this.dbPromise.then(db => { db.close(); }, ( ) => {});
            this.dbPromise = null;
        }
        this.session.clear();
    }

    async get(area, keys) {
        const wanted = normalizeKeys(keys);
        const found = new Map();
        if ( area === 'session' ) {
            for ( const key of wanted.all ? this.session.keys() : wanted.keys ) {
                if ( this.session.has(key) ) { found.set(key, this.session.get(key)); }
            }
        } else {
            const db = await this.database();
            const store = db.transaction(area, 'readonly').objectStore(area);
            if ( wanted.all ) {
                const [ storedKeys, values ] = await Promise.all([
                    idbResult(store.getAllKeys()),
                    idbResult(store.getAll()),
                ]);
                storedKeys.forEach((key, i) => { found.set(key, values[i]); });
            } else {
                const values = await Promise.all(wanted.keys.map(key => idbResult(store.get(key))));
                wanted.keys.forEach((key, i) => {
                    if ( values[i] !== undefined ) { found.set(key, values[i]); }
                });
            }
        }
        const out = {};
        if ( wanted.defaults !== null ) {
            for ( const key of wanted.keys ) {
                const value = found.has(key) ? found.get(key) : wanted.defaults[key];
                if ( value !== undefined ) { out[key] = value; }
            }
        } else {
            for ( const [ key, value ] of found ) { out[key] = value; }
        }
        return out;
    }

    async set(area, items) {
        if ( items === null || typeof items !== 'object' || Array.isArray(items) ) {
            throw new ExtensionError('storage.set() expects an object');
        }
        const entries = Object.entries(items).filter(([ , value ]) => value !== undefined);
        const changes = {};
        if ( area === 'session' ) {
            for ( const [ key, value ] of entries ) {
                changes[key] = changeOf(this.session.get(key), value);
                this.session.set(key, value);
            }
        } else {
            const db = await this.database();
            const transaction = db.transaction(area, 'readwrite');
            const store = transaction.objectStore(area);
            for ( const [ key, value ] of entries ) {
                const request = store.get(key);
                request.onsuccess = ( ) => {
                    changes[key] = changeOf(request.result, value);
                    store.put(value, key);
                };
            }
            await idbDone(transaction);
        }
        this.notify(area, changes);
    }

    async remove(area, keys) {
        const list = [].concat(keys).map(String);
        const changes = {};
        if ( area === 'session' ) {
            for ( const key of list ) {
                if ( this.session.has(key) === false ) { continue; }
                changes[key] = changeOf(this.session.get(key));
                this.session.delete(key);
            }
        } else {
            const db = await this.database();
            const transaction = db.transaction(area, 'readwrite');
            const store = transaction.objectStore(area);
            for ( const key of list ) {
                const request = store.get(key);
                request.onsuccess = ( ) => {
                    if ( request.result === undefined ) { return; }
                    changes[key] = changeOf(request.result);
                    store.delete(key);
                };
            }
            await idbDone(transaction);
        }
        this.notify(area, changes);
    }

    async clear(area) {
        const changes = {};
        if ( area === 'session' ) {
            for ( const [ key, value ] of this.session ) {
                changes[key] = changeOf(value);
            }
            this.session.clear();
        } else {
            const db = await this.database();
            const transaction = db.transaction(area, 'readwrite');
            const store = transaction.objectStore(area);
            const keysRequest = store.getAllKeys();
            const valuesRequest = store.getAll();
            valuesRequest.onsuccess = ( ) => {
                keysRequest.result.forEach((key, i) => {
                    changes[key] = changeOf(valuesRequest.result[i]);
                });
                store.clear();
            };
            await idbDone(transaction);
        }
        this.notify(area, changes);
    }

    // Chrome's definition: key length + JSON length of the value.
    async getBytesInUse(area, keys) {
        const items = await this.get(area, keys === undefined ? null : keys);
        let total = 0;
        for ( const [ key, value ] of Object.entries(items) ) {
            total += key.length + JSON.stringify(value).length;
        }
        return total;
    }

    getManaged(keys) {
        let store = null;
        try {
            store = JSON.parse(
                Services.prefs.getComplexValue(PREF_MANAGED_STORAGE, Ci.nsISupportsString).data
            );
        } catch (ex) {
        }
        if ( store === null || typeof store !== 'object' ) {
            throw new ExtensionError('Managed storage manifest not found');
        }
        const wanted = normalizeKeys(keys);
        if ( wanted.all ) { return store; }
        const out = {};
        for ( const key of wanted.keys ) {
            const value = store[key] !== undefined
                ? store[key]
                : wanted.defaults !== null ? wanted.defaults[key] : undefined;
            if ( value !== undefined ) { out[key] = value; }
        }
        return out;
    }

    notify(area, changes) {
        if ( Object.keys(changes).length === 0 ) { return; }
        this.areaChanged[area].fire(changes);
        this.onChanged.fire(changes, area);
    }

    namespace() {
        const area = name => ({
            get: apiAsync((context, keys) => this.get(name, keys)),
            set: apiAsync((context, items) => this.set(name, items)),
            remove: apiAsync((context, keys) => this.remove(name, keys)),
            clear: apiAsync(( ) => this.clear(name)),
            onChanged: this.areaChanged[name],
        });
        return {
            local: area('local'),
            session: Object.assign(area('session'), {
                QUOTA_BYTES: 10485760,
            }),
            sync: Object.assign(area('sync'), {
                getBytesInUse: apiAsync((context, keys) => this.getBytesInUse('sync', keys)),
                QUOTA_BYTES: 102400,
                QUOTA_BYTES_PER_ITEM: 8192,
                MAX_ITEMS: 512,
                MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
                MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
            }),
            managed: {
                get: apiAsync((context, keys) => this.getManaged(keys)),
                onChanged: this.areaChanged.managed,
            },
            onChanged: this.onChanged,
        };
    }
};

/******************************************************************************/

// Like Firefox, alarms do not persist across browser sessions.

const AlarmService = class {
    constructor() {
        this.alarms = new Map();
        this.onAlarm = new EventManager('alarms.onAlarm');
    }

    // create([name], alarmInfo)
    create(...args) {
        const name = typeof args[0] === 'string' ? args.shift() : '';
        const info = args[0] || {};
        const now = Date.now();
        let scheduledTime = now;
        if ( typeof info.when === 'number' ) {
            scheduledTime = info.when;
        } else if ( typeof info.delayInMinutes === 'number' ) {
            scheduledTime = now + info.delayInMinutes * 60000;
        } else if ( typeof info.periodInMinutes === 'number' ) {
            scheduledTime = now + info.periodInMinutes * 60000;
        }
        this.clear(name);
        const alarm = {
            name,
            scheduledTime,
            periodInMinutes: typeof info.periodInMinutes === 'number'
                ? info.periodInMinutes
                : undefined,
            timer: null,
        };
        this.alarms.set(name, alarm);
        this.arm(alarm);
    }

    arm(alarm) {
        alarm.timer = setTimeout(( ) => {
            this.ring(alarm);
        }, Math.max(0, alarm.scheduledTime - Date.now()));
    }

    ring(alarm) {
        if ( this.alarms.get(alarm.name) !== alarm ) { return; }
        const details = this.details(alarm);
        if ( alarm.periodInMinutes !== undefined ) {
            alarm.scheduledTime = Date.now() + alarm.periodInMinutes * 60000;
            this.arm(alarm);
        } else {
            this.alarms.delete(alarm.name);
        }
        this.onAlarm.fire(details);
    }

    details(alarm) {
        const details = { name: alarm.name, scheduledTime: alarm.scheduledTime };
        if ( alarm.periodInMinutes !== undefined ) {
            details.periodInMinutes = alarm.periodInMinutes;
        }
        return details;
    }

    get(name = '') {
        const alarm = this.alarms.get(name);
        return alarm !== undefined ? this.details(alarm) : undefined;
    }

    getAll() {
        return Array.from(this.alarms.values(), alarm => this.details(alarm));
    }

    clear(name = '') {
        const alarm = this.alarms.get(name);
        if ( alarm === undefined ) { return false; }
        clearTimeout(alarm.timer);
        this.alarms.delete(name);
        return true;
    }

    clearAll() {
        const names = Array.from(this.alarms.keys());
        for ( const name of names ) {
            this.clear(name);
        }
        return names.length !== 0;
    }
};

/******************************************************************************/

const platformInfo = function() {
    const { OS, XPCOMABI } = Services.appinfo;
    const os = { WINNT: 'win', Darwin: 'mac', Linux: 'linux' }[OS] || OS.toLowerCase();
    const arch = XPCOMABI.startsWith('x86_64')
        ? 'x86-64'
        : XPCOMABI.startsWith('x86') ? 'x86-32' : XPCOMABI.split('-')[0];
    return { os, arch };
};

const acceptLanguages = function() {
    let languages = '';
    try {
        languages = Services.prefs.getComplexValue(
            'intl.accept_languages',
            Ci.nsIPrefLocalizedString
        ).data;
    } catch (ex) {
    }
    return languages.split(',').map(s => s.trim()).filter(s => s !== '');
};

/******************************************************************************/

const createCoreAPIs = function(extension) {
    const messaging = new Messaging(extension);
    const storage = new StorageService(extension);
    const alarms = new AlarmService();
    const runtimeEvents = {
        onInstalled: new EventManager('runtime.onInstalled'),
        onStartup: new EventManager('runtime.onStartup'),
        onUpdateAvailable: new EventManager('runtime.onUpdateAvailable'),
    };
    extension.messaging = messaging;

    extension.onShutdown(( ) => {
        alarms.clearAll();
        storage.close();
    });

    // The parts of runtime and i18n Firefox also gives content scripts.
    // (Firefox gives them storage too; uBO's content scripts do not use it.)
    const contentRuntime = {
        id: extension.id,
        lastError: undefined,
        getURL: apiSync((ctx, path) => extension.getURL(path)),
        getManifest: apiSync(( ) => extension.localizedManifest()),
        connect: apiSync((ctx, ...args) => messaging.connect(ctx, ...args)),
        sendMessage: apiAsync((ctx, ...args) => messaging.sendMessage(ctx, ...args)),
        onConnect: messaging.onConnect,
        onMessage: messaging.onMessage,
    };
    const i18n = {
        getMessage: apiSync((ctx, name, substitutions) =>
            extension.localize(name, substitutions)
        ),
        getUILanguage: apiSync(( ) => extension.locales.uiLocale),
        getAcceptLanguages: apiAsync(( ) => acceptLanguages()),
        detectLanguage: apiAsync(( ) => ({ isReliable: false, languages: [] })),
    };

    // Built once: Extension.buildAPI() never modifies a module's tree.
    const pageTree = {
        runtime: Object.assign({
            getPlatformInfo: apiAsync(( ) => platformInfo()),
            getBrowserInfo: apiAsync(( ) => ({
                name: Services.appinfo.name,
                vendor: Services.appinfo.vendor,
                version: Services.appinfo.version,
                buildID: Services.appinfo.appBuildID,
            })),
            reload: apiSync(( ) => { dispatch(( ) => { extension.reload(); }); }),
        }, contentRuntime, runtimeEvents),
        i18n,
        storage: storage.namespace(),
        alarms: {
            create: apiSync((ctx, ...args) => { alarms.create(...args); }),
            get: apiAsync((ctx, name) => alarms.get(name)),
            getAll: apiAsync(( ) => alarms.getAll()),
            clear: apiAsync((ctx, name) => alarms.clear(name)),
            clearAll: apiAsync(( ) => alarms.clearAll()),
            onAlarm: alarms.onAlarm,
        },
    };
    const contentTree = { runtime: contentRuntime, i18n };

    return {
        build: ( ) => pageTree,
        buildContent: ( ) => contentTree,

        // Firefox fires these once the background page has loaded.
        onBackgroundLoaded(reason) {
            switch ( reason ) {
            case APP_STARTUP:
                runtimeEvents.onStartup.fire();
                break;
            case ADDON_INSTALL:
                runtimeEvents.onInstalled.fire({ reason: 'install', temporary: false });
                break;
            case ADDON_UPGRADE:
            case ADDON_DOWNGRADE:
                runtimeEvents.onInstalled.fire({
                    reason: 'update',
                    previousVersion: extension.previousVersion,
                    temporary: false,
                });
                break;
            default:
                break;
            }
        },
    };
};

/******************************************************************************/

// The add-on removed: its storage.local and storage.sync go too.
const forgetCoreData = function(addonId) {
    indexedDB.deleteDatabase(storageDatabaseName(addonId));
};

/******************************************************************************/

return { createCoreAPIs, forgetCoreData, PREF_MANAGED_STORAGE };

})();

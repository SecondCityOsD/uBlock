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

// The extension's parts of the browser's own UI: browserAction (toolbar
// button, its badge and its popup), menus (the content area's context menu),
// commands (keyboard shortcuts) and the options page (the Add-ons Manager's
// Options button, runtime.openOptionsPage()).
//
// Pale Moon has the classic toolbox: the button goes into the toolbar
// palette, and onto the toolbar whose persisted `currentset` names it (on
// first run, the navigation bar); its popup opens in an arrow panel.
// Basilisk has CustomizableUI: the button is a `view` widget whose panelview
// hosts the popup, as with Firefox 52's own browserAction. Every name given
// to the browser's UI starts with NAME_PREFIX (Extension.jsm): legacy uBO
// 1.16 may be installed beside the fork, with buttons, menus and keys of
// its own.
//
// Loaded into Extension.jsm's global (see there).

/* global Cc, Ci, Cu, Services, dispatch, windowUtilsOf, outerWindowIdOf, logMessage,
          MatchPattern, EventManager, ExtensionError, apiSync, apiAsync,
          NAME_PREFIX, PREF_BRANCH */
/* exported createUIAPIs, forgetBrowserUI */

'use strict';

var { createUIAPIs, forgetBrowserUI } = (( ) => {

const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const BROWSER_URL = 'chrome://browser/content/browser.xul';
const BUTTON_ID = `${NAME_PREFIX}-button`;
// The prefix is Firefox 52's for browserAction views: Basilisk's styles
// give those views up to 800 pixels and no padding, 360 to other views.
const BASILISK_VIEW_ID = `PanelUI-webext-${BUTTON_ID}-view`;
const POPUP_PANEL_MARK = `${NAME_PREFIX}-popup`;
const POPUP_BROWSER_CLASS = `${NAME_PREFIX}-popup-browser`;
const PREF_BUTTON_PLACED = `${PREF_BRANCH}toolbarButtonPlaced`;
const PREF_SHORTCUTS = `${PREF_BRANCH}shortcuts`;
const POPUP_MAX_WIDTH = 800;
const POPUP_MAX_HEIGHT = 600;
const MENU_MARK = `data-${NAME_PREFIX}-menu`;
const KEYSET_ID = `${NAME_PREFIX}-commands`;
// The CSS properties the runtime sets on its button and panel.
const cssProperty = name => `--${NAME_PREFIX}-${name}`;
const XPI_PROVIDER_URL = 'resource://gre/modules/addons/XPIProvider.jsm';
const { AUTHOR_SHEET } = Ci.nsIDOMWindowUtils;
const { AddonManager } = Cu.import('resource://gre/modules/AddonManager.jsm', {});

let CustomizableUI = null;
try {
    ({ CustomizableUI } = Cu.import('resource:///modules/CustomizableUI.jsm', {}));
} catch {
}

const hasOwn = (o, key) => Object.prototype.hasOwnProperty.call(o, key);

/******************************************************************************/

// Colors as browserAction takes them -- a CSS color, or [r, g, b, a] -- and
// as it returns them, [r, g, b, a].

let colorContext = null;

const cssColorOf = function(color) {
    if ( typeof color === 'string' ) { return color; }
    if (
        Array.isArray(color) && color.length === 4 &&
        color.every(c => Number.isInteger(c) && c >= 0 && c <= 255)
    ) {
        return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3] / 255})`;
    }
    throw new ExtensionError(`Invalid color: ${JSON.stringify(color)}`);
};

const rgbaOf = function(css) {
    if ( colorContext === null ) {
        colorContext = Services.appShell.hiddenDOMWindow.document
            .createElementNS(HTML_NS, 'canvas')
            .getContext('2d');
    }
    colorContext.fillStyle = '#000000';
    colorContext.fillStyle = css;
    // Serialized as "#rrggbb", or "rgba(r, g, b, a)" when not opaque.
    const value = colorContext.fillStyle;
    if ( value.startsWith('#') ) {
        return [ 1, 3, 5 ].map(i => parseInt(value.slice(i, i + 2), 16)).concat(255);
    }
    const [ r, g, b, a ] = value.slice(value.indexOf('(') + 1, -1).split(',').map(parseFloat);
    return [ r, g, b, Math.round(a * 255) ];
};

/******************************************************************************/

// Icons: size -> URL, from a path or paths by size, resolved against the
// caller's URL. Extension and data: images only.

const iconSetOf = function(extension, paths, baseURL) {
    const entries = typeof paths === 'string'
        ? [ [ '16', paths ] ]
        : paths !== null && typeof paths === 'object' ? Object.entries(paths) : [];
    const out = [];
    for ( const [ size, path ] of entries ) {
        const n = parseInt(size, 10);
        if ( (n > 0) === false || typeof path !== 'string' ) { continue; }
        let url = '';
        try {
            url = Services.io.newURI(path, null, Services.io.newURI(baseURL, null, null)).spec;
        } catch {
        }
        if ( extension.isOwnURL(url) || url.startsWith('data:image/') ) {
            out.push([ n, url ]);
        }
    }
    if ( out.length === 0 ) {
        throw new ExtensionError(`Invalid icon path: ${JSON.stringify(paths)}`);
    }
    return new Map(out.sort((a, b) => a[0] - b[0]));
};

// The icon for `size` CSS pixels on the window's display: the smallest
// with enough device pixels, else the largest.
const iconURLFor = function(icons, size, win) {
    const wanted = size * (win.devicePixelRatio || 1);
    let url = '';
    for ( const [ n, candidate ] of icons ) {
        url = candidate;
        if ( n >= wanted ) { break; }
    }
    return url;
};

const cssURL = url => `url("${url.replace(/"/g, '%22')}")`;

// Pages set by setPopup(), relative to the caller: the extension's own.
const ownURLOf = function(extension, path, baseURL) {
    let url = '';
    try {
        url = Services.io.newURI(path, null, Services.io.newURI(baseURL, null, null)).spec;
    } catch {
    }
    if ( extension.isOwnURL(url) === false ) {
        throw new ExtensionError(`Not an extension page: ${path}`);
    }
    return url;
};

/******************************************************************************/

// The panel a node is in, or null.
const panelOf = function(node) {
    for ( let n = node; n !== null; n = n.parentNode ) {
        if ( n.localName === 'panel' ) { return n; }
    }
    return null;
};

// The browser's panel arrow (chrome://global/skin/arrow/panelarrow-*.svg,
// the same in Pale Moon and Basilisk), filled with `color`.
const arrowImageOf = function(color, vertical) {
    const svg = vertical
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10">' +
          '<path d="M 0,10 L 10,0 20,10 z" fill="hsla(210,4%,10%,.2)"/>' +
          `<path d="M 1,10 L 10,1 19,10 z" fill="${color}"/></svg>`
        : '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20">' +
          '<path d="M 10,0 L 0,10 10,20 z" fill="hsla(210,4%,10%,.2)"/>' +
          `<path d="M 10,1 L 1,10 10,19 z" fill="${color}"/></svg>`;
    return cssURL(`data:image/svg+xml,${encodeURIComponent(svg)}`);
};

// A panel showing a popup has no padding, and the page's background color
// (as in Firefox): no frame of the browser's own color around the page, an
// arrow of the page's color. Before the page loads, the browser's colors.
const POPUP_PANEL_STYLE = `
panel[${POPUP_PANEL_MARK}] > .panel-arrowcontainer > .panel-arrowcontent {
    padding: 0 !important;
    background: var(${cssProperty('popup-background')}, -moz-field) !important;
}
panel[${POPUP_PANEL_MARK}] .panel-arrow[side="top"],
panel[${POPUP_PANEL_MARK}] .panel-arrow[side="bottom"] {
    list-style-image: var(${cssProperty('popup-arrow-vertical')},
        url("chrome://global/skin/arrow/panelarrow-vertical.svg")) !important;
}
panel[${POPUP_PANEL_MARK}] .panel-arrow[side="left"],
panel[${POPUP_PANEL_MARK}] .panel-arrow[side="right"] {
    list-style-image: var(${cssProperty('popup-arrow-horizontal')},
        url("chrome://global/skin/arrow/panelarrow-horizontal.svg")) !important;
}`;

const POPUP_PANEL_PROPERTIES = [
    cssProperty('popup-background'),
    cssProperty('popup-arrow-vertical'),
    cssProperty('popup-arrow-horizontal'),
];

// A popup page in a content <browser>, sized to its content (at most 800 by
// 600, as in Firefox). It may close itself with window.close().
//
// `fitted`: the popup is as wide as its container, which the browser sizes
// (Basilisk's menu panel, as with Firefox 52's popups there), and the page
// is laid out for that width; else it is as wide as its page needs.

const PopupView = class {
    constructor(container, url, onClose, fitted = false) {
        const browser = container.ownerDocument.createElementNS(XUL_NS, 'browser');
        const attributes = {
            type: 'content',
            disableglobalhistory: 'true',
            disablehistory: 'true',
            transparent: 'true',
            tooltip: 'aHTMLTooltip',
            class: POPUP_BROWSER_CLASS,
            src: url,
        };
        for ( const [ name, value ] of Object.entries(attributes) ) {
            browser.setAttribute(name, value);
        }
        // Wide at first: popup-fenix picks its layout from the width it
        // gets (its two panes side by side, or one above the other); then
        // shrunk to fit (see resize()).
        if ( fitted === false ) {
            browser.style.width = `${POPUP_MAX_WIDTH}px`;
        }
        browser.style.height = '1px';
        this.browser = browser;
        this.onClose = onClose;
        this.fitted = fitted;
        this.observer = null;
        this.resizePending = false;
        // The panel given the page's colors, and those colors.
        this.panel = null;
        this.color = '';
        for ( const type of PopupView.EVENTS ) {
            browser.addEventListener(type, this, true);
        }
        container.appendChild(browser);
        this.paintPanel();
    }

    handleEvent(event) {
        const { browser } = this;
        switch ( event.type ) {
        case 'DOMWindowClose':
            // Cancelled, or the browser window itself would close.
            event.preventDefault();
            event.stopPropagation();
            this.onClose();
            break;
        case 'DOMContentLoaded': {
            if ( event.target !== browser.contentDocument ) { break; }
            const win = browser.contentWindow;
            windowUtilsOf(win).allowScriptsToClose();
            this.observer = new win.MutationObserver(( ) => { this.resizeSoon(); });
            this.observer.observe(event.target, {
                attributes: true,
                characterData: true,
                childList: true,
                subtree: true,
            });
            this.resizeSoon();
            break;
        }
        default:
            this.resizeSoon();
            break;
        }
    }

    resizeSoon() {
        if ( this.resizePending ) { return; }
        this.resizePending = true;
        dispatch(( ) => {
            this.resizePending = false;
            this.resize();
        });
    }

    // The document's preferred size within the largest a popup may be --
    // fitted, the height it needs at the width it has -- measured as Firefox
    // measures its popups (in device pixels).
    resize() {
        const { browser } = this;
        if ( browser === null ) { return; }
        const maxWidth = this.fitted
            ? Math.floor(browser.getBoundingClientRect().width)
            : POPUP_MAX_WIDTH;
        // Not laid out yet: a later event comes.
        if ( maxWidth < 1 ) { return; }
        const width = {};
        const height = {};
        let ratio = 1;
        try {
            ratio = browser.contentWindow.devicePixelRatio || 1;
            browser.docShell.contentViewer.getContentSizeConstrained(
                maxWidth * ratio,
                POPUP_MAX_HEIGHT * ratio,
                width,
                height
            );
        } catch {
            return;
        }
        const size = (value, max) => Math.min(Math.max(Math.ceil(value / ratio), 1), max);
        if ( this.fitted === false ) {
            browser.style.width = `${size(width.value, POPUP_MAX_WIDTH)}px`;
        }
        browser.style.height = `${size(height.value, POPUP_MAX_HEIGHT)}px`;
        this.paintPanel();
    }

    // The panel around the page gets POPUP_PANEL_STYLE, then the page's
    // background color once it has one. Not Basilisk's menu panel: there
    // the page is one view among the panel's.
    paintPanel() {
        const panel = panelOf(this.browser);
        if ( panel !== this.panel ) {
            this.unpaintPanel();
            if ( panel === null || panel.id === 'PanelUI-popup' ) { return; }
            panel.setAttribute(POPUP_PANEL_MARK, 'true');
            this.panel = panel;
        }
        if ( this.panel === null ) { return; }
        let color = '';
        try {
            const doc = this.browser.contentDocument;
            color = doc.defaultView.getComputedStyle(doc.body).backgroundColor;
        } catch {
        }
        // Opaque colors only: the panel shows what is beneath a transparent
        // page.
        if ( /^rgb\(/.test(color) === false || color === this.color ) { return; }
        this.color = color;
        const { style } = this.panel;
        style.setProperty(POPUP_PANEL_PROPERTIES[0], color);
        style.setProperty(POPUP_PANEL_PROPERTIES[1], arrowImageOf(color, true));
        style.setProperty(POPUP_PANEL_PROPERTIES[2], arrowImageOf(color, false));
    }

    // Pale Moon's panel stays, for the next popup.
    unpaintPanel() {
        const { panel } = this;
        if ( panel === null ) { return; }
        this.panel = null;
        this.color = '';
        panel.removeAttribute(POPUP_PANEL_MARK);
        for ( const name of POPUP_PANEL_PROPERTIES ) {
            panel.style.removeProperty(name);
        }
    }

    destroy() {
        const { browser } = this;
        if ( browser === null ) { return; }
        this.unpaintPanel();
        this.browser = null;
        if ( this.observer !== null ) {
            try {
                this.observer.disconnect();
            } catch {
            }
            this.observer = null;
        }
        for ( const type of PopupView.EVENTS ) {
            browser.removeEventListener(type, this, true);
        }
        browser.remove();
    }
};
PopupView.EVENTS = [ 'DOMWindowClose', 'DOMContentLoaded', 'load', 'MozScrolledAreaChanged' ];

/******************************************************************************/

// Pale Moon: a palette toolbar button, and an arrow panel for the popup.

const PaleMoonButton = class {
    constructor(action) {
        this.action = action;
        this.id = BUTTON_ID;
        this.panelId = `${this.id}-panel`;
        this.buttons = new WeakMap();
        this.views = new WeakMap();
    }

    start() {
    }

    stop() {
    }

    attachWindow(win) {
        const doc = win.document;
        const toolbox = doc.getElementById('navigator-toolbox');
        if ( toolbox === null || !toolbox.palette || this.buttons.has(win) ) { return; }
        const button = doc.createElementNS(XUL_NS, 'toolbarbutton');
        button.id = this.id;
        button.setAttribute('class', 'toolbarbutton-1 chromeclass-toolbar-additional badged-button');
        button.setAttribute('removable', 'true');
        button.addEventListener('command', this);
        toolbox.palette.appendChild(button);
        this.buttons.set(win, button);
        this.place(doc, toolbox);
        const panel = doc.createElementNS(XUL_NS, 'panel');
        panel.id = this.panelId;
        panel.setAttribute('type', 'arrow');
        panel.addEventListener('popuphidden', this);
        doc.getElementById('mainPopupSet').appendChild(panel);
    }

    // Onto the toolbar whose persisted `currentset` names the button, where
    // it names it; on first run, at the end of the navigation bar.
    place(doc, toolbox) {
        const toolbars = Array.from(toolbox.externalToolbars || []);
        for ( const child of toolbox.children ) {
            if ( child.localName === 'toolbar' ) { toolbars.push(child); }
        }
        for ( const toolbar of toolbars ) {
            const currentset = (toolbar.getAttribute('currentset') || '').split(/\s*,\s*/);
            const index = currentset.indexOf(this.id);
            if ( index === -1 || typeof toolbar.insertItem !== 'function' ) { continue; }
            let before = null;
            for ( const id of currentset.slice(index + 1) ) {
                const node = doc.getElementById(id);
                if ( node !== null && node.parentNode === toolbar ) {
                    before = node;
                    break;
                }
            }
            toolbar.insertItem(this.id, before);
            return;
        }
        let placed = false;
        try {
            placed = Services.prefs.getBoolPref(PREF_BUTTON_PLACED);
        } catch {
        }
        const navbar = doc.getElementById('nav-bar');
        if ( placed || navbar === null || typeof navbar.insertItem !== 'function' ) { return; }
        navbar.insertItem(this.id, null);
        navbar.setAttribute('currentset', navbar.currentSet);
        doc.persist(navbar.id, 'currentset');
        Services.prefs.setBoolPref(PREF_BUTTON_PLACED, true);
    }

    // The button's place stays in `currentset`, for the next start.
    detachWindow(win) {
        const view = this.views.get(win);
        if ( view !== undefined ) {
            view.destroy();
            this.views.delete(win);
        }
        const button = this.buttons.get(win);
        if ( button !== undefined ) {
            button.removeEventListener('command', this);
            button.remove();
            this.buttons.delete(win);
        }
        const panel = win.document.getElementById(this.panelId);
        if ( panel !== null ) {
            panel.removeEventListener('popuphidden', this);
            panel.remove();
        }
    }

    nodeIn(win) {
        return this.buttons.get(win) || null;
    }

    handleEvent(event) {
        const win = event.currentTarget.ownerGlobal;
        if ( event.type === 'command' ) {
            this.action.activate(win);
            return;
        }
        // popuphidden, of the panel itself.
        if ( event.target !== event.currentTarget ) { return; }
        const view = this.views.get(win);
        if ( view !== undefined ) {
            view.destroy();
            this.views.delete(win);
        }
    }

    trigger(win) {
        this.action.activate(win);
    }

    // Opens the popup, or closes it if open.
    showPopup(win, url) {
        const panel = win.document.getElementById(this.panelId);
        if ( panel === null ) { return; }
        if ( panel.state === 'open' || panel.state === 'showing' ) {
            panel.hidePopup();
            return;
        }
        const previous = this.views.get(win);
        if ( previous !== undefined ) { previous.destroy(); }
        this.views.set(win, new PopupView(panel, url, ( ) => { panel.hidePopup(); }));
        const button = this.buttons.get(win);
        const anchor = button && button.getBoundingClientRect().width !== 0
            ? button
            : win.document.getElementById('nav-bar');
        panel.openPopup(anchor, 'bottomcenter topright', 0, 0, false, false);
    }
};

/******************************************************************************/

// Basilisk: a CustomizableUI `view` widget; its panelview hosts the popup.

const BasiliskButton = class {
    constructor(action) {
        this.action = action;
        this.id = BUTTON_ID;
        this.viewId = BASILISK_VIEW_ID;
        // Each window's panelview, and the popup each panelview shows.
        // While shown, the panelview is in a panel's anonymous content,
        // where getElementById() does not find it.
        this.viewNodes = new WeakMap();
        this.views = new WeakMap();
    }

    start() {
        const { action } = this;
        CustomizableUI.createWidget({
            id: this.id,
            viewId: this.viewId,
            type: 'view',
            removable: true,
            label: action.defaults.title,
            tooltiptext: action.defaults.title,
            defaultArea: CustomizableUI.AREA_NAVBAR,
            onBeforeCreated: doc => {
                const view = doc.createElementNS(XUL_NS, 'panelview');
                view.id = this.viewId;
                view.setAttribute('flex', '1');
                doc.getElementById('PanelUI-multiView').appendChild(view);
                this.viewNodes.set(doc.defaultView, view);
            },
            // Rendered with the node given: looking it up from here would
            // build it again.
            onCreated: node => {
                node.classList.add('badged-button');
                action.renderWindow(node.ownerGlobal, node);
            },
            onViewShowing: event => { this.onViewShowing(event); },
            onViewHiding: event => { this.onViewHiding(event); },
        });
    }

    // A popup still shown goes first, with its panel.
    stop() {
        CustomizableUI.destroyWidget(this.id);
        for ( const win of this.action.ui.tracker.windows ) {
            const node = this.viewNodes.get(win);
            if ( node === undefined ) { continue; }
            this.viewNodes.delete(win);
            const view = this.views.get(node);
            if ( view !== undefined ) {
                view.destroy();
                this.views.delete(node);
            }
            const panel = panelOf(node);
            if ( panel !== null && panel.state !== 'closed' && typeof panel.hidePopup === 'function' ) {
                panel.hidePopup();
            }
            node.remove();
        }
    }

    attachWindow() {
    }

    detachWindow() {
    }

    nodeIn(win) {
        const widget = CustomizableUI.getWidget(this.id);
        return widget ? widget.forWindow(win).node || null : null;
    }

    onViewShowing(event) {
        const view = event.target;
        const win = view.ownerGlobal;
        const url = this.action.popupFor(win);
        if ( url === '' ) {
            event.preventDefault();
            this.action.clicked(win);
            return;
        }
        const previous = this.views.get(view);
        if ( previous !== undefined ) { previous.destroy(); }
        this.views.set(view, new PopupView(view, url, ( ) => {
            CustomizableUI.hidePanelForNode(view);
        }, this.inMenuPanel(view)));
    }

    // The menu panel sizes its subviews (a popup there is fitted to its
    // view, as with Firefox 52's); a popup elsewhere is as wide as it needs.
    inMenuPanel(view) {
        const panel = panelOf(view);
        return panel !== null && panel.id === 'PanelUI-popup';
    }

    onViewHiding(event) {
        const view = this.views.get(event.target);
        if ( view === undefined ) { return; }
        view.destroy();
        this.views.delete(event.target);
    }

    // As a click: CustomizableUI shows the view wherever the button is.
    trigger(win) {
        const group = CustomizableUI.getWidget(this.id);
        const node = this.nodeIn(win);
        if ( !group || node === null ) { return; }
        const click = ( ) => {
            node.dispatchEvent(new win.CustomEvent('command', { bubbles: true, cancelable: true }));
        };
        if ( group.areaType === CustomizableUI.TYPE_MENU_PANEL ) {
            Promise.resolve(win.PanelUI.show()).then(click);
            return;
        }
        click();
    }
};

/******************************************************************************/

// browserAction: defaults, and per-tab values which a navigation to a new
// document clears (as in Firefox).

const buttonStyleOf = id => `
#${id} {
    list-style-image: var(${cssProperty('icon')}) !important;
    -moz-image-region: auto !important;
}
#${id}[cui-areatype="menu-panel"],
toolbarpaletteitem[place="palette"] > #${id} {
    list-style-image: var(${cssProperty('icon-large')}) !important;
}
toolbar #${id} > .toolbarbutton-badge-stack > .toolbarbutton-icon {
    width: 16px;
    height: 16px;
}
#${id} .toolbarbutton-badge {
    background: var(${cssProperty('badge-background')}) !important;
    color: var(${cssProperty('badge-color')}) !important;
}
#${id} .toolbarbutton-badge[value=""] {
    display: none !important;
}`;

const BrowserAction = class {
    constructor(ui) {
        const { extension } = ui;
        const manifest = extension.localizedManifest();
        const details = manifest.browser_action || {};
        const root = extension.getURL('');
        this.ui = ui;
        this.extension = extension;
        this.manifestDefaults = {
            title: details.default_title || manifest.name,
            icons: iconSetOf(extension, details.default_icon || manifest.icons, root),
            popup: typeof details.default_popup === 'string' && details.default_popup !== ''
                ? ownURLOf(extension, details.default_popup, root)
                : '',
            badgeText: '',
            // Firefox's
            badgeBackgroundColor: 'rgb(217, 0, 0)',
            badgeTextColor: 'rgb(255, 255, 255)',
            enabled: true,
        };
        this.defaults = Object.assign({}, this.manifestDefaults);
        this.tabValues = new Map();
        this.onClicked = new EventManager('browserAction.onClicked');
        this.host = CustomizableUI !== null
            ? new BasiliskButton(this)
            : new PaleMoonButton(this);
        this.styleURI = `data:text/css;charset=utf-8,${
            encodeURIComponent(buttonStyleOf(this.host.id) + POPUP_PANEL_STYLE)
        }`;
    }

    start() {
        this.host.start();
    }

    stop() {
        this.host.stop();
    }

    attachWindow(win) {
        windowUtilsOf(win).loadSheetUsingURIString(this.styleURI, AUTHOR_SHEET);
        this.host.attachWindow(win);
        this.renderWindow(win);
    }

    detachWindow(win) {
        this.host.detachWindow(win);
        try {
            windowUtilsOf(win).removeSheetUsingURIString(this.styleURI, AUTHOR_SHEET);
        } catch {
        }
    }

    /**************************************************************************/

    selectedTabIdOf(win) {
        return win.gBrowser ? this.ui.tracker.getId(win.gBrowser.selectedBrowser) : undefined;
    }

    stateOf(tabId) {
        const values = tabId !== undefined ? this.tabValues.get(tabId) : undefined;
        return values !== undefined ? Object.assign({}, this.defaults, values) : this.defaults;
    }

    // The button shows the state of the window's selected tab.
    renderWindow(win, node = this.host.nodeIn(win)) {
        if ( node === null || !win.gBrowser ) { return; }
        const state = this.stateOf(this.selectedTabIdOf(win));
        node.setAttribute('label', state.title);
        node.setAttribute('tooltiptext', state.title);
        node.setAttribute('badge', state.badgeText);
        if ( state.enabled ) {
            node.removeAttribute('disabled');
        } else {
            node.setAttribute('disabled', 'true');
        }
        const { style } = node;
        style.setProperty(cssProperty('icon'), cssURL(iconURLFor(state.icons, 16, win)));
        style.setProperty(cssProperty('icon-large'), cssURL(iconURLFor(state.icons, 32, win)));
        style.setProperty(cssProperty('badge-background'), state.badgeBackgroundColor);
        style.setProperty(cssProperty('badge-color'), state.badgeTextColor);
    }

    // A change for `tabId` shows where the tab is selected; a change of
    // the defaults, everywhere.
    refresh(tabId) {
        for ( const win of this.ui.tracker.windows ) {
            if ( tabId === undefined || this.selectedTabIdOf(win) === tabId ) {
                this.renderWindow(win);
            }
        }
    }

    onTabNavigated(tabId) {
        if ( this.tabValues.delete(tabId) ) {
            this.refresh(tabId);
        }
    }

    onTabRemoved(tabId) {
        this.tabValues.delete(tabId);
    }

    /**************************************************************************/

    tabIdOf(details) {
        const tabId = details !== null && typeof details === 'object' ? details.tabId : undefined;
        if ( tabId === undefined || tabId === null ) { return undefined; }
        if ( this.ui.tracker.tabById(tabId) === null ) {
            throw new ExtensionError(`Invalid tab ID: ${tabId}`);
        }
        return tabId;
    }

    // A tab's value, or without a tab the default. null removes the tab's
    // value, or restores the manifest's default.
    set(details, key, value) {
        const tabId = this.tabIdOf(details);
        if ( tabId === undefined ) {
            this.defaults[key] = value !== null ? value : this.manifestDefaults[key];
        } else if ( value === null ) {
            const values = this.tabValues.get(tabId);
            if ( values !== undefined ) { delete values[key]; }
        } else {
            let values = this.tabValues.get(tabId);
            if ( values === undefined ) {
                values = {};
                this.tabValues.set(tabId, values);
            }
            values[key] = value;
        }
        this.refresh(tabId);
    }

    get(details, key) {
        return this.stateOf(this.tabIdOf(details))[key];
    }

    popupFor(win) {
        const state = this.stateOf(this.selectedTabIdOf(win));
        return state.enabled ? state.popup : '';
    }

    clicked(win) {
        const tab = this.ui.tracker.convertTab(win.gBrowser.selectedTab);
        this.onClicked.fire(tab, { button: 0, modifiers: [] });
    }

    // What a click on the button does (Pale Moon; on Basilisk,
    // CustomizableUI does it).
    activate(win) {
        const state = this.stateOf(this.selectedTabIdOf(win));
        if ( state.enabled === false ) { return; }
        if ( state.popup === '' ) {
            this.clicked(win);
            return;
        }
        this.host.showPopup(win, state.popup);
    }

    // The button's action from elsewhere: _execute_browser_action,
    // browserAction.openPopup().
    trigger(win) {
        this.host.trigger(win);
    }

    namespace() {
        const { extension } = this;
        const checked = details => {
            if ( details === null || typeof details !== 'object' ) {
                throw new ExtensionError('Missing details');
            }
            return details;
        };
        const setter = (key, valueOf) => apiAsync((context, details) => {
            const value = valueOf(checked(details), context);
            this.set(details, key, value);
        });
        const getter = (key, convert = v => v) => apiAsync((context, details) =>
            convert(this.get(details, key))
        );
        const nullOr = (value, convert) => value === null ? null : convert(value);
        const enabler = enabled => apiAsync((context, tabId) => {
            this.set(tabId === undefined || tabId === null ? {} : { tabId }, 'enabled', enabled);
        });
        return {
            setTitle: setter('title', d => nullOr(d.title, String)),
            getTitle: getter('title'),
            setIcon: setter('icons', (d, context) => {
                if ( d.path === undefined ) {
                    throw new ExtensionError('setIcon: only `path` is supported');
                }
                return iconSetOf(extension, d.path, context.url);
            }),
            setPopup: setter('popup', (d, context) => nullOr(d.popup, popup =>
                popup === '' ? '' : ownURLOf(extension, popup, context.url)
            )),
            getPopup: getter('popup'),
            setBadgeText: setter('badgeText', d => nullOr(d.text, String)),
            getBadgeText: getter('badgeText'),
            setBadgeBackgroundColor: setter('badgeBackgroundColor', d => nullOr(d.color, cssColorOf)),
            getBadgeBackgroundColor: getter('badgeBackgroundColor', rgbaOf),
            setBadgeTextColor: setter('badgeTextColor', d => nullOr(d.color, cssColorOf)),
            getBadgeTextColor: getter('badgeTextColor', rgbaOf),
            enable: enabler(true),
            disable: enabler(false),
            isEnabled: getter('enabled'),
            openPopup: apiAsync(( ) => {
                const win = Services.wm.getMostRecentWindow('navigator:browser');
                if ( win !== null ) { this.trigger(win); }
            }),
            onClicked: this.onClicked,
        };
    }
};

/******************************************************************************/

// menus: items in the content area's context menu. As in Firefox, several
// top-level items go into a submenu named after the extension, and the
// click handler gets Firefox's OnClickData.

const ITEM_TYPES = new Set([ 'normal', 'checkbox', 'radio', 'separator' ]);
const ITEM_CONTEXTS = new Set([
    'all', 'audio', 'editable', 'frame', 'image', 'link', 'page', 'selection', 'video',
]);

const ContextMenus = class {
    constructor(ui) {
        this.ui = ui;
        this.extension = ui.extension;
        this.items = new Map();
        this.nextId = 1;
        this.onClicked = new EventManager('menus.onClicked');
        this.onShown = new EventManager('menus.onShown');
        this.onHidden = new EventManager('menus.onHidden');
        const manifest = this.extension.manifest;
        let icons = null;
        try {
            icons = iconSetOf(this.extension, manifest.icons, this.extension.getURL(''));
        } catch {
        }
        this.icons = icons;
    }

    /**************************************************************************/

    create(props) {
        if ( props === null || typeof props !== 'object' ) {
            throw new ExtensionError('Missing menu item properties');
        }
        const id = props.id !== undefined ? props.id : this.nextId++;
        if ( this.items.has(id) ) {
            throw new ExtensionError(`Menu item ID already exists: ${id}`);
        }
        const item = {
            id,
            parentId: undefined,
            type: 'normal',
            title: '',
            contexts: [ 'page' ],
            documentPatterns: null,
            targetPatterns: null,
            enabled: true,
            visible: true,
            checked: false,
        };
        this.apply(item, props);
        if ( item.type !== 'separator' && item.title === '' ) {
            throw new ExtensionError('A menu item needs a title');
        }
        this.items.set(id, item);
        return id;
    }

    apply(item, props) {
        if ( props.type !== undefined ) {
            if ( ITEM_TYPES.has(props.type) === false ) {
                throw new ExtensionError(`Invalid menu item type: ${props.type}`);
            }
            item.type = props.type;
        }
        if ( props.title !== undefined ) { item.title = String(props.title); }
        if ( props.contexts !== undefined ) {
            const contexts = [].concat(props.contexts);
            const unknown = contexts.find(c => ITEM_CONTEXTS.has(c) === false);
            if ( unknown !== undefined ) {
                throw new ExtensionError(`Unsupported menu context: ${unknown}`);
            }
            item.contexts = contexts;
        }
        if ( props.documentUrlPatterns !== undefined ) {
            item.documentPatterns = props.documentUrlPatterns === null
                ? null
                : new MatchPattern(props.documentUrlPatterns);
        }
        if ( props.targetUrlPatterns !== undefined ) {
            item.targetPatterns = props.targetUrlPatterns === null
                ? null
                : new MatchPattern(props.targetUrlPatterns);
        }
        for ( const flag of [ 'enabled', 'visible', 'checked' ] ) {
            if ( props[flag] !== undefined ) { item[flag] = props[flag] === true; }
        }
        if ( props.parentId !== undefined ) {
            if ( props.parentId !== null && this.items.has(props.parentId) === false ) {
                throw new ExtensionError(`No menu item with ID ${props.parentId}`);
            }
            for ( let id = props.parentId; id !== undefined && id !== null; id = this.items.get(id).parentId ) {
                if ( id === item.id ) {
                    throw new ExtensionError('A menu item cannot be its own ancestor');
                }
            }
            item.parentId = props.parentId === null ? undefined : props.parentId;
        }
    }

    update(id, props) {
        const item = this.items.get(id);
        if ( item === undefined ) {
            throw new ExtensionError(`No menu item with ID ${id}`);
        }
        if ( props !== null && typeof props === 'object' ) {
            this.apply(item, props);
        }
    }

    remove(id) {
        if ( this.items.has(id) === false ) {
            throw new ExtensionError(`No menu item with ID ${id}`);
        }
        this.items.delete(id);
        for ( const item of Array.from(this.items.values()) ) {
            if ( item.parentId === id && this.items.has(item.id) ) {
                this.remove(item.id);
            }
        }
    }

    removeAll() {
        this.items.clear();
    }

    /**************************************************************************/

    attachWindow(win) {
        const menu = win.document.getElementById('contentAreaContextMenu');
        if ( menu === null ) { return; }
        menu.addEventListener('popupshowing', this);
    }

    detachWindow(win) {
        const menu = win.document.getElementById('contentAreaContextMenu');
        if ( menu === null ) { return; }
        menu.removeEventListener('popupshowing', this);
        this.clear(menu);
    }

    // popupshowing, of the menu itself (not of a submenu).
    handleEvent(event) {
        const menu = event.currentTarget;
        if ( event.target === menu ) {
            this.onMenuShowing(menu);
        }
    }

    // The items are rebuilt each time: removing them when the menu hides
    // could come before the clicked item's command.
    clear(menu) {
        for ( const node of Array.from(menu.querySelectorAll(`[${MENU_MARK}]`)) ) {
            node.remove();
        }
    }

    onMenuShowing(menu) {
        this.clear(menu);
        const cm = menu.ownerGlobal.gContextMenu;
        if ( !cm || !cm.browser ) { return; }
        const data = this.contextDataOf(cm);
        const roots = this.shownChildren(undefined, data);
        if ( roots.length === 0 ) { return; }
        const doc = menu.ownerDocument;
        let top;
        if ( roots.length === 1 ) {
            top = this.buildNode(doc, roots[0], data);
        } else {
            top = doc.createElementNS(XUL_NS, 'menu');
            top.setAttribute('label', this.extension.localizedManifest().name);
            const popup = doc.createElementNS(XUL_NS, 'menupopup');
            for ( const item of roots ) {
                popup.appendChild(this.buildNode(doc, item, data));
            }
            top.appendChild(popup);
        }
        if ( this.icons !== null && top.localName !== 'menuseparator' ) {
            top.classList.add(top.localName === 'menu' ? 'menu-iconic' : 'menuitem-iconic');
            top.setAttribute('image', iconURLFor(this.icons, 16, menu.ownerGlobal));
        }
        const separator = doc.createElementNS(XUL_NS, 'menuseparator');
        const anchor = doc.getElementById('inspect-separator');
        for ( const node of [ separator, top ] ) {
            node.setAttribute(MENU_MARK, 'true');
            menu.insertBefore(node, anchor !== null && anchor.parentNode === menu ? anchor : null);
        }
    }

    shownChildren(parentId, data) {
        return Array.from(this.items.values()).filter(item =>
            item.parentId === parentId && this.matches(item, data)
        );
    }

    matches(item, data) {
        if ( item.visible === false ) { return false; }
        if ( item.contexts.some(c => data.contexts.has(c)) === false ) { return false; }
        if (
            item.documentPatterns !== null &&
            item.documentPatterns.matches(data.frameUrl || data.pageUrl) === false
        ) {
            return false;
        }
        if ( item.targetPatterns !== null ) {
            const targets = [ data.srcUrl, data.linkUrl ].filter(url => url !== undefined);
            if ( targets.some(url => item.targetPatterns.matches(url)) === false ) {
                return false;
            }
        }
        return true;
    }

    buildNode(doc, item, data) {
        if ( item.type === 'separator' ) {
            return doc.createElementNS(XUL_NS, 'menuseparator');
        }
        const children = this.shownChildren(item.id, data);
        let node;
        if ( children.length !== 0 ) {
            node = doc.createElementNS(XUL_NS, 'menu');
            const popup = doc.createElementNS(XUL_NS, 'menupopup');
            for ( const child of children ) {
                popup.appendChild(this.buildNode(doc, child, data));
            }
            node.appendChild(popup);
        } else {
            node = doc.createElementNS(XUL_NS, 'menuitem');
            if ( item.type === 'checkbox' || item.type === 'radio' ) {
                node.setAttribute('type', item.type);
                node.setAttribute('checked', String(item.checked));
            }
            node.addEventListener('command', event => {
                this.onItemCommand(item, data, event);
            });
        }
        const selection = data.selectionText || '';
        node.setAttribute('label', item.title.replace(/%s/g, selection));
        if ( item.enabled === false ) {
            node.setAttribute('disabled', 'true');
        }
        return node;
    }

    contextDataOf(cm) {
        const target = cm.target || null;
        const doc = target !== null ? target.ownerDocument : null;
        const win = doc !== null ? doc.defaultView : null;
        const contexts = new Set();
        if ( cm.inFrame ) { contexts.add('frame'); }
        if ( cm.isTextSelected ) { contexts.add('selection'); }
        if ( cm.onLink ) { contexts.add('link'); }
        if ( cm.onEditableArea || cm.onTextInput ) { contexts.add('editable'); }
        if ( cm.onImage ) { contexts.add('image'); }
        if ( cm.onVideo ) { contexts.add('video'); }
        if ( cm.onAudio ) { contexts.add('audio'); }
        if ( contexts.size === 0 ) { contexts.add('page'); }
        contexts.add('all');
        let mediaType;
        if ( cm.onImage ) {
            mediaType = 'image';
        } else if ( cm.onVideo ) {
            mediaType = 'video';
        } else if ( cm.onAudio ) {
            mediaType = 'audio';
        }
        let selectionText;
        if ( cm.isTextSelected && win !== null ) {
            selectionText = String(win.getSelection());
        }
        return {
            contexts,
            tab: this.ui.tracker.tabForBrowser(cm.browser),
            pageUrl: cm.browser.currentURI.spec,
            frameUrl: cm.inFrame && doc !== null ? doc.documentURI : undefined,
            frameId: win !== null && win.top !== win ? outerWindowIdOf(win) : 0,
            linkUrl: cm.onLink ? cm.linkURL : undefined,
            linkText: cm.onLink && typeof cm.linkTextStr === 'string' ? cm.linkTextStr : undefined,
            srcUrl: mediaType !== undefined ? cm.mediaURL : undefined,
            mediaType,
            selectionText,
            editable: Boolean(cm.onEditableArea || cm.onTextInput),
        };
    }

    onItemCommand(item, data, event) {
        const wasChecked = item.checked;
        if ( item.type === 'checkbox' ) {
            item.checked = !item.checked;
        } else if ( item.type === 'radio' ) {
            for ( const other of this.items.values() ) {
                if ( other.type === 'radio' && other.parentId === item.parentId ) {
                    other.checked = false;
                }
            }
            item.checked = true;
        }
        const info = {
            menuItemId: item.id,
            editable: data.editable,
            modifiers: [
                [ 'shiftKey', 'Shift' ],
                [ 'ctrlKey', 'Ctrl' ],
                [ 'altKey', 'Alt' ],
                [ 'metaKey', 'Command' ],
            ].filter(([ flag ]) => event[flag]).map(([ , name ]) => name),
            button: 0,
        };
        const optional = {
            parentMenuItemId: item.parentId,
            pageUrl: data.pageUrl,
            frameUrl: data.frameUrl,
            frameId: data.frameId,
            linkUrl: data.linkUrl,
            linkText: data.linkText,
            srcUrl: data.srcUrl,
            mediaType: data.mediaType,
            selectionText: data.selectionText,
        };
        for ( const [ key, value ] of Object.entries(optional) ) {
            if ( value !== undefined ) { info[key] = value; }
        }
        if ( item.type === 'checkbox' || item.type === 'radio' ) {
            info.checked = item.checked;
            info.wasChecked = wasChecked;
        }
        const tab = data.tab !== null ? this.ui.tracker.convertTab(data.tab) : undefined;
        this.onClicked.fire(info, tab);
    }

    namespace() {
        return {
            ACTION_MENU_TOP_LEVEL_LIMIT: 6,
            create: apiSync((context, props) => this.create(props)),
            update: apiAsync((context, id, props) => { this.update(id, props); }),
            remove: apiAsync((context, id) => { this.remove(id); }),
            removeAll: apiAsync(( ) => { this.removeAll(); }),
            refresh: apiAsync(( ) => {}),
            onClicked: this.onClicked,
            onShown: this.onShown,
            onHidden: this.onHidden,
        };
    }
};

/******************************************************************************/

// commands: the manifest's commands as XUL <key>s in every browser window.
// UXP has no UI for extension shortcuts: commands.update() sets them, and
// they persist in a pref (JSON, name -> shortcut; '' for none).

const MODIFIERS = {
    Alt: 'alt',
    Command: 'accel',
    Ctrl: 'accel',
    MacCtrl: 'control',
    Shift: 'shift',
};

// A shortcut ("Ctrl+Shift+U", "Alt+F7") as the attributes of a <key>, the
// way Firefox converts it; null if it is not a valid shortcut.
const keyAttributesOf = function(shortcut) {
    const parts = shortcut.split('+').map(s => s.trim());
    const key = parts.pop();
    const modifiers = parts.map(m => MODIFIERS[m]);
    if ( modifiers.includes(undefined) || new Set(modifiers).size !== modifiers.length ) {
        return null;
    }
    if ( /^[A-Z]$/.test(key) ) {
        return modifiers.length !== 0 ? { modifiers: modifiers.join(','), key } : null;
    }
    const keycode = /^[0-9]$/.test(key)
        ? `VK_${key}`
        : `VK${key.replace(/[A-Z]/g, '_$&').toUpperCase()}`;
    if ( typeof Ci.nsIDOMKeyEvent[`DOM_${keycode}`] !== 'number' ) { return null; }
    // Only function and media keys may go without a modifier.
    if ( modifiers.length === 0 && /^VK_(?:F\d+|MEDIA_\w+)$/.test(keycode) === false ) {
        return null;
    }
    return { modifiers: modifiers.join(','), keycode };
};

const Commands = class {
    constructor(ui) {
        this.ui = ui;
        this.declared = ui.extension.manifest.commands || {};
        this.onCommand = new EventManager('commands.onCommand');
        this.overrides = {};
        try {
            const stored = JSON.parse(Services.prefs.getCharPref(PREF_SHORTCUTS));
            if ( stored !== null && typeof stored === 'object' ) { this.overrides = stored; }
        } catch {
        }
    }

    suggestedShortcutOf(name) {
        const suggested = this.declared[name].suggested_key;
        if ( suggested === null || typeof suggested !== 'object' ) { return ''; }
        const os = { WINNT: 'windows', Darwin: 'mac', Linux: 'linux' }[Services.appinfo.OS];
        return suggested[os] || suggested.default || '';
    }

    shortcutOf(name) {
        return hasOwn(this.overrides, name) ? this.overrides[name] : this.suggestedShortcutOf(name);
    }

    getAll() {
        const { extension } = this.ui;
        return Object.keys(this.declared).map(name => ({
            name,
            description: extension.localizeString(this.declared[name].description || ''),
            shortcut: this.shortcutOf(name),
        }));
    }

    checkName(name) {
        if ( typeof name !== 'string' || hasOwn(this.declared, name) === false ) {
            throw new ExtensionError(`Unknown command: ${name}`);
        }
    }

    update(details) {
        if ( details === null || typeof details !== 'object' ) {
            throw new ExtensionError('Missing details');
        }
        this.checkName(details.name);
        if ( details.shortcut === undefined ) { return; }
        const shortcut = details.shortcut === null ? '' : String(details.shortcut);
        if ( shortcut !== '' && keyAttributesOf(shortcut) === null ) {
            throw new ExtensionError(`Invalid shortcut: ${shortcut}`);
        }
        this.overrides[details.name] = shortcut;
        this.save();
    }

    reset(name) {
        this.checkName(name);
        delete this.overrides[name];
        this.save();
    }

    save() {
        if ( Object.keys(this.overrides).length === 0 ) {
            Services.prefs.clearUserPref(PREF_SHORTCUTS);
        } else {
            Services.prefs.setCharPref(PREF_SHORTCUTS, JSON.stringify(this.overrides));
        }
        for ( const win of this.ui.tracker.windows ) {
            this.detachWindow(win);
            this.attachWindow(win);
        }
    }

    attachWindow(win) {
        const doc = win.document;
        const keyset = doc.createElementNS(XUL_NS, 'keyset');
        keyset.id = KEYSET_ID;
        for ( const name of Object.keys(this.declared) ) {
            const shortcut = this.shortcutOf(name);
            const attributes = shortcut !== '' ? keyAttributesOf(shortcut) : null;
            if ( attributes === null ) { continue; }
            const key = doc.createElementNS(XUL_NS, 'key');
            for ( const [ attribute, value ] of Object.entries(attributes) ) {
                if ( value !== '' ) { key.setAttribute(attribute, value); }
            }
            // A <key> without a command does not fire.
            key.setAttribute('oncommand', '//');
            key.addEventListener('command', ( ) => { this.onKey(win, name); });
            keyset.appendChild(key);
        }
        if ( keyset.firstChild === null ) { return; }
        doc.documentElement.appendChild(keyset);
    }

    detachWindow(win) {
        const keyset = win.document.getElementById(KEYSET_ID);
        if ( keyset !== null ) { keyset.remove(); }
    }

    onKey(win, name) {
        if ( name === '_execute_browser_action' ) {
            this.ui.action.trigger(win);
            return;
        }
        this.onCommand.fire(name, this.ui.tracker.convertTab(win.gBrowser.selectedTab));
    }

    namespace() {
        return {
            getAll: apiAsync(( ) => this.getAll()),
            update: apiAsync((context, details) => { this.update(details); }),
            reset: apiAsync((context, name) => { this.reset(name); }),
            onCommand: this.onCommand,
        };
    }
};

/******************************************************************************/

// options_ui: the add-on's options in the Add-ons Manager, also opened by
// runtime.openOptionsPage(). Firefox shows the page inside about:addons, or
// with open_in_tab in a tab; UXP's about:addons cannot host an extension
// page, so here it is always a tab. Both open it as Firefox does, through
// the browser's switchToTabHavingURI(): a tab showing that exact URL is
// selected, else a new one opens.
//
// The page's URL has the per-profile UUID, which install.rdf cannot know:
// it goes into the add-on database, where about:addons reads it, at every
// startup. That database is internal to the Add-ons Manager (no public API
// sets an add-on's options); if it ever goes, there is just no Options
// button.

const OptionsPage = class {
    constructor(extension) {
        this.extension = extension;
        const options = extension.manifest.options_ui;
        this.url = options instanceof Object && typeof options.page === 'string'
            ? extension.getURL(options.page)
            : '';
    }

    register() {
        if ( this.url === '' ) { return; }
        // From XPIProvider.jsm's global, another compartment: no instanceof.
        let database = null;
        try {
            database = Cu.import(XPI_PROVIDER_URL, {}).XPIDatabase;
        } catch {
        }
        if (
            database === null || typeof database !== 'object' ||
            typeof database.getVisibleAddonForID !== 'function' ||
            typeof database.setAddonProperties !== 'function'
        ) {
            logMessage('no Options button in the Add-ons Manager: its add-on database is not available');
            return;
        }
        const properties = {
            optionsType: AddonManager.OPTIONS_TYPE_TAB,
            optionsURL: this.url,
        };
        database.getVisibleAddonForID(this.extension.id, addon => {
            if ( addon === null || this.extension.shutdownStarted ) { return; }
            const current = Object.keys(properties).every(key => addon[key] === properties[key]);
            if ( current ) { return; }
            database.setAddonProperties(addon, properties);
        });
    }

    open() {
        if ( this.url === '' ) {
            throw new ExtensionError('No `options_ui` declared');
        }
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        if ( win === null ) {
            throw new ExtensionError('No browser window available');
        }
        win.switchToTabHavingURI(this.url, true);
    }
};

/******************************************************************************/

// Follows the browser windows through the tab tracker (api-tabs.js).

const BrowserUI = class {
    constructor(extension) {
        this.extension = extension;
        this.tracker = extension.tabTracker;
        this.action = new BrowserAction(this);
        this.menus = new ContextMenus(this);
        this.commands = new Commands(this);
        this.parts = [ this.action, this.menus, this.commands ];
    }

    start() {
        this.action.start();
        this.tracker.addChromeObserver(this);
    }

    stop() {
        this.tracker.removeChromeObserver(this);
        for ( const win of this.tracker.windows ) {
            this.onWindowDetached(win);
        }
        this.action.stop();
    }

    onWindowAttached(win) {
        for ( const part of this.parts ) {
            try {
                part.attachWindow(win);
            } catch (ex) {
                Cu.reportError(ex);
            }
        }
    }

    onWindowDetached(win) {
        for ( const part of this.parts ) {
            try {
                part.detachWindow(win);
            } catch (ex) {
                Cu.reportError(ex);
            }
        }
    }

    onTabSelected(tab) {
        this.action.renderWindow(tab.ownerGlobal);
    }

    onTabNavigated(tab) {
        this.action.onTabNavigated(this.tracker.getId(tab.linkedBrowser));
    }

    onTabRemoved(tabId) {
        this.action.onTabRemoved(tabId);
    }
};

const createUIAPIs = function(extension) {
    const ui = new BrowserUI(extension);
    ui.start();
    extension.onShutdown(( ) => { ui.stop(); });
    const options = new OptionsPage(extension);
    options.register();

    const menus = ui.menus.namespace();
    const tree = {
        browserAction: ui.action.namespace(),
        menus,
        contextMenus: menus,
        commands: ui.commands.namespace(),
        runtime: {
            openOptionsPage: apiAsync(( ) => { options.open(); }),
        },
    };

    return {
        build: ( ) => tree,
    };
};

/******************************************************************************/

// The add-on removed: its button's place goes too, as when Firefox removes
// a WebExtension's browserAction. (PREF_BUTTON_PLACED and PREF_SHORTCUTS go
// with the runtime's other prefs: see Extension.uninstall().)
const forgetBrowserUI = function() {
    if ( CustomizableUI !== null ) {
        CustomizableUI.removeWidgetFromArea(BUTTON_ID);
        return;
    }
    // Pale Moon: the button's ID out of the toolbars' `currentset`, as
    // persisted for the windows to come and in the open ones.
    const names = value => value.split(/\s*,\s*/);
    const without = value => names(value).filter(id => id !== BUTTON_ID).join(',');
    const store = Cc['@mozilla.org/xul/xulstore;1'].getService(Ci.nsIXULStore);
    const ids = store.getIDsEnumerator(BROWSER_URL);
    while ( ids.hasMore() ) {
        const id = ids.getNext();
        const currentset = store.getValue(BROWSER_URL, id, 'currentset');
        if ( names(currentset).includes(BUTTON_ID) ) {
            store.setValue(BROWSER_URL, id, 'currentset', without(currentset));
        }
    }
    const windows = Services.wm.getEnumerator('navigator:browser');
    while ( windows.hasMoreElements() ) {
        for ( const toolbar of windows.getNext().document.querySelectorAll('toolbar[currentset]') ) {
            const currentset = toolbar.getAttribute('currentset');
            if ( names(currentset).includes(BUTTON_ID) ) {
                toolbar.setAttribute('currentset', without(currentset));
            }
        }
    }
};

/******************************************************************************/

return { createUIAPIs, forgetBrowserUI };

})();

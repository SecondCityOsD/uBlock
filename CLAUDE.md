# uBlock Origin — UXP Port (CLAUDE.md)
# READ THIS FIRST when starting a new session.

## Project overview

Fork of uBlock Origin legacy (1.16.6.1) for UXP browsers (Pale Moon / Basilisk).
Based on the proven legacy XUL fork by UCyborg, not the modern WebExtension source.

**Key principle:** Start from working code, incrementally improve.

## Directory layout

```
/home/osd/
  uBlock-1.69.0/                   modern WebExtension (reference for backporting)
  uBlock0_1.16.6.1.firefox-legacy/ original legacy fork (READ-ONLY reference)
  ublock-uxp-modern-attempt/       archived modern port attempt (sessions 1-5)
  ublock-uxp/                      OUR FORK — work here (based on legacy)
```

## Build

```bash
cd /home/osd/ublock-uxp
rm -f ublock-uxp.xpi && zip -r9 ublock-uxp.xpi . -x "*.git*" "*.DS_Store" "*.xpi" "CLAUDE.md"
```

## Status as of 2026-03-17 (session 6 — pivot to legacy fork)

### What happened
- Sessions 1-5 attempted to port modern uBO 1.69.0 to UXP
- This required shimming dozens of WebExtension APIs (browser.storage, browser.alarms,
  browser.webRequest, browser.tabs, browser.runtime, etc.)
- Each fix revealed 3 more missing APIs — toolbar button eventually worked but popup
  and core initialization remained broken
- **Decision: pivot to legacy fork approach** — start from the proven working codebase

### Current state
- Copied `uBlock0_1.16.6.1.firefox-legacy/` → `ublock-uxp/`
- Updated version to 1.16.7.0
- Updated homepage URLs to our GitHub
- Disabled updateURL (will set up later)
- XPI built: ublock-uxp.xpi (4.0 MB)
- **This should work immediately** — it's the same code that runs on Pale Moon today

### Phase 1 COMPLETE (2026-03-17) — Updated lists + resources

**assets.json updated:**
- Self-update URL → our GitHub
- Added uAssets CDN URLs as primary for all core filter lists (easylist, easyprivacy, ublock-filters, etc.)
- Added 4 new lists: AdGuard URL Tracking Protection, Block Outsider Intrusion into LAN, EasyList AI Widgets, AdGuard Ukrainian
- Removed 10 dead lists (stevenblack, phishing_army, easylist-optimized, etc.)
- Updated EST-0 URL

**resources.txt updated:**
- Fixed 2 broken scriptlet entries (trusted-replace-outbound-text, trusted-suppress-native-method)
- Added 3 new scriptlets: prevent-dialog, prevent-innerHTML, trusted-set-attr
- Added 12 new redirect resources: noop-0.5s.mp3, noop-vast2/3/4.xml, noop-vmap1.xml, empty, adthrive_abd.js, nitropay_ads.js, prebid-ads.js, sensors-analytics.js

**XPI rebuilt:** ublock-uxp.xpi (4.0 MB)

### Backport roadmap (Phases 2-4)

**Phase 2 — Filter syntax:**
- $removeparam= modifier — DONE (2026-03-17)
  - Parsing: added to FilterParser.parseOptions() in static-net-filtering.js
  - Uses existing FilterDataHolder/matchAndFetchData pattern (same as $csp=)
  - Runtime: applyRemoveParam() in traffic.js, called from onBeforeRequest()
    and onBeforeRootFrameRequest() (strips tracking params from page URLs too)
  - Supports: plain param names, /regex/ patterns, empty (remove all)
  - Allow rules (@@...$removeparam=param) work via the existing important/allow precedence
  - Returns {redirectUrl: strippedURL} to redirect to clean URL
- $csp= modifier — already existed in legacy fork
- $redirect-rule= modifier — already existed in legacy fork

**Phase 3 — Advanced filters:**
- $denyallow=, $from=/$to=, $method= — DONE (skip-through, Phase 2)
- :matches-attr() procedural selector — DONE (2026-03-17)
- :matches-media() procedural selector — DONE (2026-03-17)
- :matches-path() procedural selector — DONE (2026-03-17)
- Resource aliases fixed (VAST/VMAP) — DONE (2026-03-17)
- $header=/$responseheader= — TODO (requires httpheader-filtering module)
- Updated logger UI — TODO

### Remaining "Invalid filter" categories (from logger analysis, 2026-03-17)

**Cosmetic selectors to add (high impact):**
- `:others()` — massively used in ublock-link-shorteners (100+ filters rejected)
- `:remove-attr()` — used across many lists for attribute removal
- `:remove-class()` — used for class removal

**Network modifiers to add as skip-through (medium impact):**
- `$urlskip=` — URL extraction/chaining (many rules in ublock-privacy)
- `$uritransform=` — URI transformation
- `$replace=` — response body replacement
- `$strict3p` / `$strict1p` — strict party matching
- `$ipaddress=` — IP-based filtering
- `$header=` — response header filtering
- `$cname` — CNAME uncloaking exceptions
- `$ghide` / `$ehide` — generic/specific hide exceptions
- `$reason=` — filter annotation (informational)
- `$all` — match all resource types
- `$redirect-rule` with priority (`:5` suffix) — redirect priority
- `$rewrite=abp-resource:*` — ABP-style rewrite (AdGuard syntax)
- `$match-case` — case-sensitive matching

**All handled (2026-03-17):**
- `$denyallow=` — skip-through (Phase 2)
- `$from=` / `$to=` — skip-through (Phase 2)
- `$method=` — skip-through (Phase 2)
- `$removeparam=` — full implementation (Phase 2)
- `:matches-attr()` — full implementation (Phase 3)
- `:matches-media()` — full implementation (Phase 3)
- `:matches-path()` — full implementation (Phase 3)
- `:others()` — full implementation (Phase 3)
- `:remove-attr()` — full implementation (Phase 3)
- `:remove-class()` — full implementation (Phase 3)
- `$urlskip=`, `$uritransform=`, `$replace=`, `$header=`, `$ipaddress=` — skip-through
- `$strict3p`/`$strict1p` — mapped to 3p/1p
- `$match-case`, `$cname`, `$ghide`/`$ehide`, `$all`, `$rewrite=`, `$blocked`, `$reason=` — skip-through
- `$redirect-rule` with priority (`:5` suffix) — priority stripped, redirect works
- `@@...$redirect-rule` exceptions — now accepted (was rejected before)

**Phase 4 — Performance:**
- Integer-based type system (filtering-context.js)
- S14E compiled filter format
- Incremental filter list updates

### Phase 3 COMPLETE (2026-03-17) — Full logger cleanup

**Wildcard TLD fix:** `domain=amazon.*` now works — `*` allowed in domain options,
matching handles `.*` wildcards in FilterOriginHit/Miss/HitSet classes.

**Bare modifiers:** `$removeparam` (no value), `$redirect-rule` (no value), `$redirect` (no value) all accepted.

**Skip-throughs added:** `$urlskip=`, `$uritransform=`, `$replace=`, `$header=`, `$ipaddress=`,
`$strict3p`/`$strict1p`, `$match-case`, `$cname`, `$ghide`/`$ehide`/`$shide`, `$all`,
`$rewrite=`, `$blocked`, `$reason=`, `$permissions=`, `_____` separator.

**Redirect improvements:** Priority suffix (`:5`) stripped, `@@...$redirect-rule` exceptions accepted,
bare `$redirect-rule`/`$redirect` without `=value` now parsed correctly.

**Procedural selectors added:** `:matches-attr()`, `:matches-media()`, `:matches-path()`,
`:others()`, `:remove-attr()`, `:remove-class()`

**Logger status:** Remaining errors are only:
- `Invalid redirect rule` — missing redirect resources (google-ima.js, nooptext, etc.)
- `:-abp-properties()` — ABP-specific, intentionally unsupported
- IPv6 literal hostnames — legacy parser limitation
- `:shadow()` selectors — not available on UXP
- `{remove:true;}` generic cosmetic suffix — needs hostname

### Phase 4 COMPLETE (2026-03-17) — Redirect engine fixes

**Redirect engine fixes:**
- Removed single-type restriction: rules with multiple types now accepted (first type used)
- No-type rules default to wildcard `*` instead of being rejected
- Skip known non-type options (important, 3p, 1p, match-case, denyallow, etc.)
- Added `noopmp4` alias for `noop-1s.mp4`

**Logger status (final):**
- ~30 remaining errors (down from 500+)
- All remaining are genuine platform limitations:
  - Regex-based redirect rules (legacy reFilterParser can't parse regex URL patterns)
  - `:-abp-properties()` (ABP-specific, intentionally unsupported)
  - `$ipaddress=` with regex values
  - `:shadow()` selectors (Shadow DOM not on UXP)
  - `{remove:true;}` generic cosmetic suffix
  - IPv6 literal hostnames (2 filters)
  - ~99.9% filter acceptance rate

### Next steps
1. Set up GitHub repo and auto-update
2. Add more scriptlets from modern uBO (json-edit family, prevent-fetch/xhr)
3. Test on real websites for ad blocking effectiveness

# Privacy policy

uBlock Origin for Pale Moon and Basilisk (this port of
[uBlock Origin](https://github.com/gorhill/uBlock)) collects no data about
you, and sends none anywhere. It has no telemetry, no analytics and no
accounts.

## The connections it makes

- **Filter lists.** It downloads the filter lists you have enabled, and
  checks them for updates now and then, from the addresses their
  publishers give: uBlock Origin's own lists come from the CDNs listed in
  the dashboard's About pane (GitHub Pages, Cloudflare Pages, jsDelivr,
  Statically). These are plain downloads: like any other, they tell the
  server your IP address.
- **Its own updates.** Your browser checks this repository's update
  manifest
  (`https://raw.githubusercontent.com/SecondCityOsD/uBlock/main/update.rdf`)
  and downloads new versions from its GitHub releases. The request carries
  nothing about you or your settings.

It makes no other connection of its own.

## What it keeps

Your settings, rules, filters and the downloaded lists stay in your
browser profile. The "cloud storage" option keeps its copies there too:
Pale Moon and Basilisk have no sync service for add-ons. Removing the
add-on removes them.

## Reports

The Support pane's buttons open a GitHub page with a report filled in,
troubleshooting information included. Nothing is sent until you submit
that report yourself, on GitHub, where you can read and change it first.

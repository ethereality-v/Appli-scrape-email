# Public Email Finder

A scraper that finds publicly displayed email addresses on websites you supply. It follows links within each website, prioritizes contact/team/about pages, removes duplicate addresses, and saves source links and page context directly to the parent email project's `contacts.json`. It needs no API key or external packages and does not send emails.

## Quick start

Install [Node.js](https://nodejs.org/) 22 or later, then open a terminal in this folder.

Test it immediately without accessing any real websites:

```powershell
node scraper.mjs --demo
```

The demo crawls built-in fictional pages and finds **3 unique email addresses**. It also demonstrates duplicates, contact/team links, and a page blocked by robots.txt. Demo contacts are added to the same parent `contacts.json` as unapproved records; fictional sources are marked with `"demo": true`. To keep demo data separate, pass `--out C:\\path\\to\\contacts.json`.

To scan a real website, replace the example with a website you may crawl:

```powershell
node scraper.mjs https://yourcompany.com
```

`sites.txt` includes Python.org and PostgreSQL public contact pages as starter URLs. Keep or remove them and add your own URLs underneath, one per line. Run:

```powershell
node scraper.mjs --file sites.txt
```

You can also double-click `start.bat` on Windows. It uses the website list, or prompts for websites if the list is empty. Enter `demo` at the prompt for the offline example.

## Results

All email addresses are saved in **`contacts.json` in the parent email project folder**. No separate `results.json`, CSV files, or timestamped output folders are created.

The file is an array compatible with the email project's preview command. Each run adds new addresses and source links while preserving existing names, approval, consent, and custom fields. New records have `approved: false`, `consent: null`, and `sources`. Existing addresses are not duplicated. Crawl totals and skipped-page reasons appear in the terminal.

Invalid existing JSON stops the run rather than overwriting it. Saving uses the same project lock as the email sender to prevent simultaneous writes or imports during sending. Legacy export code in `lib/storage.mjs` remains for backward compatibility, but the active scraper no longer uses it.

To choose a different location, pass `--out C:\\path\\to\\contacts.json`. This option takes a **file path**, not a folder. The parent project's normal command is `node app.mjs discover` and needs no integration-example file.

Person-specific and general company emails are both included. Names and roles are not guessed; nearby public text may help you review who an address belongs to. Finding an address does not verify that the mailbox works or establish permission to contact it. Treat exports as contact data.

## How crawling works

1. Read your supplied URLs; plain domains are normalized to HTTPS.
2. Check each site's robots.txt and honor applicable allow/disallow rules and crawl delays. If the rules cannot be checked, skip access. The implementation conservatively accepts a missing robots.txt only for HTTP 404/410.
3. Download allowed public pages, one request at a time.
4. Extract plain-text email addresses, `mailto:` links, HTML entities such as `&#64;`, and common written forms such as `alex [at] example [dot] com`.
5. Follow same-site page links, giving contact/team/about links priority within each depth. Stay within the configured page/depth limits and save the results.

Defaults: 20 page attempts per website, depth 2, at least 1.5 seconds between requests. Attempts include skipped pages. Subdomains are separate websites; `www` redirects/links are supported. Redirect hops are capped at five. Authentication errors, rate limits, access-denied responses, and recognized access challenges stop that website. Press Ctrl+C to stop and save collected results.

```powershell
node scraper.mjs --file sites.txt --max-pages 10 --max-depth 2 --delay 2000
node scraper.mjs --help
```

## Limits

- Starts from your website list. It does not discover businesses through Google searches or search the entire internet.
- Fetches public HTML/text pages over HTTPS. Does not render JavaScript, sign in, submit forms, read PDFs, guess email addresses, or solve CAPTCHAs. LinkedIn is not supported.
- Only follows same-site links, ignores query-bearing discovered links and common non-page files, and limits downloads to 2 MB. Query URLs can be explicitly supplied as seeds. Some unusual HTML/encodings or obfuscation may not parse correctly; review the exports.
- Live networking currently uses public IPv4 addresses. Private/reserved addresses, local networks, nonstandard ports, and IPv6-only hosts are unsupported. DNS is pinned to the checked public address for each request.
- The default request interval can increase according to robots.txt. Sites requesting delays greater than 60 seconds are skipped. Check each site's terms before crawling.
- Discovery writes to the shared `contacts.json` but does not approve new recipients or send emails.

## Tests

```powershell
node --test
```

Tests and the demo use fictional pages and simulated network responses. They cover extraction, link traversal, duplicate sources, robots rules, redirects, crawl limits, rate-limit handling, network-address filtering, cancellation, single-file JSON output, accumulation across runs, and importing previous results. No real messages are sent and no external service is required.

Implementation references: [Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html), [Node HTTPS](https://nodejs.org/api/https.html).

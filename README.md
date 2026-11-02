# Company Email Project

A small Node.js project for public contact discovery, personalized email previews, and SMTP2GO sending. No external packages are required. This is a command-line MVP, not a hosted application or a search engine.

## API key: exact location

**Put the SMTP2GO API key on line 1 of `.env`:**

```dotenv
SMTP2GO_API_KEY=your_actual_api_key_here
```

Replace only the placeholder after `=`. The file is already included locally. If you received the submission ZIP, copy `.env.example` to `.env` first. Never put the key in `app.mjs`, commit it, or send a configured `.env` with your submission. `.gitignore` excludes `.env` and runtime data.

## Setup

1. Install [Node.js](https://nodejs.org/) version 22 or later.
2. Create a company account at [SMTP2GO](https://www.smtp2go.com/pricing/). The free plan currently includes 1,000 emails/month, with a limit of 200/day.
3. In **Sending > Verified Senders > Sender domains**, add your domain. Have its administrator add the three provided CNAME records and wait for verification. Keep your existing mailbox/DNS records.
4. In **Sending > API Keys**, create a key with `/email/send` permission. **Enable the Unsubscribe Footer** on this key; SMTP2GO appends and manages that link. This application cannot verify that dashboard setting, so check it in a test email.
5. Put the key on line 1 of `.env`. Set `FROM_EMAIL`, `FROM_NAME`, `REPLY_TO`, and `COMPANY_ADDRESS` underneath it. Use your verified domain and a monitored mailbox.

Official references: [account setup](https://support.smtp2go.com/hc/en-gb/articles/12747932085145-Quick-Start-Guide), [API keys](https://support.smtp2go.com/hc/en-gb/articles/20733554340249-API-Keys), [sending API](https://developers.smtp2go.com/reference/send-standard-email).

## Email template and recipients

Edit `template.json` to set your subject and message. Available variables: `{{name}}`, `{{company}}`, `{{email}}`, `{{sender_company}}`. The sender company and mailing address are appended automatically. Keep `campaign_id` the same when rerunning a campaign; an address is attempted only once per campaign. Use a new ID for a genuinely new campaign, after reviewing your recipients again.

Contact entries in `contacts.json` use this format:

```json
[
  {
    "email": "person@theircompany.com",
    "name": "Alex",
    "company": "Their Company",
    "approved": false
  }
]
```

### Manually approve or disapprove recipients

Open `contacts.json` in a text editor and review each email address:

- Set `"approved": true` to include that contact for sending, subject to suppression, duplicate, and sending-limit checks.
- Set `"approved": false` to skip that contact. You do not need to delete the entry.

Use the lowercase JSON values `true` and `false` without quotation marks. Save the file, then run `node app.mjs preview` to check the eligible recipients and messages without sending. Changing approval does not itself send an email; sending requires the separate `send --confirm` command.

New scraped addresses default to `approved: false`. If an address is found again, the scraper preserves its existing approval value and reviewed details. There is no approval interface; the company currently manages these choices directly in `contacts.json`.

Approval records an internal company decision, not recipient consent. The current sender does not validate consent records or dates. The company must independently establish permission and follow its sending provider's requirements before approving a recipient. Remove any leftover fake example recipient before using a real contact list.

From a terminal in the project folder:

```powershell
node app.mjs preview
node app.mjs send --confirm --max 5
```

Preview makes no network calls to SMTP2GO and needs no real API key. The second command sends real emails to up to five eligible recipients. Test first with an opted-in internal company address. Check delivery and the unsubscribe link in SMTP2GO **Reports > Activity**. Provider acceptance does not prove inbox delivery.

## Public contact discovery

Put public HTTPS page URLs in `public-email-finder/sites.txt`, one per line, then run:

```powershell
node app.mjs discover
```

The integrated crawler follows same-site links, checks `robots.txt`, and merges discovered emails and their source URLs directly into this project's `contacts.json`. It deduplicates addresses and preserves existing names, approval, and notes. New contacts have `approved: false`. There is no separate `results.json` output and no integration-example step is required.

The equivalent direct command is `node public-email-finder/scraper.mjs --file public-email-finder/sites.txt`. For a different website list, use `node app.mjs discover --file path/to/sites.txt`. An API key is not needed for discovery. The crawler follows page/depth limits and skips private networks, denied robots rules, and access challenges. See `public-email-finder/README.md` for details.

**SMTP2GO's [terms](https://www.smtp2go.com/terms/) prohibit scraped mailing lists, including LinkedIn leads.** New discovered records are saved for review and remain ineligible while `approved` is false. A public address does not establish opt-in. The sender checks approval, suppressions, prior attempts, and sending limits; it does not verify consent.

## Local scraper integration example

Run the scraper-to-contact-to-template workflow without an API key or sending:

```powershell
node integration-demo.mjs
```

This uses the actual crawler in the `public-email-finder` subfolder with its built-in fictional pages. It discovers three addresses, converts them into the contact format, and renders the message from this project's `template.json` using the same template renderer as the sender. It performs no external network requests.

To try the conversion with previously saved scraper results:

```powershell
node integration-demo.mjs --results contacts.json
```

Both commands write `data/integration-demo.json` with converted `contacts`, rendered `previews`, import counts, and eligibility-check results. Only the first three previews appear in the terminal; all are saved in the JSON file. Imported records are deduplicated, source URLs are preserved, and new records have `approved: false`. The previews demonstrate formatting even though the real sender's eligibility check skips those unapproved contacts.

The optional example does not load `.env`, write to `contacts.json`, update sending logs, or call the email-sending functions. It does not infer names or manufacture consent evidence. For normal discovery, edit `public-email-finder/sites.txt`; the old top-level `sites.txt` is only used if explicitly supplied with `--file`. A custom demo `--out` file must be named `integration-demo.json`.

Implementation: `integration-demo.mjs` orchestrates the example; `lib/scraper-integration.mjs` converts scraper records and creates the previews. The normal `node app.mjs preview` and `send` commands still use the existing `contacts.json`.

## Limits, logs, and suppression

- Defaults: 20 attempts per rolling 24 hours, 1,000 per rolling 31 days, and three seconds between messages. Set these in `.env`. These are local safeguards, not a measurement of the provider's account-wide quota or billing cycle. Other apps may consume the same SMTP2GO allowance; set an API-key rate limit in the dashboard too.
- `data/sending-log.jsonl` records attempts and provider acceptance. Failed or uncertain attempts also count toward local limits. An uncertain response stops the batch; it is never automatically retried. Check **Reports > Activity** before manually reconciling a failed attempt. Do not erase logs to retry blindly.
- SMTP2GO manages its unsubscribe/bounce suppressions. The application does not currently sync provider events or replies; monitor the dashboard and mailbox. To block an address locally, run `node app.mjs suppress person@theircompany.com`.
- Keep the `data` folder between runs. It contains the duplicate history, discovery results, and suppression list. Protect it as company contact data. Multiple commands cannot run concurrently. After a crash, confirm the prior process is stopped before removing a stale `data/project.lock` file.
- This version sends a batch when invoked. To automate recurring runs, use your operating system's scheduler with the same folder/data and command. Review list eligibility, message content, limits, and consent first.

## Verification and submission

```powershell
npm test
```

Tests use simulated SMTP2GO responses and temporary local data. They do not send real email. Actual delivery still requires a verified account, a key, and an internal delivery test.

Share `app.mjs`, `lib/`, `public-email-finder/` (excluding old exports), `package.json`, `contacts.json` (empty or example data), `template.json`, `.env.example`, `.gitignore`, `test/`, and this README. Exclude your configured `.env` and `data/`. The API key is a private company credential.

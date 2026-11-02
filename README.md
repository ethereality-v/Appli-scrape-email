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

Replace the example entry in `contacts.json` with actual opted-in recipients:

```json
[
  {
    "email": "person@theircompany.com",
    "name": "Alex",
    "company": "Their Company",
    "approved": true,
    "consent": {
      "type": "opt_in",
      "record": "Reference to the actual signup or permission record",
      "obtained_at": "YYYY-MM-DD",
      "last_contacted_at": ""
    }
  }
]
```

Use actual ISO dates. Eligibility requires recorded opt-in evidence, approval, and an opt-in or last-contact date within 90 days. If consent is older, enter a real recent `last_contacted_at` date. These fields record your evidence; the app cannot independently establish permission. The supplied example is deliberately ineligible and cannot accidentally send.

From a terminal in the project folder:

```powershell
node app.mjs preview
node app.mjs send --confirm --max 5
```

Preview makes no network calls to SMTP2GO and needs no real API key. The second command sends real emails to up to five eligible recipients. Test first with an opted-in internal company address. Check delivery and the unsubscribe link in SMTP2GO **Reports > Activity**. Provider acceptance does not prove inbox delivery.

## Public contact discovery

Put public HTTPS page URLs in `sites.txt`, one per line, then run:

```powershell
node app.mjs discover
```

The tool fetches only those explicit pages, checks `robots.txt`, and extracts visible/plainly embedded email addresses with their source URLs and timestamps to `data/discovered.json`. It skips LinkedIn, private networks, denied robots rules, login/redirect pages, and non-text responses. It waits three seconds between pages. It does not search the entire web, render JavaScript pages, guess addresses, check mailbox existence, or bypass site restrictions. Check each site's terms before adding it.

**SMTP2GO's [terms](https://www.smtp2go.com/terms/) prohibit scraped mailing lists, including LinkedIn leads.** Discovery results never automatically enter the sending list. A public address does not establish opt-in; only use `contacts.json` for independently permitted, opted-in recipients.

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

Share `app.mjs`, `lib/`, `package.json`, `contacts.json` (empty or example data), `template.json`, `sites.txt`, `.env.example`, `.gitignore`, `test/`, and this README. Exclude your configured `.env` and `data/`. The API key is a private company credential.

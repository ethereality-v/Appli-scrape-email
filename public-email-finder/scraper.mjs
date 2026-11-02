import { readFile } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { crawl } from './lib/crawler.mjs';
import { readContacts, saveContacts } from './lib/contact-storage.mjs';
import { demoSeed, demoRequest } from './demo.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const help = `Public Email Finder — standalone, no API key required

node scraper.mjs --demo                         Offline example crawl
node scraper.mjs https://yourcompany.com         Crawl one website
node scraper.mjs --file sites.txt                Crawl websites from a file
node scraper.mjs --max-pages 10 --max-depth 2     Set crawl limits

Options:
  --file PATH         Website list (default: sites.txt in this project)
  --out PATH          Optional contacts.json file path (default: parent project/contacts.json)
  --max-pages NUMBER  Up to 100 pages per website; default 20
  --max-depth NUMBER  Link depth, 0–5; default 2
  --delay NUMBER      Milliseconds between requests, 1000–60000; default 1500
  --demo              Use built-in sample pages; never contacts real websites
  --help              Show instructions

This tool follows links on the websites you supply. It does not search the
entire internet, log into accounts, or send emails. Press Ctrl+C to stop and
save the results collected so far.
All runs merge addresses directly into the parent project's contacts.json.
Existing contact details are preserved. New addresses are unapproved.
`;

export async function runScraperCli(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    file: { type: 'string' }, out: { type: 'string' },
    'max-pages': { type: 'string', default: '20' }, 'max-depth': { type: 'string', default: '2' },
    delay: { type: 'string', default: '1500' }, demo: { type: 'boolean', default: false }, help: { type: 'boolean', default: false }
  } });
  if (values.help) { console.log(help); return; }
  if (values.demo && (positionals.length || values.file)) throw new Error('Use --demo by itself; it only crawls built-in sample pages.');
  let seeds = values.demo ? [demoSeed] : [...positionals];
  if (!values.demo && (values.file || !seeds.length)) {
    const file = values.file ? resolve(values.file) : join(root, 'sites.txt');
    const content = await readFile(file, 'utf8');
    seeds.push(...content.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')));
  }
  if (!seeds.length && process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('Enter website URLs separated by commas, or type demo to test offline.');
      const answer = (await prompt.question('Websites: ')).trim();
      if (answer.toLowerCase() === 'demo') { values.demo = true; seeds = [demoSeed]; }
      else seeds = answer.split(',').map(value => value.trim()).filter(Boolean);
    } finally { prompt.close(); }
  }
  if (!seeds.length) { console.log(help); return; }
  const output = values.out ? resolve(values.out) : resolve(root, '..', 'contacts.json');
  if (basename(output) !== 'contacts.json') throw new Error('--out must point to a file named contacts.json, not a folder.');
  // Refuse to replace invalid existing data, before crawling.
  await readContacts(output);
  const controller = new AbortController();
  const interrupt = () => { console.log('\nStopping and saving collected results...'); controller.abort(); };
  process.once('SIGINT', interrupt);
  try {
    console.log(values.demo ? 'Running offline demo (fictional addresses).' : `Scanning ${seeds.length} supplied website URL(s)...`);
    const report = await crawl(seeds, {
      maxPages: Number(values['max-pages']), maxDepth: Number(values['max-depth']), delayMs: Number(values.delay),
      signal: controller.signal,
      ...(values.demo ? { request: demoRequest, wait: async () => {} } : {}),
      progress: entry => console.log(entry.status === 'fetched' ? `Found ${entry.emails} address(es): ${entry.url}` : `Skipped ${entry.url}: ${entry.reason}`)
    });
    report.demo = values.demo;
    const saved = await saveContacts(output, report);
    console.log(`\n${report.unique_emails} unique email(s); ${report.pages_fetched} page(s) fetched; ${report.pages_skipped} skipped.`);
    console.log(`${saved.added} new contact(s) added; ${saved.contacts.length} total stored in: ${output}`);
    console.log('New scraped contacts are unapproved. Scraping does not send emails.');
    if (!report.pages_fetched && report.pages_skipped) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', interrupt); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runScraperCli().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parsePage, normalizeUrl, toCsv } from '../lib/html.mjs';
import { allowedAddress } from '../lib/network.mjs';
import { parseRobots } from '../lib/robots.mjs';
import { crawl } from '../lib/crawler.mjs';
import { demoSeed, demoRequest } from '../demo.mjs';
import { saveResults } from '../lib/storage.mjs';

const response = (body, status = 200, headers = {}) => ({ status, body, headers: { 'content-type': 'text/html', ...headers } });
const options = { wait: async () => {} };

test('extracts text, mailto, entities and common written addresses, ignoring scripts and images', () => {
  const page = parsePage(`<title>People &amp; Team</title><p>Taylor: TAYLOR@example.test</p>
    <a href='mailto:alex%40example.test?subject=Hello'>Email Alex</a>
    <p>jamie&#64;example.test and sam [at] example [dot] test</p>
    <script>hidden@example.test</script><style>hidden2@example.test</style>
    <!-- hidden3@example.test -->logo@2x.png`, demoSeed);
  assert.equal(page.title, 'People & Team');
  assert.deepEqual(page.emails.map(item => item.email).sort(), ['alex@example.test', 'jamie@example.test', 'sam@example.test', 'taylor@example.test']);
  assert.match(page.emails.find(item => item.email === 'taylor@example.test').context, /Taylor:/);
});

test('normalizes bare domains and filters external, query, fragment and file links', () => {
  assert.equal(normalizeUrl('example.test'), 'https://example.test/');
  assert.equal(normalizeUrl('/contact?utm_source=test#team', demoSeed), demoSeed + 'contact');
  assert.throws(() => normalizeUrl('http://example.test'), /HTTPS/);
  const page = parsePage(`<a href='/team#alex'>Team</a><a href='/brochure.pdf'>PDF</a>
    <a href='https://external.test/'>External</a><a href='/search?q=x'>Search</a>`, demoSeed);
  assert.deepEqual(page.links, [{ url: demoSeed + 'team', priority: 0 }]);
});

test('robots rules apply specificity, wildcard, end anchors, user agents and crawl delay', () => {
  const policy = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/contact\nDisallow: /*.pdf$\nCrawl-delay: 2');
  assert.equal(policy.allows(demoSeed + 'private/list'), false);
  assert.equal(policy.allows(demoSeed + 'private/contact'), true);
  assert.equal(policy.allows(demoSeed + 'file.pdf'), false);
  assert.equal(policy.allows(demoSeed + 'file.pdf/extra'), true);
  assert.equal(policy.delay, 2000);
  assert.equal(parseRobots('User-agent: *\nDisallow: /\nUser-agent: PublicEmailFinder\nAllow: /').allows(demoSeed), true);
  assert.equal(parseRobots('User-agent: *\nDisallow: /team').allows(demoSeed + '%74eam'), false);
});

test('blocks local/private/reserved network addresses', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(allowedAddress(address), false, address);
  assert.equal(allowedAddress('8.8.8.8'), true);
});

test('demo crawls linked pages, groups duplicate emails with sources, and respects robots', async () => {
  const visited = [];
  const report = await crawl([demoSeed], { ...options, request: async url => { visited.push(url); return demoRequest(url); } });
  assert.equal(report.unique_emails, 3);
  assert.equal(report.pages_fetched, 3);
  assert.equal(report.results.find(item => item.email === 'info@example.test').sources.length, 2);
  assert.equal(visited.includes(demoSeed + 'private'), false);
  assert.equal(visited.some(url => url.includes('another.example.test')), false);
  assert.ok(report.pages.some(page => page.reason === 'Disallowed by robots.txt.'));
});

test('page and depth limits constrain traversal', async () => {
  assert.equal((await crawl([demoSeed], { ...options, request: demoRequest, maxPages: 1 })).pages_fetched, 1);
  assert.equal((await crawl([demoSeed], { ...options, request: demoRequest, maxDepth: 0 })).unique_emails, 1);
  await assert.rejects(crawl([demoSeed], { maxPages: 0 }), /max-pages/);
});

test('same-site redirects work and their final destination robots rules are checked', async () => {
  const urls = [];
  const request = async url => {
    urls.push(url);
    const path = new URL(url).pathname;
    if (path === '/robots.txt') return response('User-agent: *\nDisallow: /private');
    if (path === '/') return response('', 302, { location: '/private' });
    throw new Error('Blocked target should never be requested.');
  };
  const report = await crawl([demoSeed], { ...options, request });
  assert.equal(report.pages_fetched, 0);
  assert.equal(urls.includes(demoSeed + 'private'), false);
  const redirected = await crawl([demoSeed], { ...options, request: async url => {
    const path = new URL(url).pathname;
    if (path === '/robots.txt') return response('', 404);
    if (path === '/') return response('', 301, { location: '/contact' });
    return response('alex@example.test');
  } });
  assert.equal(redirected.unique_emails, 1);
  assert.equal(redirected.results[0].sources[0].url, demoSeed + 'contact');
});

test('cross-site redirects and unavailable robots do not lead to page requests', async () => {
  let requests = 0;
  const report = await crawl([demoSeed], { ...options, request: async () => { requests++; return response('', 503); } });
  assert.equal(requests, 1);
  assert.equal(report.pages_fetched, 0);
  const redirect = await crawl([demoSeed], { ...options, request: async url => url.endsWith('robots.txt') ? response('', 404) : response('', 302, { location: 'https://outside.example.test/' }) });
  assert.match(redirect.pages[0].reason, /leaves/);
});

test('HTTP 429 stops further page downloads for that website', async () => {
  const visited = [];
  const report = await crawl([demoSeed], { ...options, request: async url => {
    visited.push(url);
    if (url.endsWith('/robots.txt')) return response('', 404);
    if (url === demoSeed) return response('<a href="/team">Team</a><a href="/contact">Contact</a>');
    return response('', 429);
  } });
  assert.equal(report.pages_fetched, 1);
  assert.equal(visited.length, 3);
});

test('abort saves already collected results without more requests', async () => {
  const controller = new AbortController();
  const report = await crawl([demoSeed], { ...options, request: demoRequest, signal: controller.signal, progress: () => controller.abort() });
  assert.equal(report.stopped, true);
  assert.equal(report.unique_emails, 1);
});

test('CSV quotes content and neutralizes spreadsheet formulas', () => {
  const csv = toCsv([{ email: 'alex@example.test', sources: [{ url: demoSeed, title: '=HYPERLINK("bad")', context: 'Hello, Alex', found_at: '2026-11-02' }] }]);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.match(csv, /"Hello, Alex"/);
});

test('CLI demo merges all runs into the sender-compatible contacts.json array', async () => {
  const output = await mkdtemp(join(tmpdir(), 'email-finder-test-'));
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    const file = join(output, 'contacts.json');
    const args = [join(root, 'scraper.mjs'), '--demo', '--out', file];
    const result = await promisify(execFile)(process.execPath, args);
    assert.match(result.stdout, /3 unique email/);
    await promisify(execFile)(process.execPath, args);
    assert.deepEqual((await readdir(output)).sort(), ['contacts.json', 'data']);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(stored.length, 3);
    assert.ok(stored.some(item => item.email === 'alex@example.test'));
    assert.equal(stored.find(item => item.email === 'info@example.test').sources.length, 2);
    assert.ok(stored.every(item => item.sources.every(source => source.demo === true)));
    assert.ok(stored.every(item => item.approved === false && item.consent === null));
    assert.deepEqual(await readdir(join(output, 'data')), []);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('single-file storage accumulates new emails, deduplicates sources and preserves first-found dates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-storage-test-'));
  try {
    const file = join(directory, 'results.json');
    const entry = (email, date) => ({ email, sources: [{ url: demoSeed, found_at: date, title: 'Test', context: '' }] });
    await saveResults(file, { results: [entry('alex@example.test', '2026-11-01')], demo: false });
    const saved = await saveResults(file, { results: [entry('ALEX@example.test', '2026-11-02'), entry('new@example.test', '2026-11-02')], demo: false });
    assert.equal(saved.total_emails, 2);
    const alex = saved.results.find(item => item.email === 'alex@example.test');
    assert.equal(alex.sources.length, 1);
    assert.equal(alex.sources[0].found_at, '2026-11-01');
    assert.equal(alex.sources[0].last_found_at, '2026-11-02');
    assert.deepEqual(await readdir(directory), ['results.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy results import once and invalid existing JSON is never overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-import-test-'));
  try {
    const file = join(directory, 'results.json'), legacyDir = join(directory, 'old-results');
    const oldFile = join(legacyDir, 'first-run', 'emails.json');
    await mkdir(dirname(oldFile), { recursive: true });
    await writeFile(oldFile, JSON.stringify({ demo: false, results: [{ email: 'old@example.test', sources: [{ url: demoSeed, found_at: '2026-11-01' }] }] }));
    const imported = await saveResults(file, null, { legacyDir });
    assert.equal(imported.total_emails, 1);
    assert.deepEqual(imported.imported_files, [oldFile]);
    await writeFile(oldFile, 'changed after import');
    assert.equal((await saveResults(file, null, { legacyDir })).total_emails, 1);
    await writeFile(file, '{invalid JSON');
    await assert.rejects(saveResults(file, null, { legacyDir }), /not overwritten/);
    assert.equal(await readFile(file, 'utf8'), '{invalid JSON');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

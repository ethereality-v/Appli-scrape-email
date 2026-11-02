import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { importScraperResults, buildIntegrationPreview } from '../lib/scraper-integration.mjs';
import { runIntegrationDemo } from '../integration-demo.mjs';
import { saveContacts, mergeContacts } from '../public-email-finder/lib/contact-storage.mjs';

const template = { campaign_id: 'learning-demo', subject: 'Hello {{name}}', body: 'Message from {{sender_company}} to {{email}}' };

test('adapter converts the results object, deduplicates emails, preserves sources, and does not inherit approval', () => {
  const result = importScraperResults({ results: [
    { email: 'Alex@example.test', approved: true, consent: { type: 'opt_in' }, sources: [{ url: 'https://demo.example.test/team', title: 'Team' }] },
    { email: 'alex@example.test', sources: [{ url: 'https://demo.example.test/team' }, { url: 'https://demo.example.test/contact' }] },
    { email: 'not-an-email' }, null
  ] });
  assert.deepEqual(result.counts, { input: 4, imported: 1, duplicates: 1, invalid: 2 });
  assert.equal(result.contacts[0].sources.length, 2);
  assert.equal(result.contacts[0].approved, false);
  assert.equal(result.contacts[0].consent, null);
  assert.equal(result.contacts[0].name, '');
  assert.throws(() => importScraperResults([]), /results array/);
});

test('template preview works while real eligibility correctly stays at zero', () => {
  const report = buildIntegrationPreview({ results: [{ email: 'alex@example.test' }] }, template);
  assert.equal(report.previews.length, 1);
  assert.equal(report.previews[0].subject, 'Hello there');
  assert.match(report.previews[0].text_body, /alex@example.test/);
  assert.equal(report.sending_eligibility.eligible, 0);
  assert.equal(report.previews[0].status, 'learning_preview_only');
});

test('offline integration runs actual crawler, adapter and renderer with zero network calls or live contact edits', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected API request'); });
  const httpsMock = t.mock.method(https, 'get', () => { throw new Error('Unexpected website request'); });
  const directory = await mkdtemp(join(tmpdir(), 'scraper-integration-test-'));
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const contactsBefore = await readFile(join(root, 'contacts.json'), 'utf8');
  try {
    const outputFile = join(directory, 'integration-demo.json');
    const { report } = await runIntegrationDemo({ outputFile });
    assert.equal(report.counts.imported, 3);
    assert.equal(report.previews.length, 3);
    assert.equal(report.sending_eligibility.eligible, 0);
    assert.equal(report.input_mode, 'offline_scraper_fixture');
    assert.equal(JSON.parse(await readFile(outputFile, 'utf8')).preview_only, true);
    assert.equal(await readFile(join(root, 'contacts.json'), 'utf8'), contactsBefore);
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(httpsMock.mock.callCount(), 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('existing scraper JSON can be imported without an online crawl or changing input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scraper-import-test-'));
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const resultsFile = join(directory, 'results.json');
  await writeFile(resultsFile, JSON.stringify({ results: [
    { email: 'saved@example.test', sources: [{ url: 'https://example.test/contact' }] },
    { email: 'another@example.test', sources: [] }
  ] }));
  const before = await readFile(resultsFile, 'utf8');
  try {
    const { report } = await runIntegrationDemo({ resultsFile, outputFile: join(directory, 'integration-demo.json') });
    const expected = new Set(JSON.parse(before).results.map(entry => entry.email.toLowerCase()));
    assert.equal(report.counts.imported, expected.size);
    assert.equal(report.sending_eligibility.eligible, 0);
    assert.equal(await readFile(resultsFile, 'utf8'), before);
    await assert.rejects(runIntegrationDemo({ outputFile: join(root, 'contacts.json') }), /must be named/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('contact merge preserves reviewed fields and approval while adding unapproved new addresses', () => {
  const existing = [{ email: 'alex@example.test', name: 'Alex', approved: true, consent: { type: 'opt_in', record: 'real signup' }, notes: 'Keep this' }];
  const report = { results: [
    { email: 'ALEX@example.test', sources: [{ url: 'https://example.test/team', found_at: '2026-11-01' }] },
    { email: 'new@example.test', approved: true, consent: { type: 'opt_in' }, sources: [] }
  ] };
  const merged = mergeContacts(existing, report);
  assert.equal(merged.added, 1);
  assert.equal(merged.contacts.length, 2);
  const alex = merged.contacts.find(item => item.email === 'alex@example.test');
  assert.equal(alex.name, 'Alex');
  assert.equal(alex.approved, true);
  assert.deepEqual(alex.consent, existing[0].consent);
  assert.equal(alex.notes, 'Keep this');
  assert.equal(alex.sources.length, 1);
  const added = merged.contacts.find(item => item.email === 'new@example.test');
  assert.equal(added.approved, false);
  assert.equal(added.consent, null);
  assert.equal(existing[0].sources, undefined);
});

test('contact writer is compatible with sender format, deduplicates across runs, and respects sender lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shared-contacts-test-'));
  try {
    const file = join(directory, 'contacts.json');
    const report = { results: [{ email: 'alex@example.test', sources: [{ url: 'https://example.test/team' }] }] };
    await saveContacts(file, report);
    const second = await saveContacts(file, report);
    assert.equal(second.added, 0);
    assert.equal(second.contacts.length, 1);
    assert.ok(Array.isArray(JSON.parse(await readFile(file, 'utf8'))));
    const lockFile = join(directory, 'data', 'project.lock');
    const lock = await open(lockFile, 'wx');
    try { await assert.rejects(saveContacts(file, report), /Another project command/); }
    finally { await lock.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('malformed shared contacts are not overwritten, and saved contact arrays work with the learning preview', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contacts-validation-test-'));
  try {
    const file = join(directory, 'contacts.json');
    await writeFile(file, '{bad json');
    await assert.rejects(saveContacts(file, { results: [] }), /not overwritten/);
    assert.equal(await readFile(file, 'utf8'), '{bad json');
    await writeFile(file, JSON.stringify([{ email: 'alex@example.test', approved: false, consent: null }]));
    const { report } = await runIntegrationDemo({ resultsFile: file, outputFile: join(directory, 'integration-demo.json') });
    assert.equal(report.counts.imported, 1);
    assert.equal(report.sending_eligibility.eligible, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

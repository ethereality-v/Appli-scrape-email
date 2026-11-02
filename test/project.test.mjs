import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration, plan, render, sendMessage, sendBatch, history } from '../lib/sender.mjs';
import { extractEmails, robotsAllows, discoverPage } from '../lib/discovery.mjs';

const now = Date.parse('2026-11-02T12:00:00Z');
const env = { SMTP2GO_API_KEY: 'test-key', FROM_EMAIL: 'team@business.test', FROM_NAME: 'Business', COMPANY_ADDRESS: '123 Example Street' };
const config = configuration(env);
const template = { campaign_id: 'intro-001', subject: 'Hello {{name}}', body: 'Message for {{company}} from {{sender_company}}.' };
const contact = () => ({ email: 'Person@company.test', name: 'Alex', company: 'Company', approved: true, consent: { type: 'opt_in', record: 'signup:123', obtained_at: '2026-11-01' } });
const accepted = () => ({ ok: true, status: 200, json: async () => ({ request_id: 'request-1', data: { succeeded: 1, failed: 0, failures: [], email_id: 'email-1' } }) });

test('live configuration rejects an unset API key and example sender', () => {
  assert.throws(() => configuration({ ...env, SMTP2GO_API_KEY: 'PUT_YOUR_SMTP2GO_API_KEY_HERE' }, true), /line 1/);
  assert.throws(() => configuration({ ...env, FROM_EMAIL: 'hello@yourcompany.com' }, true), /placeholders/);
});

test('only approved, recent opted-in contacts become messages; duplicates are removed', () => {
  const unapproved = { ...contact(), email: 'unapproved@company.test', approved: false };
  const noConsent = { ...contact(), email: 'public@company.test', consent: undefined };
  const stale = { ...contact(), email: 'stale@company.test', consent: { type: 'opt_in', record: 'signup:old', obtained_at: '2025-01-01' } };
  const result = plan([contact(), contact(), unapproved, noConsent, stale], template, config, [], new Set(), now);
  assert.equal(result.messages.length, 1);
  assert.equal(result.skipped.length, 4);
  assert.equal(result.messages[0].payload.subject, 'Hello Alex');
  assert.match(result.messages[0].payload.text_body, /123 Example Street/);
  assert.deepEqual(result.messages[0].payload.to, ['person@company.test']);
});

test('suppression and previous attempts prevent sending, including uncertain attempts', () => {
  assert.equal(plan([contact()], template, config, [], new Set(['person@company.test']), now).messages.length, 0);
  assert.equal(plan([contact()], template, config, [{ status: 'attempt', email: 'person@company.test', campaign: 'intro-001' }], new Set(), now).messages.length, 0);
});

test('malformed templates and header injection fail before a send', () => {
  assert.throws(() => render('{{unknown}}', {}), /Unknown/);
  assert.throws(() => plan([{ ...contact(), name: 'Alex\r\nBcc: another@company.test' }], template, config, [], new Set(), now), /newlines/);
});

test('SMTP2GO request uses a secret header and one recipient, and checks response data', async () => {
  const message = plan([contact()], template, config, [], new Set(), now).messages[0];
  const result = await sendMessage(message.payload, 'secret-test-value', async (url, request) => {
    assert.equal(url, 'https://api.smtp2go.com/v3/email/send');
    assert.equal(request.headers['X-Smtp2go-Api-Key'], 'secret-test-value');
    assert.equal(JSON.parse(request.body).to.length, 1);
    assert.ok(!request.body.includes('secret-test-value'));
    return accepted();
  });
  assert.equal(result.providerId, 'email-1');
  await assert.rejects(sendMessage(message.payload, 'key', async () => ({ ok: true, status: 200, json: async () => ({ data: { succeeded: 0, failed: 1 } }) })), /did not confirm/);
});

test('batch logs successes, enforces limits and does not resend a campaign', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'company-email-test-'));
  try {
    const other = { ...contact(), email: 'other@company.test' };
    const messages = plan([contact(), other], template, config, [], new Set(), now).messages;
    let calls = 0;
    const fake = async () => { calls++; return accepted(); };
    assert.equal(await sendBatch(messages, { ...config, daily: 1 }, directory, 5, fake, () => {}), 1);
    assert.equal(await sendBatch(messages, { ...config, daily: 1 }, directory, 5, fake, () => {}), 0);
    assert.equal(calls, 1);
    assert.deepEqual((await history(directory)).map(row => row.status), ['attempt', 'accepted']);
    assert.equal(await sendBatch([messages[0]], config, directory, 5, fake, () => {}), 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('network uncertainty stops the batch and is not automatically retried', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'company-email-test-'));
  try {
    const messages = plan([contact()], template, config, [], new Set(), now).messages;
    await assert.rejects(sendBatch(messages, config, directory, 5, async () => { throw new Error('timeout'); }, () => {}), /Sending stopped/);
    assert.deepEqual((await history(directory)).map(row => row.status), ['attempt', 'unconfirmed']);
    let calls = 0;
    assert.equal(await sendBatch(messages, config, directory, 5, async () => { calls++; return accepted(); }, () => {}), 0);
    assert.equal(calls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('public address extraction deduplicates and ignores script content and image filenames', () => {
  assert.deepEqual(extractEmails('<script>private@hidden.test</script><a href="mailto:hello@business.test">hello&#64;business.test</a> logo@2x.png'), ['hello@business.test']);
});

test('robots rules support allow exceptions, wildcards and specific agents', () => {
  const rules = 'User-agent: *\nDisallow: /private\nAllow: /private/contact\nDisallow: /*?secret=';
  assert.equal(robotsAllows(rules, 'https://business.test/private/list'), false);
  assert.equal(robotsAllows(rules, 'https://business.test/private/contact'), true);
  assert.equal(robotsAllows(rules, 'https://business.test/contact?secret=yes'), false);
  assert.equal(robotsAllows('User-agent: *\nAllow: /\nUser-agent: CompanyContactDiscovery\nDisallow: /', 'https://business.test/contact'), false);
});

test('discovery records source URLs but never marks contacts approved', async () => {
  const results = await discoverPage('https://business.test/contact', async url => url.endsWith('/robots.txt')
    ? { status: 404, body: '' }
    : { status: 200, type: 'text/html', body: '<p>hello@business.test</p>' });
  assert.equal(results[0].source_url, 'https://business.test/contact');
  assert.equal(results[0].approved, false);
  let calls = 0;
  await assert.rejects(discoverPage('https://business.test/contact', async () => { calls++; return { status: 200, body: 'User-agent: *\nDisallow: /' }; }), /denies access/);
  assert.equal(calls, 1);
});

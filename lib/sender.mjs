import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function email(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(normalized)) {
    throw new Error(`Invalid email address: ${normalized}`);
  }
  return normalized;
}

export function render(text, variables) {
  return text.replace(/{{\s*([a-z_]+)\s*}}/gi, (_, key) => {
    if (!(key in variables)) throw new Error(`Unknown template variable: ${key}`);
    return String(variables[key]);
  });
}

function positiveInteger(value, name, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer.`);
  return number;
}

export function configuration(env, live = false) {
  const config = {
    key: env.SMTP2GO_API_KEY ?? '',
    from: email(env.FROM_EMAIL),
    name: env.FROM_NAME?.trim(),
    reply: email(env.REPLY_TO || env.FROM_EMAIL),
    address: env.COMPANY_ADDRESS?.trim(),
    daily: positiveInteger(env.DAILY_LIMIT, 'DAILY_LIMIT', 20),
    monthly: positiveInteger(env.MONTHLY_LIMIT, 'MONTHLY_LIMIT', 1000),
    interval: positiveInteger(env.SEND_INTERVAL_MS, 'SEND_INTERVAL_MS', 3000)
  };
  if (!config.name || !config.address || /[\r\n<>]/.test(config.name)) throw new Error('Set a valid FROM_NAME and COMPANY_ADDRESS in .env.');
  if (live && (!config.key || config.key.includes('PUT_YOUR') || /[\r\n]/.test(config.key))) {
    throw new Error('Put your SMTP2GO API key on line 1 of .env.');
  }
  if (live && (config.from.endsWith('@yourcompany.com') || config.address.includes('Replace with'))) {
    throw new Error('Replace the sender and company address placeholders in .env.');
  }
  return config;
}

export async function history(directory) {
  try {
    return (await readFile(join(directory, 'sending-log.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Cannot read sending log. Resolve the problem before sending again.');
  }
}

export async function suppressions(directory) {
  try {
    return new Set(JSON.parse(await readFile(join(directory, 'suppressed.json'), 'utf8')).map(email));
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw new Error('Cannot read suppression list. Resolve the problem before sending again.');
  }
}

function recent(date, now) {
  const time = typeof date === 'string' && date.trim() ? Date.parse(date) : NaN;
  return Number.isFinite(time) && time <= now && now - time <= 90 * 86400000;
}

export function plan(contacts, template, config, log = [], suppressed = new Set(), now = Date.now()) {
  if (!Array.isArray(contacts)) throw new Error('contacts.json must contain an array.');
  if (!/^[a-z0-9_-]{1,100}$/i.test(template.campaign_id ?? '')) throw new Error('Set a campaign_id in template.json (letters, digits, hyphens, underscores).');
  if (typeof template.subject !== 'string' || !template.subject.trim() || typeof template.body !== 'string' || !template.body.trim()) {
    throw new Error('Set a nonempty subject and body in template.json.');
  }
  const seen = new Set();
  const messages = [], skipped = [];
  for (const contact of contacts) {
    let address;
    try { address = email(contact.email); } catch { skipped.push({ email: contact.email, reason: 'invalid address' }); continue; }
    let reason;
    if (seen.has(address)) reason = 'duplicate';
    seen.add(address);
    if (suppressed.has(address)) reason = 'suppressed';
    if (contact.approved !== true) reason = 'not approved';
    const consent = contact.consent;
    const consentTime = Date.parse(consent?.obtained_at);
    if (consent?.type !== 'opt_in' || typeof consent.record !== 'string' || !consent.record.trim() || !Number.isFinite(consentTime) || consentTime > now) {
      reason = 'missing opt-in evidence';
    } else if (!recent(consent.obtained_at, now) && !recent(consent.last_contacted_at, now)) {
      reason = 'list needs review: no opt-in or contact within 90 days';
    }
    if (log.some(entry => entry.campaign === template.campaign_id && entry.email === address && entry.status === 'attempt')) {
      reason = 'already attempted for this campaign; check sending log';
    }
    if (reason) { skipped.push({ email: address, reason }); continue; }
    const variables = { name: contact.name || 'there', company: contact.company || '', email: address, sender_company: config.name };
    const subject = render(template.subject, variables);
    if (/[\r\n]/.test(subject)) throw new Error('Email subjects cannot contain newlines.');
    messages.push({
      campaign: template.campaign_id,
      payload: {
        sender: `${config.name} <${config.from}>`, to: [address], subject,
        text_body: `${render(template.body, variables)}\n\n${config.name}\n${config.address}`,
        custom_headers: [{ header: 'Reply-To', value: config.reply }],
        fastaccept: false
      }
    });
  }
  return { messages, skipped };
}

export async function sendMessage(payload, key, fetcher = fetch) {
  const response = await fetcher('https://api.smtp2go.com/v3/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Smtp2go-Api-Key': key },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(30000)
  });
  const result = await response.json();
  const data = result.data;
  // HTTP 200 alone does not mean SMTP2GO accepted the message.
  if (!response.ok || data?.succeeded !== 1 || data?.failed !== 0 || data?.error || data?.failures?.length) {
    throw new Error(`SMTP2GO did not confirm acceptance (HTTP ${response.status}). Check Reports > Activity.`);
  }
  return { providerId: data.email_id ?? null, requestId: result.request_id ?? null };
}

export async function sendBatch(messages, config, directory, max, fetcher = fetch, output = console.log) {
  await mkdir(directory, { recursive: true });
  const record = entry => appendFile(join(directory, 'sending-log.jsonl'), JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  let count = 0;
  for (const message of messages.slice(0, max)) {
    const log = await history(directory);
    const now = Date.now();
    const attempts = log.filter(entry => entry.status === 'attempt');
    if (attempts.filter(e => now - Date.parse(e.at) < 86400000).length >= config.daily ||
        attempts.filter(e => now - Date.parse(e.at) < 31 * 86400000).length >= config.monthly) {
      output('Sending limit reached. Remaining messages were not sent.'); break;
    }
    const address = message.payload.to[0];
    if ((await suppressions(directory)).has(address)) continue;
    if (attempts.some(e => e.email === address && e.campaign === message.campaign)) continue;
    if (count) await delay(config.interval);
    const entry = { id: randomUUID(), campaign: message.campaign, email: address };
    // Record before the network call: interrupted/uncertain sends must not automatically repeat.
    await record({ ...entry, status: 'attempt' });
    try {
      const result = await sendMessage(message.payload, config.key, fetcher);
      await record({ ...entry, status: 'accepted', ...result });
      count++;
      output(`Accepted by SMTP2GO: ${address}`);
    } catch {
      await record({ ...entry, status: 'unconfirmed' });
      throw new Error('Sending stopped: acceptance was not confirmed. Check SMTP2GO Reports > Activity and data/sending-log.jsonl before any retry.');
    }
  }
  return count;
}

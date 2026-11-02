import { readFile, mkdir, writeFile, rename, unlink, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { email } from '../../lib/sender.mjs';
import { importScraperResults } from '../../lib/scraper-integration.mjs';

export async function readContacts(file) {
  let contacts;
  try { contacts = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Cannot read ${file}; existing contacts were not overwritten.`);
  }
  if (!Array.isArray(contacts)) throw new Error('contacts.json must contain an array; existing data was not overwritten.');
  const seen = new Set();
  for (const contact of contacts) {
    const address = email(contact?.email);
    if (seen.has(address)) throw new Error(`Duplicate existing contact: ${address}. Resolve it before importing.`);
    if (contact.sources !== undefined && !Array.isArray(contact.sources)) throw new Error('Contact sources must be an array.');
    seen.add(address);
  }
  return contacts;
}

export function mergeContacts(existing, report) {
  const imported = importScraperResults(report);
  const contacts = new Map(existing.map(contact => [email(contact.email), structuredClone(contact)]));
  let added = 0;
  for (const candidate of imported.contacts) {
    if (!contacts.has(candidate.email)) {
      contacts.set(candidate.email, candidate);
      added++;
      continue;
    }
    // Reviewed fields belong to the existing contact; discovery only updates sources.
    const prior = contacts.get(candidate.email);
    prior.sources ??= [];
    for (const source of candidate.sources) {
      const saved = prior.sources.find(item => item.url === source.url && Boolean(item.demo) === source.demo);
      if (saved) {
        const firstFound = saved.found_at;
        Object.assign(saved, source, { found_at: firstFound || source.found_at, last_found_at: source.found_at });
      } else prior.sources.push(source);
    }
  }
  return { contacts: [...contacts.values()], added, invalid: imported.counts.invalid };
}

export async function saveContacts(file, report) {
  // Share the sender's lock so a save cannot race with sending or previewing.
  const lockPath = join(dirname(file), 'data', 'project.lock');
  await mkdir(dirname(lockPath), { recursive: true });
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another project command is running; try importing again after it finishes.');
    throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const merged = mergeContacts(await readContacts(file), report);
    await writeFile(temporary, JSON.stringify(merged.contacts, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    return merged;
  } finally {
    try { await unlink(temporary); }
    catch (error) { if (error.code !== 'ENOENT') console.error(`Could not remove temporary file: ${temporary}`); }
    await lock.close();
    await unlink(lockPath);
  }
}

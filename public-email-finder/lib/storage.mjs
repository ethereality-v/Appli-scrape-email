import { readFile, readdir, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

function merge(target, entries, demo) {
  if (!Array.isArray(entries)) throw new Error('Existing results must contain a results array; file was not overwritten.');
  for (const entry of entries) {
    if (typeof entry?.email !== 'string' || !entry.email.includes('@') || !Array.isArray(entry.sources)) {
      throw new Error('Existing email data is invalid; file was not overwritten.');
    }
    const email = entry.email.trim().toLowerCase();
    if (!target.has(email)) target.set(email, { email, sources: [] });
    const saved = target.get(email);
    for (const source of entry.sources) {
      if (typeof source?.url !== 'string' || !source.url) throw new Error('Existing source data is invalid; file was not overwritten.');
      const next = { ...source, demo: source.demo ?? Boolean(demo) };
      const prior = saved.sources.find(item => item.url === next.url && item.demo === next.demo);
      if (!prior) saved.sources.push(next);
      else {
        const first = prior.found_at;
        Object.assign(prior, next, { found_at: first || next.found_at, last_found_at: next.last_found_at || next.found_at || prior.last_found_at });
      }
    }
  }
}

export async function readResults(file, { legacyDir } = {}) {
  let stored = { results: [], total_emails: 0 };
  try { stored = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read ${file}; existing data was not overwritten.`); }
  const emails = new Map();
  merge(emails, stored.results, stored.demo);
  const imported = [...(stored.imported_files || [])];
  if (legacyDir && !stored.legacy_import_complete) {
    let folders = [];
    try { folders = await readdir(legacyDir, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const folder of folders.filter(item => item.isDirectory())) {
      const oldFile = join(legacyDir, folder.name, 'emails.json');
      let oldReport;
      try { oldReport = JSON.parse(await readFile(oldFile, 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw new Error(`Cannot import ${oldFile}; no existing data was overwritten.`);
      }
      merge(emails, oldReport.results, oldReport.demo);
      imported.push(oldFile);
    }
  }
  return {
    ...stored,
    legacy_import_complete: Boolean(legacyDir || stored.legacy_import_complete),
    imported_files: [...new Set(imported)],
    results: [...emails.values()].sort((a, b) => a.email.localeCompare(b.email)),
    total_emails: emails.size
  };
}

export async function saveResults(file, report = null, options = {}) {
  const stored = await readResults(file, options);
  if (report) {
    const emails = new Map();
    merge(emails, stored.results);
    merge(emails, report.results, report.demo);
    stored.results = [...emails.values()].sort((a, b) => a.email.localeCompare(b.email));
    stored.total_emails = emails.size;
    const { results, ...run } = report;
    stored.last_run = run;
  }
  stored.updated_at = new Date().toISOString();
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return stored;
}

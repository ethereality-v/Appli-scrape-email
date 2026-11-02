import { readFile, writeFile, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration, history, suppressions, plan, sendBatch, email } from './lib/sender.mjs';
import { discoverPage } from './lib/discovery.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const data = join(root, 'data');
const json = async name => JSON.parse(await readFile(join(root, name), 'utf8'));

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    confirm: { type: 'boolean', default: false }, max: { type: 'string', default: '5' },
    file: { type: 'string', default: 'sites.txt' }
  } });
  const [command, address] = positionals;
  if (!command || command === 'help') {
    console.log(`Company Email Project (Node.js 22+)\n\nnode app.mjs preview\nnode app.mjs send --confirm --max 5\nnode app.mjs discover --file sites.txt\nnode app.mjs suppress person@company.com\n\nAPI key: .env, line 1. Full instructions: README.md.\nSending uses opted-in, approved contacts.json entries. Discovery writes to data/discovered.json only.`);
    return;
  }
  if (!['preview', 'send', 'discover', 'suppress'].includes(command)) throw new Error('Unknown command. Run node app.mjs help.');
  await mkdir(data, { recursive: true });
  let lock;
  try {
    lock = await open(join(data, 'project.lock'), 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another command is running. If a previous process crashed, confirm it has stopped before removing data/project.lock.');
    throw error;
  }
  try {
    if (command === 'suppress') {
      const list = await suppressions(data);
      list.add(email(address));
      await writeFile(join(data, 'suppressed.json'), JSON.stringify([...list], null, 2) + '\n', { mode: 0o600 });
      console.log(`Suppressed: ${email(address)}`);
      return;
    }
    if (command === 'discover') {
      const urls = [...new Set((await readFile(join(root, values.file), 'utf8')).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')))];
      if (!urls.length) { console.log('Add public HTTPS page URLs to sites.txt, one per line.'); return; }
      if (urls.length > 100) throw new Error('Use at most 100 page URLs per discovery run.');
      let existing = [];
      try { existing = JSON.parse(await readFile(join(data, 'discovered.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let failures = 0;
      for (const [index, url] of urls.entries()) {
        if (index) await delay(3000);
        try {
          const found = await discoverPage(url);
          for (const contact of found) {
            if (!existing.some(e => e.email === contact.email && e.source_url === contact.source_url)) existing.push(contact);
          }
          await writeFile(join(data, 'discovered.json'), JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
          console.log(`${url}: ${found.length} public address(es) found.`);
        } catch (error) { failures++; console.error(`${url}: ${error.message}`); }
      }
      console.log('Results: data/discovered.json. Discovery does not establish permission to email.');
      if (failures) process.exitCode = 1;
      return;
    }
    if (command === 'send' && !values.confirm) throw new Error('Preview first, then use send --confirm --max 5 to send real emails.');
    const max = Number(values.max);
    if (!Number.isSafeInteger(max) || max < 1 || max > 200) throw new Error('--max must be an integer between 1 and 200.');
    try { process.loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const config = configuration(process.env, command === 'send');
    const result = plan(await json('contacts.json'), await json('template.json'), config, await history(data), await suppressions(data));
    for (const skipped of result.skipped) console.log(`Skipped ${skipped.email}: ${skipped.reason}`);
    if (command === 'preview') {
      for (const message of result.messages) {
        console.log(`\nTo: ${message.payload.to[0]}\nFrom: ${message.payload.sender}\nSubject: ${message.payload.subject}\n\n${message.payload.text_body}\n\n[SMTP2GO appends its unsubscribe footer if enabled on the API key.]`);
      }
      console.log(`\n${result.messages.length} eligible message(s). Preview only; nothing sent.`);
    } else {
      const sent = await sendBatch(result.messages, config, data, max);
      console.log(`${sent} message(s) accepted by SMTP2GO. Acceptance is not confirmation of inbox delivery.`);
    }
  } finally {
    await lock.close();
    await unlink(join(data, 'project.lock'));
  }
}

main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });

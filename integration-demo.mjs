import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildIntegrationPreview } from './lib/scraper-integration.mjs';

const root = dirname(fileURLToPath(import.meta.url));

export async function runIntegrationDemo({ resultsFile, outputFile = join(root, 'data', 'integration-demo.json') } = {}) {
  const output = resolve(outputFile);
  if (basename(output) !== 'integration-demo.json') throw new Error('Output must be named integration-demo.json; the live contacts file is never an output.');
  if (resultsFile && resolve(resultsFile) === output) throw new Error('Input and output must be different files.');
  let document;
  if (resultsFile) {
    document = JSON.parse(await readFile(resolve(resultsFile), 'utf8'));
    if (Array.isArray(document)) document = { results: document };
  } else {
    const { crawl } = await import('./public-email-finder/lib/crawler.mjs');
    const { demoSeed, demoRequest } = await import('./public-email-finder/demo.mjs');
    document = await crawl([demoSeed], { request: demoRequest, wait: async () => {} });
    document.demo = true;
  }
  const template = JSON.parse(await readFile(join(root, 'template.json'), 'utf8'));
  const preview = buildIntegrationPreview(document, template);
  const report = {
    ...preview,
    input_mode: resultsFile ? 'saved_scraper_results' : 'offline_scraper_fixture',
    generated_at: new Date().toISOString()
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return { report, output };
}

async function main() {
  const { values } = parseArgs({ options: {
    results: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean', default: false }
  } });
  if (values.help) {
    console.log(`Local integration example - no API key or sending\n\nnode integration-demo.mjs\nnode integration-demo.mjs --results contacts.json\n\nThe first command runs the actual scraper against its built-in fictional pages.\nThe second reads contacts.json (or legacy scraper JSON) without fetching websites.\nBoth convert results into contact candidates and render learning-only previews.\nOutput: data/integration-demo.json. Optional --out must name integration-demo.json.\nLive contacts.json, .env, and sending logs are not changed.`);
    return;
  }
  const { report, output } = await runIntegrationDemo({ resultsFile: values.results, outputFile: values.out });
  console.log(`Input: ${report.input_mode}\n${report.counts.input} scraped entries -> ${report.counts.imported} contact candidates -> ${report.previews.length} local previews.`);
  console.log(`Duplicates removed: ${report.counts.duplicates}; invalid entries skipped: ${report.counts.invalid}.`);
  for (const preview of report.previews.slice(0, 3)) {
    console.log(`\n[LEARNING PREVIEW - NOT SENT]\nTo: ${preview.to}\nSubject: ${preview.subject}\n\n${preview.text_body}`);
  }
  if (report.previews.length > 3) console.log(`\nFirst 3 previews shown above. All ${report.previews.length} are saved in the output file.`);
  console.log(`\nEligible for sending: ${report.sending_eligibility.eligible}. Imported records remain unapproved with no consent evidence.\nSaved: ${output}\nNo network requests to websites or SMTP2GO were made. No emails were sent.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}

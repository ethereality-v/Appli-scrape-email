import { email, render, plan } from './sender.mjs';

// A discovered address is a contact candidate, not an approval or consent record.
export function importScraperResults(document) {
  if (!document || !Array.isArray(document.results)) {
    throw new Error('Scraper input must be a JSON object containing a results array.');
  }
  const contacts = new Map();
  let invalid = 0, duplicates = 0;
  for (const entry of document.results) {
    let address;
    try { address = email(entry?.email); } catch { invalid++; continue; }
    if (contacts.has(address)) duplicates++;
    else contacts.set(address, {
      email: address, name: '', company: '', approved: false,
      discovery_only: true, sources: []
    });
    const contact = contacts.get(address);
    for (const source of Array.isArray(entry.sources) ? entry.sources : []) {
      try {
        const url = new URL(source?.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
        const demo = Boolean(source.demo ?? document.demo);
        if (contact.sources.some(saved => saved.url === url.href && saved.demo === demo)) continue;
        contact.sources.push({
          url: url.href,
          title: typeof source.title === 'string' ? source.title : '',
          context: typeof source.context === 'string' ? source.context : '',
          found_at: typeof source.found_at === 'string' ? source.found_at : '',
          demo
        });
      } catch { /* A bad source does not invalidate an otherwise valid email. */ }
    }
  }
  return {
    contacts: [...contacts.values()],
    counts: { input: document.results.length, imported: contacts.size, duplicates, invalid }
  };
}

export function buildIntegrationPreview(document, template) {
  const imported = importScraperResults(document);
  // Local display settings only. The demo never loads .env or an API key.
  const config = {
    name: 'Learning Demo Company', from: 'sender@example.test',
    reply: 'sender@example.test', address: 'Fictional mailing address - local demonstration'
  };
  // Exercise the real eligibility checks; imported contacts remain ineligible.
  const eligibility = plan(imported.contacts, template, config);
  const previews = imported.contacts.map(contact => {
    const variables = {
      name: contact.name || 'there', company: contact.company || '',
      email: contact.email, sender_company: config.name
    };
    return {
      status: 'learning_preview_only', to: contact.email,
      from: `${config.name} <${config.from}>`,
      subject: render(template.subject, variables),
      text_body: `${render(template.body, variables)}\n\n${config.name}\n${config.address}`
    };
  });
  return {
    preview_only: true,
    counts: imported.counts,
    contacts: imported.contacts,
    previews,
    sending_eligibility: { eligible: eligibility.messages.length, skipped: eligibility.skipped }
  };
}

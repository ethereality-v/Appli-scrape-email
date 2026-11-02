export function decode(text) {
  return text.replace(/&#(x[0-9a-f]+|[0-9]+);?|&(amp|lt|gt|quot|apos|commat|period|nbsp);/gi, (original, numeric, named) => {
    if (named) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", commat: '@', period: '.', nbsp: ' ' }[named.toLowerCase()];
    const number = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : original;
  });
}

const stripScripts = html => html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
const plain = html => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (attributes, name) => {
  const match = attributes.match(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\x27([^\x27]*)\x27|([^\\s>]+))', 'i'));
  return match ? decode(match[1] ?? match[2] ?? match[3]) : null;
};

export function normalizeUrl(input, base) {
  const value = String(input).trim();
  const url = new URL(!base && !/^[a-z][a-z0-9+.-]*:/i.test(value) ? `https://${value}` : value, base);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Use public HTTPS website URLs.');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  return url.href;
}

export function siteName(url) {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

export function parsePage(html, url) {
  const clean = stripScripts(html);
  const title = plain(clean.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const text = plain(clean).replace(/\s*(?:\[|\()\s*at\s*(?:\]|\))\s*/gi, '@')
    .replace(/\s*(?:\[|\()\s*dot\s*(?:\]|\))\s*/gi, '.');
  const links = [];
  const mailto = [];
  for (const match of clean.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attr(match[1], 'href');
    if (!href) continue;
    if (/^mailto:/i.test(href)) {
      try { mailto.push(decodeURIComponent(href.slice(7).split('?')[0])); } catch { /* Ignore malformed percent escapes. */ }
    } else {
      try {
        const target = normalizeUrl(href, url);
        if (siteName(target) !== siteName(url) || new URL(target).search) continue;
        if (/\.(pdf|jpg|jpeg|gif|png|svg|webp|zip|mp[34]|docx?|xlsx?|css|js|ico|woff2?)$/i.test(new URL(target).pathname)) continue;
        links.push({ url: target, priority: /contact|about|team|staff|people|directory|leadership|faculty/i.test(href + ' ' + plain(match[2])) ? 0 : 1 });
      } catch { /* Not a crawlable HTTPS page. */ }
    }
  }
  const addresses = new Map();
  const expression = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}/gi;
  for (const candidate of [text, ...mailto]) {
    for (const match of candidate.matchAll(expression)) {
      const email = match[0].replace(/^[.'`]+|[.'`]+$/g, '').toLowerCase();
      if (email.includes('..') || /\.(png|jpg|jpeg|gif|webp|svg|css|js|woff2?)$/i.test(email) || email.length > 254) continue;
      if (!addresses.has(email)) {
        const index = text.toLowerCase().indexOf(email);
        addresses.set(email, index < 0 ? '' : text.slice(Math.max(0, index - 80), index + email.length + 100));
      }
    }
  }
  return { title, emails: [...addresses].map(([email, context]) => ({ email, context })), links };
}

export function toCsv(results) {
  const cell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const rows = [['email', 'source_url', 'page_title', 'context', 'found_at']];
  for (const result of results) for (const source of result.sources) rows.push([result.email, source.url, source.title, source.context, source.found_at]);
  return '\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

import https from 'node:https';
import { lookup } from 'node:dns/promises';

function publicAddress(address) {
  if (address.includes(':')) return /^[23][0-9a-f]{3}:/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19)));
}

async function get(url, maxBytes = 2_000_000) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
    throw new Error('Only public HTTPS pages on port 443 are supported.');
  }
  if (/(^|\.)linkedin\.com$/i.test(parsed.hostname)) throw new Error('LinkedIn discovery is not supported.');
  const addresses = await lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Private/local network addresses are not allowed.');
  // Pin the checked address to prevent DNS rebinding between validation and connection.
  const chosen = addresses[0];
  return new Promise((resolve, reject) => {
    const request = https.get(parsed, {
      headers: { 'User-Agent': 'CompanyContactDiscovery/1.0', Accept: 'text/html,text/plain' },
      lookup: (_host, options, callback) => options.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family)
    }, response => {
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) response.destroy(new Error('Page exceeds size limit.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, type: response.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8') }));
    });
    const deadline = setTimeout(() => request.destroy(new Error('Page request timed out.')), 15000);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', reject);
  });
}

export function robotsAllows(text, url) {
  const groups = [];
  let group = { agents: [], rules: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase(), value = match[2].trim();
    if (key === 'user-agent') {
      if (group.rules.length) { groups.push(group); group = { agents: [], rules: [] }; }
      group.agents.push(value.toLowerCase());
    } else if (group.agents.length && ['allow', 'disallow'].includes(key) && value) group.rules.push({ key, value });
  }
  groups.push(group);
  const specific = groups.filter(g => g.agents.some(a => a !== '*' && 'companycontactdiscovery'.includes(a)));
  const relevant = specific.length ? specific : groups.filter(g => g.agents.includes('*'));
  const target = new URL(url).pathname + new URL(url).search;
  const matches = relevant.flatMap(g => g.rules).filter(rule => {
    const end = rule.value.endsWith('$');
    const pattern = (end ? rule.value.slice(0, -1) : rule.value).split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp('^' + pattern + (end ? '$' : '')).test(target);
  }).sort((a, b) => b.value.length - a.value.length || (a.key === 'allow' ? -1 : 1));
  return !matches.length || matches[0].key === 'allow';
}

export function extractEmails(html) {
  const visible = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/&#64;|&#x40;|&commat;/gi, '@').replace(/&#46;|&#x2e;/gi, '.');
  const matches = visible.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}/gi) || [];
  return [...new Set(matches.map(s => s.toLowerCase()).filter(s => !/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(s)))];
}

export async function discoverPage(url, getter = get) {
  const page = new URL(url);
  const robots = await getter(new URL('/robots.txt', page).href, 256000);
  if (robots.status !== 404 && (robots.status !== 200 || !robotsAllows(robots.body, page.href))) {
    throw new Error('Discovery skipped: robots.txt denies access or could not be checked.');
  }
  const result = await getter(page.href);
  if (result.status !== 200 || !/text\/(html|plain)/i.test(result.type)) {
    throw new Error(`Page unavailable or not HTML/text (HTTP ${result.status}). Redirects are not followed; supply the final public URL.`);
  }
  return extractEmails(result.body).map(email => ({ email, source_url: page.href, discovered_at: new Date().toISOString(), approved: false }));
}

import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeUrl, parsePage, siteName } from './html.mjs';
import { requestPage } from './network.mjs';
import { parseRobots } from './robots.mjs';

export async function crawl(seeds, { maxPages = 20, maxDepth = 2, delayMs = 1500, signal, request = requestPage, wait = sleep, progress = () => {} } = {}) {
  if (!Array.isArray(seeds) || !seeds.length || seeds.length > 100) throw new Error('Supply between 1 and 100 website URLs.');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('max-pages must be between 1 and 100.');
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 5) throw new Error('max-depth must be between 0 and 5.');
  if (!Number.isInteger(delayMs) || delayMs < 1000 || delayMs > 60000) throw new Error('delay must be between 1000 and 60000 milliseconds.');
  const report = { started_at: new Date().toISOString(), demo: false, stopped: false, pages: [], results: [] };
  const found = new Map(), robotsCache = new Map(), stoppedSites = new Set(), siteCounts = new Map(), visited = new Set(), queued = new Set();
  let lastRequest = 0;
  async function get(url, robots = false) {
    if (signal?.aborted) throw new Error('Stopped by user.');
    const policy = robotsCache.get(new URL(url).origin);
    const interval = Math.max(delayMs, policy?.delay || 0);
    const remaining = interval - (Date.now() - lastRequest);
    if (remaining > 0) await wait(remaining, undefined, { signal });
    lastRequest = Date.now();
    return request(url, { signal, maxBytes: robots ? 512000 : 2_000_000 });
  }
  async function robotsFor(url) {
    const origin = new URL(url).origin;
    if (robotsCache.has(origin)) return robotsCache.get(origin);
    let target = new URL('/robots.txt', origin).href, policy;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await get(target, true);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = normalizeUrl(response.headers.location || '', target);
        if (siteName(next) !== siteName(url)) throw new Error('robots.txt redirects outside the website; skipped.');
        target = next;
        continue;
      }
      if ([404, 410].includes(response.status)) policy = parseRobots('');
      else if (response.status === 200) {
        if (/<(?:!doctype|html|body)\b/i.test(response.body.slice(0, 500))) throw new Error('robots.txt returned HTML; skipped.');
        policy = parseRobots(response.body);
      } else throw new Error(`Cannot check robots.txt (HTTP ${response.status}); skipped.`);
      break;
    }
    if (!policy) throw new Error('Too many robots.txt redirects.');
    if (policy.delay > 60000) throw new Error('Website requests more than 60 seconds between requests; skipped.');
    robotsCache.set(origin, policy);
    return policy;
  }
  const queue = [];
  function enqueue(url, depth, priority = 1) {
    if (queued.has(url) || visited.has(url) || queued.size >= 10000) return;
    queued.add(url); queue.push({ url, depth, priority });
  }
  for (const seed of seeds) {
    try { enqueue(normalizeUrl(seed), 0, 0); }
    catch (error) { report.pages.push({ url: String(seed), status: 'skipped', reason: error.message }); }
  }
  while (queue.length && report.pages.length < 1000 && !signal?.aborted) {
    queue.sort((a, b) => a.depth - b.depth || a.priority - b.priority);
    const item = queue.shift();
    const site = siteName(item.url);
    if (visited.has(item.url) || stoppedSites.has(site) || (siteCounts.get(site) || 0) >= maxPages) continue;
    siteCounts.set(site, (siteCounts.get(site) || 0) + 1);
    let current = item.url;
    try {
      let response;
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (visited.has(current)) { response = null; break; }
        visited.add(current);
        const robots = await robotsFor(current);
        if (!robots.allows(current)) throw new Error('Disallowed by robots.txt.');
        response = await get(current);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const next = normalizeUrl(response.headers.location || '', current);
          if (siteName(next) !== site) throw new Error('Redirect leaves the supplied website; skipped.');
          current = next;
          response = null;
          continue;
        }
        break;
      }
      if (!response) throw new Error('Already visited or too many redirects.');
      if ([401, 403, 429, 503].includes(response.status)) stoppedSites.add(site);
      if (response.status !== 200) throw new Error(`HTTP ${response.status}; page skipped.`);
      if (!/^text\/(html|plain)\b/i.test(response.headers['content-type'] || '')) throw new Error('Not an HTML or plain-text page.');
      if (/\/cdn-cgi\/challenge-platform|cf-chl-|<title[^>]*>\s*(?:Just a moment|Access denied|Verify you are human)/i.test(response.body)) {
        stoppedSites.add(site); throw new Error('Access challenge detected; website skipped.');
      }
      const page = parsePage(response.body, current);
      for (const entry of page.emails) {
        if (!found.has(entry.email)) found.set(entry.email, { email: entry.email, sources: [] });
        const result = found.get(entry.email);
        if (!result.sources.some(source => source.url === current)) result.sources.push({ url: current, title: page.title, context: entry.context, found_at: new Date().toISOString() });
      }
      report.pages.push({ url: current, status: 'fetched', emails_found: page.emails.length });
      progress({ url: current, status: 'fetched', emails: page.emails.length });
      if (item.depth < maxDepth) for (const link of page.links) enqueue(link.url, item.depth + 1, link.priority);
    } catch (error) {
      if (signal?.aborted) break;
      report.pages.push({ url: current, status: 'skipped', reason: error.message });
      progress({ url: current, status: 'skipped', reason: error.message });
    }
  }
  report.stopped = Boolean(signal?.aborted);
  report.finished_at = new Date().toISOString();
  report.results = [...found.values()].sort((a, b) => a.email.localeCompare(b.email));
  report.unique_emails = report.results.length;
  report.pages_fetched = report.pages.filter(page => page.status === 'fetched').length;
  report.pages_skipped = report.pages.filter(page => page.status === 'skipped').length;
  return report;
}

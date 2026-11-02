export function parseRobots(text) {
  const groups = [];
  let group = { agents: [], rules: [], delay: 0 }, hasDirectives = false;
  for (const raw of text.replace(/^\ufeff/, '').split(/\r?\n/)) {
    const match = raw.split('#')[0].trim().match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const name = match[1].trim().toLowerCase(), value = match[2].trim();
    if (name === 'user-agent') {
      if (hasDirectives) { groups.push(group); group = { agents: [], rules: [], delay: 0 }; hasDirectives = false; }
      group.agents.push(value.toLowerCase());
    } else if (group.agents.length) {
      hasDirectives = true;
      if ((name === 'allow' || name === 'disallow') && value) group.rules.push({ allow: name === 'allow', path: value });
      if (name === 'crawl-delay' && Number.isFinite(Number(value)) && Number(value) > 0) group.delay = Math.max(group.delay, Number(value) * 1000);
    }
  }
  groups.push(group);
  const specific = groups.filter(g => g.agents.some(agent => agent !== '*' && agent && 'publicemailfinder'.includes(agent)));
  const selected = specific.length ? specific : groups.filter(g => g.agents.includes('*'));
  const rules = selected.flatMap(g => g.rules);
  const delay = Math.max(0, ...selected.map(g => g.delay));
  const unreserved = value => value.replace(/%([0-9a-f]{2})/gi, (encoded, hex) => {
    const decoded = String.fromCharCode(parseInt(hex, 16));
    return /[a-z0-9._~-]/i.test(decoded) ? decoded : encoded.toUpperCase();
  });
  return {
    delay,
    allows(input) {
      const url = new URL(input);
      const target = unreserved(url.pathname + url.search);
      let winner = null;
      for (const rule of rules) {
        const path = unreserved(rule.path), end = path.endsWith('$');
        const pattern = (end ? path.slice(0, -1) : path).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        const length = Buffer.byteLength(path.replace(/\*/g, '').replace(/\$$/, ''));
        if (new RegExp('^' + pattern + (end ? '$' : '')).test(target) && (!winner || length > winner.length || (length === winner.length && rule.allow))) winner = { ...rule, length };
      }
      return !winner || winner.allow;
    }
  };
}

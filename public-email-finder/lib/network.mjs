import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blocked.addSubnet(address, prefix);

export function allowedAddress(address) {
  return isIP(address) === 4 && !blocked.check(address);
}

export async function requestPage(input, { signal, maxBytes = 2_000_000 } = {}) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Only public HTTPS on port 443 is supported.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || /(^|\.)linkedin\.com$/.test(host)) throw new Error('This hostname is not supported.');
  const addresses = await lookup(host, { family: 4, all: true });
  if (!addresses.length || addresses.some(item => !allowedAddress(item.address))) throw new Error('Private or reserved network addresses are not supported.');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      signal,
      headers: { 'User-Agent': 'PublicEmailFinder/1.0', Accept: 'text/html,text/plain', 'Accept-Encoding': 'identity' },
      lookup: (_hostname, options, callback) => options.all ? callback(null, [selected]) : callback(null, selected.address, selected.family)
    }, response => {
      let length = 0;
      const chunks = [];
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        response.destroy(new Error('Compressed response was not requested; page skipped.'));
      }
      response.on('data', chunk => {
        length += chunk.length;
        if (length > maxBytes) response.destroy(new Error('Page exceeds download size limit.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    const timeout = setTimeout(() => request.destroy(new Error('Page request timed out after 15 seconds.')), 15000);
    request.on('close', () => clearTimeout(timeout));
    request.on('error', reject);
  });
}

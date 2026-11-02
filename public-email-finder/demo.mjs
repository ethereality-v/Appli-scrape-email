export const demoSeed = 'https://demo.example.test/';

const pages = new Map([
  ['/robots.txt', 'User-agent: *\nDisallow: /private'],
  ['/', `<html><head><title>Demo Company</title></head><body>
    <h1>Demo Company</h1><p>General enquiries: info@example.test</p>
    <a href="/team">Meet our team</a><a href="/contact">Contact</a>
    <a href="/private">Private area</a>
    <a href="https://another.example.test/">External website</a>
    <script>const hidden = 'hidden@example.test';</script>
    </body></html>`],
  ['/team', `<html><head><title>Our team</title></head><body>
    <h2>Alex Rivera — Director</h2><a href="mailto:alex@example.test">Email Alex</a>
    <h2>Jamie Chen — Coordinator</h2><p>jamie [at] example [dot] test</p>
    <a href="/">Home</a></body></html>`],
  ['/contact', '<html><head><title>Contact</title></head><body>Contact info&#64;example.test <a href="/team">Team</a></body></html>']
]);

export async function demoRequest(input) {
  const url = new URL(input);
  if (url.origin !== new URL(demoSeed).origin) throw new Error('Demo cannot access external websites.');
  if (url.pathname === '/private') throw new Error('The robots-denied demo page must never be requested.');
  return {
    status: pages.has(url.pathname) ? 200 : 404,
    headers: { 'content-type': url.pathname === '/robots.txt' ? 'text/plain' : 'text/html' },
    body: pages.get(url.pathname) || 'Not found'
  };
}

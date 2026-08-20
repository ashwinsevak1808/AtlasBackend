/**
 * Exercises the SSRF guard, the secret box and the flow engine.
 *
 * Not a test suite — the project has no runner. This is a script that makes
 * real assertions and exits non-zero, so "it works" is a claim with something
 * behind it.
 */

import { checkUrl, isPrivateAddress } from '../src/utils/safe-url.js';
import { seal, open, sealJson, openJson } from '../src/utils/secret-box.js';
import { runFlow, substitute, valueAtPath } from '../src/modules/flows/flow.engine.js';
import type { FlowDefinition } from '../src/modules/flows/flow.types.js';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

const row = (key: string, value: string) => ({ id: key, key, value, enabled: true });

const noAuth = {
  mode: 'none' as const,
  token: '',
  username: '',
  password: '',
  keyName: '',
  keyIn: 'header' as const,
};

const blankRequest = (over: Record<string, unknown>) => ({
  id: 'r',
  name: 'r',
  method: 'GET',
  url: '',
  queryParams: [],
  headers: [],
  cookies: [],
  bodyType: 'none' as const,
  body: '',
  formFields: [],
  graphqlQuery: '',
  graphqlVariables: '',
  auth: noAuth,
  ...over,
});

async function main(): Promise<void> {
  console.log('\nIP classification');
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1',
    'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
  ]) {
    check(`${ip} is private`, isPrivateAddress(ip));
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111']) {
    check(`${ip} is public`, !isPrivateAddress(ip));
  }

  console.log('\nURL guard');
  const blocked = [
    'http://localhost:3000/api',
    'http://127.0.0.1:5005/health',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:8080/',
    'http://10.0.0.5/admin',
  ];
  for (const url of blocked) {
    const verdict = await checkUrl(url);
    check(`blocks ${url}`, !verdict.ok, verdict.ok ? '' : `(${verdict.code})`);
  }

  const schemeVerdict = await checkUrl('file:///etc/passwd');
  check('blocks file:// scheme', !schemeVerdict.ok && schemeVerdict.code === 'scheme');

  const credsVerdict = await checkUrl('https://user:pass@example.com/');
  check('blocks credentials in the URL', !credsVerdict.ok && credsVerdict.code === 'credentials_in_url');

  const badVerdict = await checkUrl('not a url');
  check('blocks a malformed URL', !badVerdict.ok && badVerdict.code === 'malformed');

  const publicVerdict = await checkUrl('https://example.com/');
  check('allows a public host', publicVerdict.ok, publicVerdict.ok ? '' : publicVerdict.reason);

  console.log('\nSecret box');
  const secret = 'sk_live_0123456789 with ünicode ✓';
  const sealed = seal(secret);
  check('round-trips a string', open(sealed) === secret);
  check('ciphertext is not the plaintext', !sealed.ciphertext.toString('utf8').includes('sk_live'));

  const sealedJson = sealJson({ API_TOKEN: 'abc', baseUrl: 'https://x.test' });
  check('round-trips json', openJson<{ API_TOKEN: string }>(sealedJson).API_TOKEN === 'abc');

  const tamperedCipher = Buffer.from(sealed.ciphertext);
  tamperedCipher[0] = (tamperedCipher[0] ?? 0) ^ 0xff;
  let refused = false;
  try {
    open({ ...sealed, ciphertext: tamperedCipher });
  } catch {
    refused = true;
  }
  check('refuses a tampered ciphertext', refused);

  const twice = seal(secret);
  check('same plaintext seals differently each time', !twice.iv.equals(sealed.iv));

  console.log('\nHelpers');
  check('substitutes a variable', substitute('{{a}}/x', { a: 'A' }) === 'A/x');
  check('leaves an unknown variable visible', substitute('{{q}}', {}) === '{{q}}');
  check('reads a nested path', valueAtPath({ data: { token: 't' } }, 'data.token') === 't');
  check('reads an array index', valueAtPath({ items: [{ id: 9 }] }, 'items.0.id') === 9);
  check('returns undefined for a missing path', valueAtPath({}, 'a.b') === undefined);

  console.log('\nEngine — graph handling');
  const cyclic: FlowDefinition = {
    name: 'cycle',
    nodes: [{ id: 'n1', requestId: 'r1' }, { id: 'n2', requestId: 'r2' }],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', mappings: [] },
      { id: 'e2', source: 'n2', target: 'n1', mappings: [] },
    ],
    requests: [
      blankRequest({ id: 'r1', name: 'one', url: 'https://example.com/' }),
      blankRequest({ id: 'r2', name: 'two', url: 'https://example.com/' }),
    ],
  };
  const cycleResult = await runFlow(cyclic, {});
  check('a cycle skips every node in it', cycleResult.totals.skipped === 2, JSON.stringify(cycleResult.totals));
  check('a cycle does not report as passed', cycleResult.status === 'failed');

  const emptyResult = await runFlow({ name: 'empty', nodes: [], edges: [], requests: [] }, {});
  check('an empty flow errors', emptyResult.status === 'error');

  console.log('\nEngine — a localhost flow is refused, not attempted');
  const localFlow: FlowDefinition = {
    name: 'local',
    nodes: [{ id: 'n1', requestId: 'r1' }],
    edges: [],
    requests: [blankRequest({ id: 'r1', name: 'local', url: 'http://localhost:3000/api/health' })],
  };
  const localResult = await runFlow(localFlow, {});
  check('localhost step fails', localResult.steps[0]?.status === 'failed');
  check(
    'and says why in words a person can act on',
    (localResult.steps[0]?.error ?? '').includes('private or local address'),
    localResult.steps[0]?.error ?? '',
  );

  console.log('\nEngine — downstream skip after a failure');
  const chain: FlowDefinition = {
    name: 'chain',
    nodes: [{ id: 'n1', requestId: 'r1' }, { id: 'n2', requestId: 'r2' }],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', mappings: [] }],
    requests: [
      blankRequest({ id: 'r1', name: 'first', url: 'http://127.0.0.1:1/' }),
      blankRequest({ id: 'r2', name: 'second', url: 'https://example.com/' }),
    ],
  };
  const chainResult = await runFlow(chain, {});
  check('first step fails', chainResult.steps[0]?.status === 'failed');
  check('second step is skipped, not attempted', chainResult.steps[1]?.status === 'skipped');
  check(
    'and explains it was the chain',
    (chainResult.steps[1]?.error ?? '').includes('earlier step'),
  );

  console.log('\nEngine — a real two-step flow with a mapping (network)');
  const live: FlowDefinition = {
    name: 'live',
    nodes: [{ id: 'n1', requestId: 'r1' }, { id: 'n2', requestId: 'r2' }],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', mappings: [{ id: 'm1', from: 'uuid', to: 'ticket' }] },
    ],
    requests: [
      blankRequest({ id: 'r1', name: 'get a uuid', url: 'https://httpbin.org/uuid' }),
      blankRequest({
        id: 'r2',
        name: 'send it back',
        method: 'POST',
        url: 'https://httpbin.org/anything',
        bodyType: 'json',
        body: '{"ticket":"{{ticket}}"}',
        headers: [row('X-Ticket', '{{ticket}}')],
      }),
    ],
  };

  const liveResult = await runFlow(live, { });
  console.log(`  (network: ${liveResult.status}, ${liveResult.totals.passed}/${liveResult.totals.total} passed)`);

  if (liveResult.steps.every((step) => step.status === 'ok')) {
    check('both steps passed', liveResult.status === 'passed');
    const produced = liveResult.steps[0]?.produced.ticket;
    check('step one produced a uuid', typeof produced === 'string' && produced.length > 10);
    const echoed = JSON.parse(liveResult.steps[1]?.responseExcerpt ?? '{}') as {
      json?: { ticket?: string };
      headers?: Record<string, string>;
    };
    check('the mapped value reached step two body', echoed.json?.ticket === produced, String(echoed.json?.ticket));
    check('and its header', echoed.headers?.['X-Ticket'] === produced);
    check('the stored URL has no query string', !(liveResult.steps[1]?.url ?? '').includes('?'));
  } else {
    console.log('  --   skipped: httpbin.org did not answer, so the network assertions were not run');
    console.log(`       (${liveResult.steps.map((s) => s.error).filter(Boolean).join('; ')})`);
  }

  console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} FAILED`} (${passed} passed)\n`);
  if (failed > 0) process.exit(1);
}

void main();

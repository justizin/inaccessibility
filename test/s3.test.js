import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signRequest, S3Storage } from '../src/storage/s3.js';

// Vector from the AWS SigV4 docs ("GET Object" example for examplebucket).
test('SigV4 signature matches the AWS example', async () => {
  const headers = await signRequest({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    headers: { Range: 'bytes=0-9' },
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(headers['x-amz-date'], '20130524T000000Z');
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
  );
});

test('S3Storage speaks path-style to RGW and parses listings', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (init.method === 'PUT' || init.method === 'DELETE') return new Response(null, { status: init.method === 'PUT' ? 200 : 204 });
    if (url.includes('list-type=2')) {
      const xml = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>reports/a1b2c3d4.json</Key></Contents><Contents><Key>reports/a1b2c3d4/01-shot&amp;x.png</Key></Contents></ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    if (url.endsWith('/missing.json')) return new Response('nope', { status: 404 });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '11' } });
  };
  const s3 = new S3Storage({ endpoint: 'http://127.0.0.1:7480', bucket: 'inaccessibility', accessKeyId: 'k', secretAccessKey: 's', fetch: fakeFetch });

  await s3.put('reports/x y.json', '{"ok":true}', 'application/json');
  assert.equal(calls[0].url, 'http://127.0.0.1:7480/inaccessibility/reports/x%20y.json');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.match(calls[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=k\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);

  const got = await s3.get('reports/x y.json');
  assert.equal(got.size, 11);
  assert.equal(await new Response(got.body).text(), '{"ok":true}');
  assert.equal(await s3.get('missing.json'), null);

  const keys = await s3.list('reports/');
  assert.deepEqual(keys, ['reports/a1b2c3d4.json', 'reports/a1b2c3d4/01-shot&x.png']);
  assert.match(calls.at(-1).url, /\/inaccessibility\/\?list-type=2&prefix=reports%2F&max-keys=1000$/);

  await s3.delete('reports/a1b2c3d4.json');
  assert.equal(calls.at(-1).method, 'DELETE');
});

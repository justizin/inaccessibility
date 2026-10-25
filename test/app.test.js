import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { FsStorage } from '../src/storage/fs.js';

const TOKEN = 'correct horse';
let dir, app;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'inaccessibility-'));
  app = createApp(() => ({ storage: new FsStorage(dir), accessToken: TOKEN }));
});
after(() => rm(dir, { recursive: true, force: true }));

const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])], { type: 'image/png' });
const audio = () => new Blob([new Uint8Array(32)], { type: 'audio/webm;codecs=opus' });
let cookie = '';
const authed = (init = {}) => ({ ...init, headers: { ...(init.headers || {}), cookie } });

test('health is open, everything else needs a session', async () => {
  assert.equal((await app.request('/api/health')).status, 200);
  assert.equal((await app.request('/api/reports')).status, 401);
  const s = await (await app.request('/api/session')).json();
  assert.deepEqual(s, { authRequired: true, authenticated: false });
});

test('wrong passphrase is rejected, right one sets a cookie', async () => {
  const bad = await app.request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'nope' }) });
  assert.equal(bad.status, 401);
  const ok = await app.request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
  assert.equal(ok.status, 200);
  cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^inaccessibility_session=/);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  const s = await (await app.request('/api/session', authed())).json();
  assert.equal(s.authenticated, true);
});

test('bearer token works too', async () => {
  const res = await app.request('/api/reports', { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
});

let reportId;
test('create a report with a screenshot and a voice note', async () => {
  const fd = new FormData();
  fd.set('note', 'Button has no accessible name');
  fd.set('transcript', 'the icon button next to search');
  fd.set('url', 'https://example.com/search');
  fd.set('context', JSON.stringify({ rootFontSizePx: 24 }));
  fd.append('file', png(), 'Screenshot 2026-10-24.png');
  fd.append('file', audio(), 'voice-note.webm');
  const res = await app.request('/api/reports', authed({ method: 'POST', body: fd }));
  assert.equal(res.status, 201);
  const r = await res.json();
  reportId = r.id;
  assert.match(r.id, /^[a-z0-9]{8,32}$/);
  assert.equal(r.note, 'Button has no accessible name');
  assert.equal(r.context.rootFontSizePx, 24);
  assert.equal(r.files.length, 2);
  assert.equal(r.files[0].kind, 'screenshot');
  assert.match(r.files[0].name, /^01-screenshot-2026-10-24-[a-z0-9]{4}\.png$/);
  assert.equal(r.files[1].kind, 'audio');
  assert.match(r.files[1].name, /\.webm$/);
});

test('list, get, and download the attachment with safe headers', async () => {
  const { reports } = await (await app.request('/api/reports', authed())).json();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].id, reportId);
  const r = await (await app.request(`/api/reports/${reportId}`, authed())).json();
  const file = await app.request(`/api/reports/${reportId}/files/${r.files[0].name}`, authed());
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal(file.headers.get('content-length'), '8');
  assert.equal(file.headers.get('content-security-policy'), 'sandbox');
  assert.equal(new Uint8Array(await file.arrayBuffer())[0], 0x89);
  assert.equal((await app.request(`/api/reports/${reportId}/files/nope.png`, authed())).status, 404);
  assert.equal((await app.request(`/api/reports/${reportId}/files/..%2F..%2Fetc%2Fpasswd`, authed())).status, 404);
});

test('patch fields, add and remove a file', async () => {
  const patched = await (await app.request(`/api/reports/${reportId}`, authed({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'updated', bogus: 1 }) }))).json();
  assert.equal(patched.note, 'updated');
  assert.equal(patched.bogus, undefined);
  const fd = new FormData();
  fd.append('file', png(), 'second.png');
  const added = await (await app.request(`/api/reports/${reportId}/files`, authed({ method: 'POST', body: fd }))).json();
  assert.equal(added.files.length, 3);
  const removed = await (await app.request(`/api/reports/${reportId}/files/${added.files[2].name}`, authed({ method: 'DELETE' }))).json();
  assert.equal(removed.files.length, 2);
  assert.equal((await app.request(`/api/reports/${reportId}/files/${added.files[2].name}`, authed())).status, 404);
});

test('share target creates a report and redirects into the editor', async () => {
  const fd = new FormData();
  fd.set('title', 'Shared from Android');
  fd.set('text', 'contrast is unreadable');
  fd.append('screenshots', png(), 'shot.png');
  const res = await app.request('/api/share', authed({ method: 'POST', body: fd }));
  assert.equal(res.status, 303);
  const loc = res.headers.get('location');
  assert.match(loc, /^\/#edit=[a-z0-9]+$/);
  const id = loc.split('=')[1];
  const r = await (await app.request(`/api/reports/${id}`, authed())).json();
  assert.equal(r.note, 'Shared from Android\n\ncontrast is unreadable');
  assert.equal(r.files.length, 1);
  // unauthenticated share bounces to the login screen instead of a JSON 401
  const anon = await app.request('/api/share', { method: 'POST', body: new FormData() });
  assert.equal(anon.status, 303);
  assert.equal(anon.headers.get('location'), '/?login=1');
});

test('newest first, delete removes the report and its files', async () => {
  const { reports } = await (await app.request('/api/reports', authed())).json();
  assert.equal(reports.length, 2);
  assert.ok(reports[0].createdAt >= reports[1].createdAt);
  assert.equal((await app.request(`/api/reports/${reportId}`, authed({ method: 'DELETE' }))).status, 200);
  assert.equal((await app.request(`/api/reports/${reportId}`, authed())).status, 404);
  const storage = new FsStorage(dir);
  assert.deepEqual((await storage.list(`reports/${reportId}`)), []);
});

test('no access token configured means no auth', async () => {
  const open = createApp(() => ({ storage: new FsStorage(dir), accessToken: '' }));
  assert.equal((await open.request('/api/reports')).status, 200);
  assert.deepEqual(await (await open.request('/api/session')).json(), { authRequired: false, authenticated: true });
});

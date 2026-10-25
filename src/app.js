// The API. Runtime-agnostic: works on Node and Cloudflare Workers.
//
// Layout in storage:
//   reports/<id>.json          report metadata (note, transcript, url, context, files[])
//   reports/<id>/<filename>    attachments (screenshots, voice notes)
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const SESSION_COOKIE = 'inaccessibility_session';
const OPEN_PATHS = new Set(['/api/session', '/api/health']);
const ID_RE = /^[a-z0-9]{8,32}$/;
const FILENAME_RE = /^[a-z0-9][a-z0-9._-]{0,120}$/i;
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif|bmp|heic|heif)|audio\/.+)$/;
const EXT_BY_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp',
  'image/heic': 'heic', 'image/heif': 'heif', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/3gpp': '3gp', 'video/webm': 'webm', 'video/mp4': 'mp4',
};

const nowIso = () => new Date().toISOString();
const reportKey = (id) => `reports/${id}.json`;
const fileKey = (id, name) => `reports/${id}/${name}`;
const str = (fd, name) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v : '';
};
const isFileLike = (v) => v && typeof v === 'object' && typeof v.arrayBuffer === 'function';

export function newId() {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  return Date.now().toString(36) + [...rand].map((b) => (b % 36).toString(36)).join('');
}

export function kindOf(type) {
  if (type.startsWith('image/')) return 'screenshot';
  if (type.startsWith('audio/')) return 'audio';
  return 'other';
}

function makeFileName(index, original, type) {
  const base = (original || '').replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || kindOf(type);
  const ext = EXT_BY_TYPE[type.split(';')[0]] || (original || '').match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() || 'bin';
  const rand = newId().slice(-4);
  return `${String(index).padStart(2, '0')}-${base}-${rand}.${ext}`;
}

function parseJson(s) {
  if (!s) return undefined;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function loadReport(storage, id) {
  if (!ID_RE.test(id)) return null;
  const got = await storage.get(reportKey(id));
  if (!got) return null;
  try {
    return JSON.parse(await new Response(got.body).text());
  } catch {
    return null;
  }
}

async function saveReport(storage, report) {
  report.updatedAt = nowIso();
  await storage.put(reportKey(report.id), JSON.stringify(report), 'application/json');
  return report;
}

async function addFiles(storage, report, entries) {
  let added = 0;
  for (const f of entries) {
    if (!isFileLike(f) || f.size === 0) continue;
    const type = (f.type || 'application/octet-stream').toLowerCase();
    const name = makeFileName(report.files.length + 1, f.name, type);
    const bytes = new Uint8Array(await f.arrayBuffer());
    await storage.put(fileKey(report.id, name), bytes, type);
    report.files.push({ name, type, size: bytes.byteLength, kind: kindOf(type), addedAt: nowIso() });
    added++;
  }
  return added;
}

function reportFromFields(fd, id) {
  const now = nowIso();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    note: str(fd, 'note'),
    transcript: str(fd, 'transcript'),
    url: str(fd, 'url'),
    context: parseJson(str(fd, 'context')),
    files: [],
  };
}

/**
 * @param {(c: import('hono').Context) => {storage: object, accessToken?: string} | Promise<...>} getDeps
 */
export function createApp(getDeps) {
  const app = new Hono();

  app.use('/api/*', async (c, next) => {
    const deps = await getDeps(c);
    c.set('deps', deps);
    if (OPEN_PATHS.has(c.req.path) || !deps.accessToken) return next();
    const auth = c.req.header('authorization') || '';
    const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : getCookie(c, SESSION_COOKIE);
    if (presented && (await safeEqual(presented, deps.accessToken))) return next();
    if (c.req.path === '/api/share') return c.redirect('/?login=1', 303);
    return c.json({ error: 'unauthorized' }, 401);
  });

  app.get('/api/health', (c) => c.json({ ok: true, storage: c.get('deps').storage.kind }));

  app.get('/api/session', async (c) => {
    const { accessToken } = c.get('deps');
    const presented = getCookie(c, SESSION_COOKIE);
    const authenticated = !accessToken || Boolean(presented && (await safeEqual(presented, accessToken)));
    return c.json({ authRequired: Boolean(accessToken), authenticated });
  });

  app.post('/api/session', async (c) => {
    const { accessToken } = c.get('deps');
    const body = await c.req.json().catch(() => ({}));
    const token = typeof body.token === 'string' ? body.token : '';
    if (accessToken && !(await safeEqual(token, accessToken))) return c.json({ error: 'wrong passphrase' }, 401);
    if (accessToken) {
      const secure = new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
      setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: 60 * 60 * 24 * 365 });
    }
    return c.json({ ok: true });
  });

  app.delete('/api/session', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/reports', async (c) => {
    const { storage } = c.get('deps');
    const keys = (await storage.list('reports/')).filter((k) => /^reports\/[a-z0-9]+\.json$/.test(k));
    const reports = [];
    for (let i = 0; i < keys.length; i += 16) {
      const chunk = keys.slice(i, i + 16);
      reports.push(...(await Promise.all(chunk.map((k) => loadReport(storage, k.slice('reports/'.length, -'.json'.length))))));
    }
    const list = reports.filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return c.json({ reports: list });
  });

  app.post('/api/reports', async (c) => {
    const { storage } = c.get('deps');
    const fd = await c.req.formData();
    const report = reportFromFields(fd, newId());
    await addFiles(storage, report, fd.getAll('file'));
    await saveReport(storage, report);
    return c.json(report, 201);
  });

  // Web Share Target (PWA): a shared screenshot becomes a new report, then we
  // bounce to the UI with that report open for annotation.
  app.post('/api/share', async (c) => {
    const { storage } = c.get('deps');
    const fd = await c.req.formData();
    const report = reportFromFields(fd, newId());
    report.note = [str(fd, 'title'), str(fd, 'text')].filter(Boolean).join('\n\n');
    report.context = { via: 'share-target' };
    await addFiles(storage, report, [...fd.getAll('screenshots'), ...fd.getAll('file')]);
    await saveReport(storage, report);
    return c.redirect(`/#edit=${report.id}`, 303);
  });

  app.get('/api/reports/:id', async (c) => {
    const report = await loadReport(c.get('deps').storage, c.req.param('id'));
    return report ? c.json(report) : c.json({ error: 'not found' }, 404);
  });

  app.patch('/api/reports/:id', async (c) => {
    const { storage } = c.get('deps');
    const report = await loadReport(storage, c.req.param('id'));
    if (!report) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: 'expected a JSON object' }, 400);
    for (const field of ['note', 'transcript', 'url']) if (typeof body[field] === 'string') report[field] = body[field];
    if (body.context && typeof body.context === 'object') report.context = { ...(report.context || {}), ...body.context };
    return c.json(await saveReport(storage, report));
  });

  app.post('/api/reports/:id/files', async (c) => {
    const { storage } = c.get('deps');
    const report = await loadReport(storage, c.req.param('id'));
    if (!report) return c.json({ error: 'not found' }, 404);
    const fd = await c.req.formData();
    await addFiles(storage, report, fd.getAll('file'));
    return c.json(await saveReport(storage, report));
  });

  app.get('/api/reports/:id/files/:name', async (c) => {
    const { storage } = c.get('deps');
    const id = c.req.param('id'), name = c.req.param('name');
    if (!FILENAME_RE.test(name)) return c.json({ error: 'not found' }, 404);
    const report = await loadReport(storage, id);
    const meta = report?.files.find((f) => f.name === name);
    if (!meta) return c.json({ error: 'not found' }, 404);
    const got = await storage.get(fileKey(id, name));
    if (!got) return c.json({ error: 'not found' }, 404);
    const inline = INLINE_TYPES.test(meta.type);
    c.header('Content-Type', inline ? meta.type : 'application/octet-stream');
    if (got.size !== undefined) c.header('Content-Length', String(got.size));
    c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`);
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', 'sandbox');
    return c.body(got.body);
  });

  app.delete('/api/reports/:id/files/:name', async (c) => {
    const { storage } = c.get('deps');
    const id = c.req.param('id'), name = c.req.param('name');
    const report = await loadReport(storage, id);
    if (!report) return c.json({ error: 'not found' }, 404);
    const before = report.files.length;
    report.files = report.files.filter((f) => f.name !== name);
    if (report.files.length === before) return c.json({ error: 'not found' }, 404);
    await storage.delete(fileKey(id, name));
    return c.json(await saveReport(storage, report));
  });

  app.delete('/api/reports/:id', async (c) => {
    const { storage } = c.get('deps');
    const id = c.req.param('id');
    const report = await loadReport(storage, id);
    if (!report) return c.json({ error: 'not found' }, 404);
    for (const key of await storage.list(`reports/${id}/`)) await storage.delete(key);
    await storage.delete(reportKey(id));
    return c.json({ ok: true });
  });

  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : c.text('Not found', 404)));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}

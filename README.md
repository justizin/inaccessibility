# Inaccessibility

Capture a screenshot and a voice or text note the moment you hit an
accessibility failure. One screen, three big buttons, no account to create.

- **Screenshot**: file picker / camera roll, paste, drag-and-drop, or "Capture
  my screen" on desktop. On Android (installed as a PWA) the app is a share
  target, so you can share a screenshot straight into it.
- **Voice note**: records with the microphone. Where the browser offers speech
  recognition (Chrome, Safari) it also fills an editable transcript.
- **Text note** plus the page or app it happened on.
- Every note automatically records the environment: user agent, viewport,
  device pixel ratio, root font size (so your browser's text-size setting is on
  record), reduced-motion / contrast / forced-colors / colour-scheme preferences.

The UI is plain HTML, CSS and JavaScript with no build step. It is sized in
`rem`, has no fixed widths or heights, works in forced-colors mode, respects
reduced motion, announces state changes through live regions, and keeps every
control at least 2.75rem tall.

## Run it

```sh
npm install
ACCESS_TOKEN='a passphrase' npm start      # http://localhost:8080, data in ./data
```

Set `ACCESS_TOKEN` to require a passphrase (entered once in the UI, kept in an
HttpOnly cookie, or sent as `Authorization: Bearer`). Leave it unset only if
something else (Cloudflare Access, a VPN, tailnet) is in front.

Tests: `npm test`.

### Storage backends

| `STORAGE` | Where reports go | Settings |
| --- | --- | --- |
| `fs` (default) | a directory | `DATA_DIR` (default `./data`) |
| `s3` | any S3-compatible bucket (Ceph RGW, MinIO, AWS, R2) | `S3_ENDPOINT`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `S3_REGION`, `S3_PATH_STYLE=false` for virtual-host style |
| R2 binding | Cloudflare R2, Workers only | `wrangler.toml` |

The S3 client is a small SigV4 signer on WebCrypto with no SDK dependency.

Layout inside the bucket or directory: `reports/<id>.json` for the note and
`reports/<id>/<file>` for its attachments. Reports are plain JSON, so
`curl -H 'Authorization: Bearer …' /api/reports` is the export.

## Deploy

### Cloudflare Workers (serverless)

```sh
npx wrangler r2 bucket create inaccessibility
npx wrangler secret put ACCESS_TOKEN
npm run cf:deploy
```

Static files are served by Workers Static Assets, the API by the worker, and
reports live in R2. `npm run cf:check` bundles without deploying.

### Outpost, Nomad

Reports go to Ceph RGW over S3 so the allocation is stateless.

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/justizin/inaccessibility:0.1.0 --push .
nomad var put nomad/jobs/inaccessibility \
  access_token='a passphrase' s3_access_key=… s3_secret_key=…
nomad job run deploy/nomad/inaccessibility.nomad.hcl
```

### Kubernetes

Single replica with a PersistentVolume (`STORAGE=fs`); comments in the manifest
show the S3 variant.

```sh
kubectl create namespace inaccessibility
kubectl -n inaccessibility create secret generic inaccessibility --from-literal=ACCESS_TOKEN='a passphrase'
kubectl -n inaccessibility apply -f deploy/k8s/inaccessibility.yaml
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | liveness, no auth |
| `GET` / `POST` / `DELETE` | `/api/session` | check, start (`{"token": …}`), end a session |
| `GET` | `/api/reports` | all reports, newest first |
| `POST` | `/api/reports` | multipart: `note`, `transcript`, `url`, `context` (JSON), `file` (repeatable) |
| `GET` / `PATCH` / `DELETE` | `/api/reports/:id` | read, update fields (JSON), delete with attachments |
| `POST` | `/api/reports/:id/files` | add attachments (multipart `file`) |
| `GET` / `DELETE` | `/api/reports/:id/files/:name` | fetch or remove one attachment |
| `POST` | `/api/share` | Web Share Target; redirects into the editor |

Attachments are served with `Content-Security-Policy: sandbox` and `nosniff`;
anything that is not an image or audio type is forced to download.

## Browser notes

- Screen capture needs a secure context (https or localhost) and a desktop browser.
- Speech-to-text uses the browser's own service (Google's for Chrome, Apple's
  for Safari); the checkbox turns it off and the choice is remembered.
- iOS Safari records voice notes as `audio/mp4`; Chrome and Firefox use
  `audio/webm`. Both play back in the saved list.
- Install the PWA (Add to Home Screen) to use "Share → Inaccessibility" on Android.

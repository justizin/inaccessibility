// Pick a storage backend from environment variables (Node entry point).
//
//   STORAGE=fs   DATA_DIR=./data                       (default)
//   STORAGE=s3   S3_ENDPOINT=http://127.0.0.1:7480 S3_BUCKET=inaccessibility
//                AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
//                [S3_REGION=us-east-1] [S3_PATH_STYLE=true]
import { FsStorage } from './fs.js';
import { S3Storage } from './s3.js';

export function storageFromEnv(env = process.env) {
  const kind = (env.STORAGE || 'fs').toLowerCase();
  if (kind === 'fs') return new FsStorage(env.DATA_DIR || './data');
  if (kind === 's3') {
    return new S3Storage({
      endpoint: env.S3_ENDPOINT,
      bucket: env.S3_BUCKET,
      accessKeyId: env.AWS_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
      region: env.S3_REGION || env.AWS_REGION || 'us-east-1',
      pathStyle: (env.S3_PATH_STYLE || 'true').toLowerCase() !== 'false',
    });
  }
  throw new Error(`unknown STORAGE=${kind} (expected fs or s3)`);
}

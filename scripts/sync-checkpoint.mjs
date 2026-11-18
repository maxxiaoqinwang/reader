import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { decryptBook, encryptBook } from './book-package.mjs';

const ORIGIN = 'https://www.lizhiks.com';
const TTL_MS = 6 * 60 * 60 * 1000;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const LIMITS = new Map([['text/html', 2 * 1024 * 1024], ['image/png', 256 * 1024]]);

function isPositiveDecimal(value) {
  return /^[1-9][0-9]*$/.exec(value)?.[0] === value;
}

function canonicalSource(bookId, url, mediaType) {
  const parsed = new URL(url);
  if (url !== ORIGIN + parsed.pathname) return false;

  if (mediaType === 'image/png') {
    return /^\/asset\/fonts\/[0-9]+\.png$/.test(parsed.pathname);
  }
  if (mediaType !== 'text/html') return false;
  if (parsed.pathname === '/book/' + bookId + '.html') return true;

  const chapter = /^\/read\/([1-9][0-9]*)\/([1-9][0-9]*)\.html$/.exec(parsed.pathname);
  return chapter?.[1] === bookId;
}

async function statIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function checkedDirectory(path, create) {
  const parent = dirname(path);
  if (parent !== path) await checkedDirectory(parent, create);

  let stat = await statIfPresent(path);
  if (!stat && create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    stat = await lstat(path);
  }
  if (!stat?.isDirectory()) throw new Error('Invalid checkpoint directory');
}

async function readBounded(stream, maxBytes) {
  let length = 0;
  const chunks = [];
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('Oversized checkpoint input');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function readEnvelope(path, maxBytes) {
  const original = await lstat(path);
  if (!original.isFile() || original.size < 1 || original.size > maxBytes) {
    throw new Error('Invalid checkpoint file');
  }

  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const file = await open(path, flags);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== original.size || stat.ino !== original.ino || stat.dev !== original.dev) {
      throw new Error('Checkpoint changed while opening');
    }
    const stream = file.createReadStream({ autoClose: false });
    const bytes = await readBounded(stream, maxBytes);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    await file.close();
  }
}

function validBody(body, mediaType, maxBytes) {
  return body.length > 0 && body.length <= maxBytes &&
    (mediaType !== 'image/png' || body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE));
}

async function atomicWrite(path, serialized) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(serialized, 'utf8');
    } finally {
      await file.close();
    }

    const existing = await statIfPresent(path);
    if (existing && !existing.isFile()) throw new Error('Invalid checkpoint target');
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function main() {
  const [operation, directory, bookId, url, mediaType, maximum, ...extra] = process.argv.slice(2);
  const password = process.env.READER_PASSWORD;
  const maxBytes = Number(maximum);
  if (extra.length || !['read', 'write'].includes(operation) || !directory ||
      !bookId || !isPositiveDecimal(bookId) || !url || !canonicalSource(bookId, url, mediaType) ||
      !password?.trim() || !maximum || !isPositiveDecimal(maximum) ||
      !Number.isSafeInteger(maxBytes) || maxBytes > LIMITS.get(mediaType)) {
    throw new Error('Invalid checkpoint configuration');
  }

  const folder = resolve(directory);
  await checkedDirectory(folder, operation === 'write');
  const scope = { version: 1, bookId, url, mediaType };
  const name = createHash('sha256').update(JSON.stringify(scope)).digest('hex') + '.enc';
  const path = join(folder, name);
  const envelopeLimit = 2 * maxBytes + 4096;

  if (operation === 'write') {
    const body = await readBounded(process.stdin, maxBytes);
    if (!validBody(body, mediaType, maxBytes)) throw new Error('Invalid checkpoint body');

    // Encrypted metadata gets the same authentication as the source bytes.
    const payload = JSON.stringify({ ...scope, createdAt: Date.now(), body: body.toString('base64') });
    const envelope = await encryptBook(payload, password);
    if (Buffer.byteLength(envelope) > envelopeLimit) throw new Error('Oversized checkpoint envelope');
    await atomicWrite(path, envelope);
    return;
  }

  const serialized = await readEnvelope(path, envelopeLimit);
  const entry = JSON.parse(await decryptBook(serialized, password));
  if (entry?.version !== scope.version || entry.bookId !== bookId || entry.url !== url ||
      entry.mediaType !== mediaType || !Number.isSafeInteger(entry.createdAt) || typeof entry.body !== 'string') {
    throw new Error('Invalid checkpoint metadata');
  }
  const age = Date.now() - entry.createdAt;
  if (age < 0 || age >= TTL_MS) throw new Error('Expired checkpoint');

  const body = Buffer.from(entry.body, 'base64');
  if (!validBody(body, mediaType, maxBytes) || body.toString('base64') !== entry.body) {
    throw new Error('Invalid checkpoint body');
  }
  process.stdout.write(body);
}

main().catch(() => {
  // The source sync treats an unavailable checkpoint as a cache miss.
  process.exitCode = 1;
});

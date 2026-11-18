import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptBook, encryptBook, requireBookData } from './book-package.mjs';

const seed = {
  id: '229314',
  title: '借妻',
  chapterIds: Array.from({ length: 15 }, (_, index) => index + 1),
};
const manifestName = 'index.json';
const readerScripts = ['reader.js', 'crypto.js'];

class LibraryError extends Error {}

function validateEntry(book) {
  const { id, title, chapterIds } = book;
  if (
    typeof id !== 'string' || !/^[1-9]\d{0,15}$/.test(id) ||
    typeof title !== 'string' || !title.trim() ||
    !Array.isArray(chapterIds) || chapterIds.length === 0 ||
    !chapterIds.every((chapter, index) => Number.isSafeInteger(chapter) && chapter > 0 &&
      (index === 0 || chapter > chapterIds[index - 1]))
  ) {
    throw new Error('Invalid library metadata');
  }
}

async function readLibrary(folder, password) {
  const manifestPath = join(folder, manifestName);
  const files = await readdir(folder);
  const saved = files.includes(manifestName);
  if (!saved && (files.length !== 1 || files[0] !== seed.id + '.json')) {
    throw new LibraryError('Missing the original encrypted library.');
  }
  const encryptedIndex = saved ? await readFile(manifestPath, 'utf-8') : null;
  const originalIndex = saved ? await decryptBook(encryptedIndex, password) : null;
  const manifest = saved ? JSON.parse(originalIndex) : { books: [seed] };
  if (!Array.isArray(manifest.books) || manifest.books.length === 0) {
    throw new Error('Invalid library');
  }
  const volumes = new Map();
  for (const entry of manifest.books) {
    validateEntry(entry);
    if (volumes.has(entry.id)) throw new Error('Duplicated book');
    const encrypted = await readFile(join(folder, entry.id + '.json'), 'utf-8');
    const serialized = await decryptBook(encrypted, password);
    const book = JSON.parse(serialized);
    requireBookData(book);
    if (entry.chapterIds.length !== book.chapters.length) throw new Error('Missing chapters');
    volumes.set(entry.id, { encrypted, serialized });
  }
  if (!volumes.has(seed.id) || files.length !== volumes.size + Number(saved)) {
    throw new Error('Incomplete library state');
  }
  return { manifest, volumes, originalIndex, encryptedIndex };
}

async function sealVerified(serialized, password) {
  const encrypted = await encryptBook(serialized, password);
  if (await decryptBook(encrypted, password) !== serialized) throw new Error('Verification failed');
  return encrypted;
}

async function addBook(library, sourcePath, password) {
  const source = JSON.parse(await readFile(sourcePath, 'utf-8'));
  const { id, title, chapterIds, chapters, images } = source;
  const entry = { id, title, chapterIds };
  validateEntry(entry);
  const book = { chapters, images };
  requireBookData(book);
  if (chapters.length !== chapterIds.length) throw new Error('Incomplete source book');

  const index = library.manifest.books.findIndex(existing => existing.id === id);
  if (index >= 0) {
    const nextIds = new Set(chapterIds);
    if (!library.manifest.books[index].chapterIds.every(chapter => nextIds.has(chapter))) {
      throw new LibraryError('The source listing is missing previously saved chapters.');
    }
    library.manifest.books[index] = entry;
  } else {
    library.manifest.books.push(entry);
  }

  const serialized = JSON.stringify(book);
  if (library.volumes.get(id)?.serialized !== serialized) {
    const encrypted = await sealVerified(serialized, password);
    library.volumes.set(id, { encrypted, serialized });
  }
}

function syncEndpoint(value) {
  if (!value?.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new LibraryError('Invalid reader sync endpoint.');
  }
  if (
    url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
    url.pathname !== '/sync' || !/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname)
  ) {
    throw new LibraryError('Expected a Cloudflare Workers HTTPS sync endpoint.');
  }
  return url;
}

async function readerHtml(endpoint) {
  const html = await readFile(new URL('../locked-reader/index.html', import.meta.url), 'utf-8');
  if (!endpoint) return html;

  const marker = '<meta name="reader-sync-endpoint" content="">';
  const connectionPolicy = "connect-src 'self' https://api.github.com";
  if (!html.includes(marker) || !html.includes(connectionPolicy)) {
    throw new LibraryError('Missing sync configuration in the reader template.');
  }
  return html
    .replace(marker, '<meta name="reader-sync-endpoint" content="' + endpoint.href + '">')
    .replace(connectionPolicy, "connect-src 'self' " + endpoint.origin);
}

async function writeRelease(site, volumes, encryptedIndex, html) {
  const books = join(site, 'library');
  await mkdir(site);
  await mkdir(books);
  await writeFile(join(site, 'index.html'), html, 'utf-8');
  for (const file of readerScripts) {
    await copyFile(new URL('../locked-reader/' + file, import.meta.url), join(site, file));
  }
  for (const [id, volume] of volumes) {
    await writeFile(join(books, id + '.json'), volume.encrypted, 'utf-8');
  }
  await writeFile(join(books, manifestName), encryptedIndex, 'utf-8');
  await copyFile(join(books, seed.id + '.json'), join(site, 'book.json'));
  const alias = join(site, 'locked');
  await mkdir(alias);
  await writeFile(join(alias, 'index.html'), [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="refresh" content="0; url=../">',
    '<title>我的在线阅读器</title>',
    '<a href="../">进入阅读器</a>',
    '</html>',
  ].join('\n'), 'utf-8');
}

async function main() {
  const [folder, site, sourcePath] = process.argv.slice(2);
  const password = process.env.READER_PASSWORD;
  if (!folder || !site || !password?.trim()) throw new LibraryError('Missing library input or password.');

  const html = await readerHtml(syncEndpoint(process.env.READER_SYNC_ENDPOINT));
  const library = await readLibrary(folder, password);
  if (sourcePath) await addBook(library, sourcePath, password);
  const index = JSON.stringify(library.manifest);
  const encryptedIndex = index === library.originalIndex
    ? library.encryptedIndex
    : await sealVerified(index, password);
  await writeRelease(site, library.volumes, encryptedIndex, html);

  for (const [id, book] of library.volumes) {
    await writeFile(join(folder, id + '.json'), book.encrypted, 'utf-8');
  }
  await writeFile(join(folder, manifestName), encryptedIndex, 'utf-8');
  const count = library.manifest.books.reduce((sum, entry) => sum + entry.chapterIds.length, 0);
  console.log('Encrypted library verified: ' + library.volumes.size + ' books, ' + count + ' chapters.');
}

main().catch(error => {
  console.error(error instanceof LibraryError ? error.message : 'Could not verify the encrypted library.');
  process.exitCode = 1;
});

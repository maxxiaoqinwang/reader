import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptBook, requireBookData } from './book-package.mjs';

async function verify(source, site, password) {
  const entries = (await readdir(site)).sort();
  const expected = ['book.json', 'crypto.js', 'index.html', 'reader.js'];
  if (entries.join('\n') !== expected.join('\n')) throw new Error();

  const contents = await decryptBook(await readFile(join(site, 'book.json'), 'utf-8'), password);
  const input = JSON.parse(await readFile(source, 'utf-8'));
  if (contents !== JSON.stringify(input)) {
    throw new Error();
  }

  requireBookData(input);
  const { chapters, images } = input;
  console.log('Encrypted release verified: ' + chapters.length + ' chapters, ' + images.length + ' images.');
}

verify(process.argv[2], process.argv[3], process.env.READER_PASSWORD).catch(() => {
  console.error('Encrypted release verification failed.');
  process.exitCode = 1;
});

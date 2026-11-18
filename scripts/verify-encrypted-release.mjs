import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deriveReaderKey } from '../locked-reader/crypto.js';

async function verify(source, site, password) {
  const entries = (await readdir(site)).sort();
  const expected = ['book.json', 'crypto.js', 'index.html', 'reader.js'];
  if (entries.join('\n') !== expected.join('\n')) throw new Error();

  const book = JSON.parse(await readFile(join(site, 'book.json'), 'utf-8'));
  if (book.version !== 1) throw new Error();
  const salt = Buffer.from(book.salt, 'base64');
  const iv = Buffer.from(book.iv, 'base64');
  const key = await deriveReaderKey(password, salt, 'decrypt');
  const contents = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, key, Buffer.from(book.ciphertext, 'base64'),
  );

  const input = JSON.parse(await readFile(source, 'utf-8'));
  if (!Buffer.from(contents).equals(Buffer.from(JSON.stringify(input)))) {
    throw new Error();
  }

  const { chapters, images } = input;
  const validChapters = Array.isArray(chapters) && chapters.length > 0 && chapters.every(
    chapter => typeof chapter.title === 'string' && chapter.title.trim() &&
      Array.isArray(chapter.paragraphs) && chapter.paragraphs.length > 0 && chapter.paragraphs.every(
        paragraph => Array.isArray(paragraph) && paragraph.length > 0 && paragraph.every(
          part => typeof part === 'string' ||
            (Number.isInteger(part?.image) && part.image >= 0 && part.image < images.length),
        ),
      ),
  );
  const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
  if (!Array.isArray(images) || !validChapters || !images.every(
    image => typeof image === 'string' &&
      Buffer.from(image, 'base64').subarray(0, 8).equals(pngSignature),
  )) {
    throw new Error();
  }
  console.log('Encrypted release verified: ' + chapters.length + ' chapters, ' + images.length + ' images.');
}

verify(process.argv[2], process.argv[3], process.env.READER_PASSWORD).catch(() => {
  console.error('Encrypted release verification failed.');
  process.exitCode = 1;
});

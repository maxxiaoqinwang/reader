import { deriveReaderKey } from '../locked-reader/crypto.js';

export async function encryptBook(serialized, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveReaderKey(password, salt, 'encrypt');
  const plaintext = new TextEncoder().encode(serialized);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  return JSON.stringify({
    version: 1,
    salt: Buffer.from(salt).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    ciphertext: Buffer.from(ciphertext).toString('base64'),
  });
}

export async function decryptBook(serialized, password) {
  const book = JSON.parse(serialized);
  if (book.version !== 1) throw new Error('Unknown encrypted format');
  const salt = Buffer.from(book.salt, 'base64');
  const iv = Buffer.from(book.iv, 'base64');
  const key = await deriveReaderKey(password, salt, 'decrypt');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, key, Buffer.from(book.ciphertext, 'base64'),
  );
  return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
}

export function requireBookData(book) {
  const { chapters, images } = book;
  const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
  if (!Array.isArray(images) || !images.every(
    image => typeof image === 'string' &&
      Buffer.from(image, 'base64').subarray(0, 8).equals(pngSignature),
  )) {
    throw new Error('Invalid image data');
  }

  if (!Array.isArray(chapters) || chapters.length === 0 || !chapters.every(
    chapter => typeof chapter?.title === 'string' && chapter.title.trim() &&
      Array.isArray(chapter.paragraphs) && chapter.paragraphs.length > 0 &&
      chapter.paragraphs.every(paragraph => Array.isArray(paragraph) &&
        paragraph.length > 0 && paragraph.every(part => typeof part === 'string' ||
          (Number.isInteger(part?.image) && part.image >= 0 && part.image < images.length))),
  )) {
    throw new Error('Invalid chapter data');
  }
}

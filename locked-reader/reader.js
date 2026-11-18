import { deriveReaderKey } from './crypto.js';

const unlockForm = document.querySelector('#unlock-form');
const passwordInput = document.querySelector('#reader-password');
const unlockButton = document.querySelector('#unlock');
const unlockStatus = document.querySelector('#unlock-status');
const readerContent = document.querySelector('#reader-content');
const chapterSelect = document.querySelector('#chapter-select');
const chapterTitle = document.querySelector('#chapter-title');
const chapterBody = document.querySelector('#chapter-body');
const lockButton = document.querySelector('#lock');

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const chapterImageUrls = new Map();
let book = null;

function decodeBase64(value) {
  if (typeof value !== 'string') {
    throw new TypeError('Invalid encrypted book');
  }
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function parseBook(value) {
  const chapters = Array.isArray(value)
    ? value.map((chapter) => ({ title: chapter?.title, paragraphs: [[chapter?.body]] }))
    : value?.chapters;
  const images = Array.isArray(value) ? [] : value?.images;
  if (!Array.isArray(chapters) || chapters.length === 0 || !Array.isArray(images)) {
    throw new Error('Invalid book format');
  }

  const isPart = (part) => typeof part === 'string' ||
    (Number.isInteger(part?.image) && part.image >= 0 && part.image < images.length);
  for (const chapter of chapters) {
    if (
      typeof chapter?.title !== 'string' ||
      !Array.isArray(chapter.paragraphs) ||
      chapter.paragraphs.length === 0 ||
      !chapter.paragraphs.every((paragraph) =>
        Array.isArray(paragraph) && paragraph.length > 0 && paragraph.every(isPart))
    ) {
      throw new Error('Invalid chapter format');
    }
  }

  const pngs = images.map((image) => {
    const bytes = decodeBase64(image);
    if (!pngSignature.every((byte, index) => bytes[index] === byte)) {
      throw new Error('Invalid chapter image');
    }
    return new Blob([bytes], { type: 'image/png' });
  });
  return { chapters, images: pngs };
}

function clearChapter() {
  chapterBody.replaceChildren();
  for (const url of chapterImageUrls.values()) {
    URL.revokeObjectURL(url);
  }
  chapterImageUrls.clear();
}

function inlineImage(index) {
  if (!chapterImageUrls.has(index)) {
    chapterImageUrls.set(index, URL.createObjectURL(book.images[index]));
  }
  const image = document.createElement('img');
  image.alt = '';
  image.src = chapterImageUrls.get(index);
  return image;
}

function showChapter() {
  const chapter = book?.chapters[chapterSelect.selectedIndex];
  if (!chapter) {
    return;
  }
  clearChapter();
  chapterTitle.textContent = chapter.title;

  const fragment = document.createDocumentFragment();
  for (const parts of chapter.paragraphs) {
    const paragraph = document.createElement('p');
    for (const part of parts) {
      paragraph.append(typeof part === 'string' ? part : inlineImage(part.image));
    }
    fragment.append(paragraph);
  }
  chapterBody.append(fragment);
}

function lockReader() {
  book = null;
  chapterSelect.replaceChildren();
  chapterTitle.textContent = '';
  clearChapter();
  readerContent.hidden = true;
  lockButton.hidden = true;
  unlockForm.reset();
  unlockForm.hidden = false;
  unlockStatus.textContent = '';
  passwordInput.focus();
}

unlockForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (unlockButton.disabled) {
    return;
  }

  if (!globalThis.crypto?.subtle) {
    unlockStatus.textContent = '请使用支持加密的浏览器打开。';
    return;
  }

  const password = passwordInput.value;
  passwordInput.value = '';
  passwordInput.disabled = true;
  unlockButton.disabled = true;
  unlockStatus.textContent = '正在解锁…';

  try {
    const response = await fetch('./book.json', { cache: 'no-store', redirect: 'error' });
    if (!response.ok) {
      throw new Error('Encrypted book unavailable');
    }

    const envelope = await response.json();
    if (envelope?.version !== 1) {
      throw new Error('Unsupported encrypted book');
    }

    const salt = decodeBase64(envelope.salt);
    const iv = decodeBase64(envelope.iv);
    const ciphertext = decodeBase64(envelope.ciphertext);
    const key = await deriveReaderKey(password, salt, 'decrypt');
    let cleartext;
    try {
      cleartext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    } catch (error) {
      if (error.name === 'OperationError') {
        unlockStatus.textContent = '口令不正确，或内容已损坏。';
        return;
      }
      throw error;
    }

    book = parseBook(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(cleartext)));
    for (const chapter of book.chapters) {
      const option = document.createElement('option');
      option.textContent = chapter.title;
      chapterSelect.append(option);
    }
    showChapter();
    unlockStatus.textContent = '';
    unlockForm.hidden = true;
    readerContent.hidden = false;
    lockButton.hidden = false;
    chapterSelect.focus();
  } catch {
    lockReader();
    unlockStatus.textContent = '暂时无法读取，请稍后重试。';
  } finally {
    passwordInput.disabled = false;
    unlockButton.disabled = false;
    if (!unlockForm.hidden) {
      passwordInput.focus();
    }
  }
});

chapterSelect.addEventListener('change', showChapter);
lockButton.addEventListener('click', lockReader);

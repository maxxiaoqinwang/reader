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

let chapters = [];

function decodeBase64(value) {
  if (typeof value !== 'string') {
    throw new TypeError('Invalid encrypted book');
  }
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function showChapter() {
  const chapter = chapters[chapterSelect.selectedIndex];
  chapterTitle.textContent = chapter.title;
  chapterBody.textContent = chapter.body;
}

function lockReader() {
  chapters = [];
  chapterSelect.replaceChildren();
  chapterTitle.textContent = '';
  chapterBody.textContent = '';
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

    const book = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(cleartext));
    if (
      !Array.isArray(book) ||
      book.length === 0 ||
      !book.every((chapter) => typeof chapter?.title === 'string' && typeof chapter.body === 'string')
    ) {
      throw new Error('Invalid book format');
    }

    chapters = book;
    for (const chapter of chapters) {
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

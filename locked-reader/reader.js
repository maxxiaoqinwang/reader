import { deriveReaderKey } from './crypto.js';

const themeButton = document.querySelector('#theme-toggle');
const unlockForm = document.querySelector('#unlock-form');
const passwordInput = document.querySelector('#reader-password');
const unlockButton = document.querySelector('#unlock');
const unlockStatus = document.querySelector('#unlock-status');
const readerContent = document.querySelector('#reader-content');
const bookControls = document.querySelector('#book-controls');
const bookSelect = document.querySelector('#book-select');
const refreshButton = document.querySelector('#refresh-library');
const readerStatus = document.querySelector('#reader-status');
const chapterControls = document.querySelector('#chapter-controls');
const chapterSelect = document.querySelector('#chapter-select');
const chapterTitle = document.querySelector('#chapter-title');
const chapterBody = document.querySelector('#chapter-body');
const chapterNavigation = document.querySelector('#chapter-navigation');
const chapterMenu = document.querySelector('#chapter-menu');
const chapterCorner = document.querySelector('#chapter-corner');
const previousChapter = document.querySelector('#chapter-prev');
const nextChapter = document.querySelector('#chapter-next');
const lockButton = document.querySelector('#lock');
const syncTools = document.querySelector('#sync-tools');
const syncForm = document.querySelector('#sync-form');
const bookUrlInput = document.querySelector('#book-url');
const githubTokenFields = document.querySelector('#github-token-fields');
const githubTokenInput = document.querySelector('#github-token');
const syncButton = document.querySelector('#sync-submit');
const syncStatus = document.querySelector('#sync-status');

const positiveId = /^[1-9]\d*$/;
const sourceBookUrl = /^https:\/\/(?:www\.)?lizhiks\.com\/book\/([1-9]\d*)\.html$/;
const dispatchUrl = 'https://api.github.com/repos/maxxiaoqinwang/reader/actions/workflows/reader-pages.yml/dispatches';
const syncEndpoint = readSyncEndpoint();
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const chapterImageUrls = new Map();
const colorPreference = matchMedia('(prefers-color-scheme: dark)');
const themeKey = 'reader-color-theme';
const chapterCornerKey = 'reader-chapter-corner';
let chosenTheme = readPreference(themeKey, ['light', 'dark']);
let book = null;
let passphrase = null;
let loadRequest = null;
let syncRequest = null;

if (syncEndpoint) {
  githubTokenFields.hidden = true;
  githubTokenInput.disabled = true;
  githubTokenInput.required = false;
}

function readPreference(key, choices) {
  try {
    const stored = localStorage.getItem(key);
    return choices.includes(stored) ? stored : null;
  } catch {
    return null;
  }
}

function savePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The choice stays active on this page when storage is unavailable.
  }
}

function applyTheme() {
  const theme = chosenTheme ?? (colorPreference.matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = theme === 'dark' ? '切换浅色' : '切换深色';
}

function applyChapterCorner(side) {
  chapterNavigation.dataset.corner = side;
  chapterCorner.textContent = side === 'left' ? '移到右下角' : '移到左下角';
}

function readSyncEndpoint() {
  const value = document.querySelector('meta[name="reader-sync-endpoint"]')?.content.trim();
  if (!value) {
    return null;
  }
  try {
    const endpoint = new URL(value);
    if (
      endpoint.protocol === 'https:' && endpoint.pathname === '/sync' &&
      !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
    ) {
      return endpoint.href;
    }
  } catch {
    // A missing or invalid endpoint leaves the existing GitHub token flow available.
  }
  return null;
}

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

async function decryptResponse(response, password) {
  if (!response.ok) {
    throw new Error('Encrypted content unavailable');
  }
  const envelope = await response.json();
  if (envelope?.version !== 1) {
    throw new Error('Unsupported encrypted content');
  }
  const salt = decodeBase64(envelope.salt);
  const iv = decodeBase64(envelope.iv);
  const ciphertext = decodeBase64(envelope.ciphertext);
  const key = await deriveReaderKey(password, salt, 'decrypt');
  const cleartext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(cleartext));
}

function startLoad() {
  loadRequest?.abort();
  loadRequest = new AbortController();
  return loadRequest;
}

function fetchContent(path, request) {
  return fetch(path, { cache: 'no-store', redirect: 'error', signal: request.signal });
}

async function loadLibrary(password, request) {
  const response = await fetchContent('./library/index.json', request);
  if (response.status === 404) {
    const legacy = await fetchContent('./book.json', request);
    return { books: [], legacy: parseBook(await decryptResponse(legacy, password)) };
  }
  const catalog = await decryptResponse(response, password);
  const books = catalog?.books;
  if (!Array.isArray(books) || !books.every(({ id, title } = {}) =>
    typeof id === 'string' && positiveId.test(id) && typeof title === 'string'
  ) || new Set(books.map(({ id }) => id)).size !== books.length) {
    throw new Error('Invalid library');
  }
  return { books, legacy: null };
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
  const index = chapterSelect.selectedIndex;
  const chapter = book?.chapters[index];
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
  previousChapter.disabled = index === 0;
  nextChapter.disabled = index === book.chapters.length - 1;
  chapterMenu.setAttribute('aria-expanded', 'false');
}

function turnChapter(direction) {
  const index = chapterSelect.selectedIndex + direction;
  if (!book?.chapters[index]) {
    return;
  }
  chapterSelect.selectedIndex = index;
  showChapter();
  chapterTitle.focus({ preventScroll: true });
  chapterTitle.scrollIntoView({ block: 'start' });
}

function clearBook() {
  book = null;
  chapterSelect.replaceChildren();
  chapterTitle.textContent = '';
  clearChapter();
  chapterMenu.setAttribute('aria-expanded', 'false');
  chapterControls.hidden = true;
}

function showBook(value) {
  book = value;
  chapterSelect.replaceChildren(...book.chapters.map(({ title }) => new Option(title)));
  chapterControls.hidden = false;
  showChapter();
}

function showLibrary({ books, legacy }) {
  clearBook();
  bookControls.hidden = legacy !== null;
  bookSelect.replaceChildren(
    new Option('请选择书籍', ''),
    ...books.map(({ title, id }) => new Option(title, id)),
  );
  readerStatus.textContent = books.length === 0 && !legacy ? '书单为空，可先添加书籍。' : '';
  if (legacy) {
    showBook(legacy);
  }
}

function lockReader() {
  passphrase = null;
  loadRequest?.abort();
  loadRequest = null;
  syncRequest?.abort();
  syncRequest = null;
  clearBook();
  bookSelect.replaceChildren();
  readerStatus.textContent = '';
  syncTools.open = false;
  syncForm.reset();
  syncButton.disabled = false;
  syncStatus.replaceChildren();
  readerContent.hidden = true;
  lockButton.hidden = true;
  unlockForm.reset();
  unlockForm.hidden = false;
  unlockStatus.textContent = '';
  passwordInput.focus();
}

async function loadSelectedBook() {
  const password = passphrase;
  if (password === null) {
    return;
  }
  const request = startLoad();
  const id = bookSelect.value;
  clearBook();
  readerStatus.textContent = '';
  if (!positiveId.test(id)) {
    loadRequest = null;
    return;
  }
  readerStatus.textContent = '正在加载书籍…';
  try {
    const response = await fetchContent('./library/' + id + '.json', request);
    const selected = parseBook(await decryptResponse(response, password));
    if (loadRequest === request) {
      showBook(selected);
      readerStatus.textContent = '';
    }
  } catch {
    if (loadRequest === request) {
      bookSelect.value = '';
      readerStatus.textContent = '这本书暂时无法读取，请重选或刷新书单。';
    }
  } finally {
    if (loadRequest === request) {
      loadRequest = null;
    }
  }
}

async function refreshLibrary() {
  const password = passphrase;
  if (password === null) {
    return;
  }
  const request = startLoad();
  const selectedId = bookSelect.value;
  readerStatus.textContent = '正在刷新书单…';
  try {
    const catalog = await loadLibrary(password, request);
    if (loadRequest === request) {
      showLibrary(catalog);
      if (catalog.books.some(({ id }) => id === selectedId)) {
        bookSelect.value = selectedId;
        void loadSelectedBook();
      }
    }
  } catch {
    if (loadRequest === request) {
      if (!book) {
        bookSelect.value = '';
      }
      readerStatus.textContent = '书单暂时无法刷新，请稍后再试。';
    }
  } finally {
    if (loadRequest === request) {
      loadRequest = null;
    }
  }
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

  const request = startLoad();
  try {
    const catalog = await loadLibrary(password, request);
    if (loadRequest !== request) {
      return;
    }
    showLibrary(catalog);
    passphrase = password;
    unlockStatus.textContent = '';
    unlockForm.hidden = true;
    readerContent.hidden = false;
    lockButton.hidden = false;
    (catalog.legacy ? chapterSelect : bookSelect).focus();
  } catch (error) {
    if (loadRequest === request) {
      lockReader();
      unlockStatus.textContent = error.name === 'OperationError'
        ? '口令不正确，或内容已损坏。'
        : '暂时无法读取，请稍后重试。';
    }
  } finally {
    if (loadRequest === request) {
      loadRequest = null;
    }
    passwordInput.disabled = false;
    unlockButton.disabled = false;
    if (!unlockForm.hidden) {
      passwordInput.focus();
    }
  }
});

syncForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (passphrase === null || syncRequest) {
    return;
  }
  const match = sourceBookUrl.exec(bookUrlInput.value.trim());
  if (!match) {
    syncStatus.textContent = '请输入荔枝小说的 HTTPS 书籍页链接。';
    return;
  }
  const bookUrl = 'https://www.lizhiks.com/book/' + match[1] + '.html';
  const headers = { 'Content-Type': 'application/json' };
  let body;
  if (syncEndpoint) {
    body = { password: passphrase, book_url: bookUrl };
  } else {
    const token = githubTokenInput.value.trim();
    if (!/^github_pat_[A-Za-z0-9_]+$/.test(token)) {
      syncStatus.textContent = '请输入以 github_pat_ 开头的细粒度令牌。';
      return;
    }
    githubTokenInput.value = '';
    headers.Accept = 'application/vnd.github+json';
    headers.Authorization = 'Bearer ' + token;
    headers['X-GitHub-Api-Version'] = '2026-03-10';
    body = { ref: 'main', inputs: { book_url: bookUrl, deploy: true } };
  }
  const request = new AbortController();
  syncRequest = request;
  syncButton.disabled = true;
  syncStatus.textContent = '正在提交同步请求…';
  try {
    const result = await fetch(syncEndpoint ?? dispatchUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: request.signal,
    });
    if (syncRequest !== request) {
      return;
    }
    if (!result.ok) {
      if (!syncEndpoint) {
        syncStatus.textContent = 'GitHub 未接受同步请求（HTTP ' + result.status + '），请检查令牌权限。';
      } else if (result.status === 401) {
        syncStatus.textContent = '同步服务未接受当前阅读口令。';
      } else if (result.status === 429) {
        syncStatus.textContent = '同步请求过多，请稍后再试。';
      } else {
        syncStatus.textContent = '同步服务未接受请求（HTTP ' + result.status + '）。';
      }
      return;
    }
    const data = await result.json().catch(() => null);
    if (syncRequest !== request) {
      return;
    }
    syncStatus.textContent = '已提交同步请求。发布完成后，请刷新书单。';
    if (Number.isSafeInteger(data?.workflow_run_id) && data.workflow_run_id > 0) {
      const link = document.createElement('a');
      link.href = 'https://github.com/maxxiaoqinwang/reader/actions/runs/' + data.workflow_run_id;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '查看运行进度';
      syncStatus.append(' ', link);
    }
  } catch {
    if (syncRequest === request) {
      syncStatus.textContent = syncEndpoint
        ? '暂时无法连接同步服务，请稍后再试。'
        : '暂时无法连接 GitHub，请稍后再试。';
    }
  } finally {
    if (syncRequest === request) {
      syncRequest = null;
      syncButton.disabled = false;
    }
  }
});

bookSelect.addEventListener('change', loadSelectedBook);
refreshButton.addEventListener('click', refreshLibrary);
chapterSelect.addEventListener('change', showChapter);
chapterMenu.addEventListener('click', () => {
  const open = chapterMenu.getAttribute('aria-expanded') === 'true';
  chapterMenu.setAttribute('aria-expanded', String(!open));
});
chapterCorner.addEventListener('click', () => {
  const side = chapterNavigation.dataset.corner === 'left' ? 'right' : 'left';
  applyChapterCorner(side);
  savePreference(chapterCornerKey, side);
});
chapterNavigation.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && chapterMenu.getAttribute('aria-expanded') === 'true') {
    chapterMenu.setAttribute('aria-expanded', 'false');
    chapterMenu.focus();
  }
});
previousChapter.addEventListener('click', () => turnChapter(-1));
nextChapter.addEventListener('click', () => turnChapter(1));
lockButton.addEventListener('click', lockReader);

themeButton.addEventListener('click', () => {
  chosenTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  savePreference(themeKey, chosenTheme);
  applyTheme();
});
if (colorPreference.addEventListener) {
  colorPreference.addEventListener('change', applyTheme);
} else {
  colorPreference.addListener(applyTheme);
}
applyTheme();
applyChapterCorner(readPreference(chapterCornerKey, ['left', 'right']) ?? 'right');

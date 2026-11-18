import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { deriveReaderKey } from './locked-reader/crypto.js';

const assets = ['index.html', 'reader.js', 'crypto.js'];
const bookFile = 'book.json';

async function readChapters(inputDir) {
  const entries = await readdir(inputDir, { withFileTypes: true });
  const files = entries
    .filter(entry => entry.isFile() && /\.txt$/i.test(entry.name))
    .map(entry => entry.name)
    .sort();
  if (files.length === 0) throw new Error('章节目录中没有 TXT 文件。');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chapters = [];
  for (const name of files) {
    const bytes = await readFile(join(inputDir, name));
    let body;
    try {
      body = decoder.decode(bytes);
    } catch {
      throw new Error(`章节文件须使用 UTF-8 编码：${name}`);
    }
    if (!body.trim()) throw new Error(`章节内容为空：${name}`);
    chapters.push({ title: name.slice(0, -4), body });
  }
  return chapters;
}

async function encryptChapters(chapters, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveReaderKey(password, salt, 'encrypt');
  const plaintext = new TextEncoder().encode(JSON.stringify(chapters));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  return JSON.stringify({
    version: 1,
    salt: Buffer.from(salt).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    ciphertext: Buffer.from(ciphertext).toString('base64'),
  });
}

async function writeSite(output, encryptedBook) {
  try {
    await lstat(output);
    throw new Error(`输出目录已存在，请指定新目录：${output}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, `.${basename(output)}-`));

  try {
    for (const asset of assets) {
      await copyFile(new URL(`./locked-reader/${asset}`, import.meta.url), join(staging, asset));
    }
    await writeFile(join(staging, bookFile), encryptedBook, 'utf-8');
    await rename(staging, output);
  } catch (error) {
    await Promise.allSettled([...assets, bookFile].map(name => unlink(join(staging, name))));
    await rmdir(staging).catch(() => {});
    throw error;
  }
}

async function main() {
  const [inputDir, outputDir] = process.argv.slice(2);
  if (!inputDir || !outputDir) {
    throw new Error('用法：node build_locked_reader.mjs <UTF-8 TXT 章节目录> <新输出目录>');
  }
  const password = process.env.READER_PASSWORD;
  if (!password || !password.trim()) throw new Error('请通过 READER_PASSWORD 提供阅读密码。');

  const chapters = await readChapters(inputDir);
  await writeSite(resolve(outputDir), await encryptChapters(chapters, password));
  console.log(`已生成 ${chapters.length} 章的加密阅读页面。`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

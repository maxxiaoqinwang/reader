import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { encryptBook } from './scripts/book-package.mjs';

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
    let body;
    try {
      body = decoder.decode(await readFile(join(inputDir, name)));
    } catch {
      throw new Error('无法读取 UTF-8 章节文件。');
    }
    if (!body.trim()) throw new Error('发现空白章节文件。');
    chapters.push({ title: name.slice(0, -4), body });
  }
  return chapters;
}

async function readBook(input) {
  const entry = await lstat(input);
  if (entry.isDirectory()) return JSON.stringify(await readChapters(input));

  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const book = JSON.parse(decoder.decode(await readFile(input)));
    if (!Array.isArray(book?.chapters) || !Array.isArray(book.images)) throw new Error();
    return JSON.stringify(book);
  } catch {
    throw new Error('无法读取章节内容包。');
  }
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
  const [input, outputDir] = process.argv.slice(2);
  if (!input || !outputDir) {
    throw new Error('用法：node build_locked_reader.mjs <UTF-8 TXT 章节目录或 JSON 内容包> <新输出目录>');
  }
  const password = process.env.READER_PASSWORD;
  if (!password || !password.trim()) throw new Error('请通过 READER_PASSWORD 提供阅读密码。');

  const book = await readBook(input);
  await writeSite(resolve(outputDir), await encryptBook(book, password));
  console.log('已生成加密阅读页面。');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

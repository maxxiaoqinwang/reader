import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit

ORIGIN = "https://www.lizhiks.com"
HOST = "www.lizhiks.com"
DEFAULT_BOOK_ID = "229314"
CATALOG_URL = f"{ORIGIN}/book/{DEFAULT_BOOK_ID}.html"
CHAPTER_ROOT = f"{ORIGIN}/read/{DEFAULT_BOOK_ID}/"
BOOK_URL = re.compile(r"https://(?:www\.)?lizhiks\.com/book/([1-9][0-9]*)\.html")
CHAPTER_PATH = re.compile(r"/read/([1-9][0-9]*)/([1-9][0-9]*)\.html")
PNG_PATH = re.compile(r"/asset/fonts/[0-9]+\.png")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
HTML_LIMIT = 2 * 1024 * 1024
PNG_LIMIT = 256 * 1024
TOTAL_LIMIT = 32 * 1024 * 1024
REQUEST_GAP = 1.5
RETRY_DELAYS = (3, 6)
TRANSIENT_ERRORS = frozenset(("request timed out", "HTTP 500", "HTTP 502", "HTTP 503", "HTTP 504"))
FETCH_HELPER = Path(__file__).with_name("fetch-upstream.mjs")
CHECKPOINT_HELPER = Path(__file__).with_name("sync-checkpoint.mjs")
VOID_TAGS = frozenset(
    "area base br col embed hr img input link meta param source track wbr".split()
)
HTML_SPACE = re.compile(r"[\t\n\f\r ]+")


class SyncError(Exception):
    pass


class SyncUnavailable(SyncError):
    pass


class SyncTimeout(SyncUnavailable):
    pass


def normalize_book_url(value):
    match = BOOK_URL.fullmatch(value)
    if not match:
        raise SyncError("book URL: expected an HTTPS lizhiks.com book page")
    book_id = match[1]
    return book_id, f"{ORIGIN}/book/{book_id}.html"


def source_url(value, base):
    try:
        url = urlsplit(urljoin(base, value))
    except ValueError:
        return None
    if url.scheme == "https" and url.netloc.lower() == HOST:
        return url
    return None


class CatalogParser(HTMLParser):
    def __init__(self, book_id):
        super().__init__()
        self.book_id = book_id
        self.url = f"{ORIGIN}/book/{book_id}.html"
        self.chapter_ids = set()
        self.title_metadata = {}
        self.heading_parts = []
        self.found_heading = False
        self.in_heading = False
        self.ignored_tag = None

    def handle_starttag(self, tag, attrs):
        if self.ignored_tag:
            return
        if tag in ("script", "style"):
            self.ignored_tag = tag
            return
        if tag == "h1" and not self.found_heading:
            self.found_heading = self.in_heading = True
        elif tag == "meta":
            attributes = dict(attrs)
            name = (attributes.get("property") or attributes.get("name") or "").lower()
            if name in ("og:novel:book_name", "og:novel:title", "og:title"):
                title = HTML_SPACE.sub(" ", attributes.get("content") or "").strip()
                if title:
                    self.title_metadata.setdefault(name, title)
        elif tag == "a":
            url = source_url(dict(attrs).get("href") or "", self.url)
            match = CHAPTER_PATH.fullmatch(url.path) if url else None
            if match and match[1] == self.book_id:
                self.chapter_ids.add(int(match[2]))

    def handle_endtag(self, tag):
        if self.ignored_tag:
            if tag == self.ignored_tag:
                self.ignored_tag = None
            return
        if tag == "h1":
            self.in_heading = False

    def handle_data(self, text):
        if self.in_heading and not self.ignored_tag:
            self.heading_parts.append(text)

    def book_title(self):
        heading = HTML_SPACE.sub(" ", "".join(self.heading_parts)).strip()
        return (
            self.title_metadata.get("og:novel:book_name")
            or self.title_metadata.get("og:novel:title")
            or heading
            or self.title_metadata.get("og:title")
        )


def read_catalog(html, book_id):
    parser = CatalogParser(str(book_id))
    parser.feed(html)
    parser.close()
    return parser


def parse_catalog(html, book_id=DEFAULT_BOOK_ID):
    return sorted(read_catalog(html, book_id).chapter_ids)


class ChapterParser(HTMLParser):
    def __init__(self, chapter_root):
        super().__init__()
        self.chapter_root = chapter_root
        self.title_parts = []
        self.paragraphs = []
        self.paragraph = None
        self.in_title = False
        self.found_title = False
        self.found_content = False
        self.ignored_tag = None
        self.content_stack = []

    def handle_starttag(self, tag, attrs):
        if self.ignored_tag:
            return
        if tag in ("script", "style"):
            self.ignored_tag = tag
            return
        if tag == "h1" and not self.found_title:
            self.found_title = self.in_title = True

        attributes = dict(attrs)
        if not self.content_stack:
            if not self.found_content and attributes.get("id") == "chapter-content":
                self.found_content = True
                self.content_stack.append(tag)
            return

        if tag == "p" and len(self.content_stack) == 2 and self.content_stack[-1] == "p":
            self.handle_endtag("p")
        if tag == "p" and len(self.content_stack) == 1:
            self.paragraph = []
        if self.paragraph is not None:
            if tag == "br":
                self.append_text("\n")
            elif tag == "img":
                url = source_url(attributes.get("src") or "", self.chapter_root)
                if not url or not PNG_PATH.fullmatch(url.path) or url.query:
                    raise ValueError("Invalid chapter image")
                self.paragraph.append({"image": f"{ORIGIN}{url.path}"})

        if tag not in VOID_TAGS:
            self.content_stack.append(tag)

    def handle_endtag(self, tag):
        if self.ignored_tag:
            if tag == self.ignored_tag:
                self.ignored_tag = None
            return
        if tag == "h1":
            self.in_title = False
        if tag not in self.content_stack:
            return

        while self.content_stack:
            closed = self.content_stack.pop()
            if closed == "p" and self.paragraph is not None:
                self.finish_paragraph()
            if closed == tag:
                break

    def handle_data(self, text):
        if self.ignored_tag:
            return
        if self.in_title:
            self.title_parts.append(text)
        if self.paragraph is not None:
            self.append_text(HTML_SPACE.sub(" ", text))

    def append_text(self, text):
        if self.paragraph and isinstance(self.paragraph[-1], str):
            self.paragraph[-1] += text
        else:
            self.paragraph.append(text)

    def finish_paragraph(self):
        parts = [
            re.sub(r" *\n *", "\n", part) if isinstance(part, str) else part
            for part in self.paragraph
        ]
        if parts and isinstance(parts[0], str):
            parts[0] = parts[0].lstrip(" \n")
        if parts and isinstance(parts[-1], str):
            parts[-1] = parts[-1].rstrip(" \n")
        if parts := [part for part in parts if part]:
            self.paragraphs.append(parts)
        self.paragraph = None


def parse_chapter(html, chapter_root=CHAPTER_ROOT):
    parser = ChapterParser(chapter_root)
    parser.feed(html)
    parser.close()
    title = HTML_SPACE.sub(" ", "".join(parser.title_parts)).strip()
    if not title or not parser.paragraphs or parser.content_stack:
        raise ValueError("Invalid chapter structure")
    return title, parser.paragraphs


class Upstream:
    def __init__(self):
        self.started = False
        self.bytes_read = 0
        self.environment = os.environ.copy()
        self.environment.pop("READER_PASSWORD", None)

    def measure(self, body, limit, label):
        self.bytes_read += len(body)
        if not body or len(body) > limit or self.bytes_read > TOTAL_LIMIT:
            raise SyncError(f"{label}: empty or oversized response")
        return body

    def fetch(self, url, media_type, limit, label):
        if self.started:
            time.sleep(REQUEST_GAP)
        self.started = True

        for attempt in range(len(RETRY_DELAYS) + 1):
            timeout_seconds = 20 if media_type == "text/html" and attempt == len(RETRY_DELAYS) else 10
            try:
                response = subprocess.run(
                    ["node", "--use-system-ca", str(FETCH_HELPER), url, media_type, str(limit),
                     str(timeout_seconds * 1000)],
                    capture_output=True, timeout=timeout_seconds + 5, check=False, env=self.environment,
                )
            except subprocess.TimeoutExpired:
                message = "request timed out"
            except OSError:
                raise SyncError(f"{label}: request failed") from None
            else:
                if response.returncode == 0:
                    break
                message = response.stderr.decode("ascii", errors="ignore").strip()

            if message not in TRANSIENT_ERRORS or attempt == len(RETRY_DELAYS):
                if not re.fullmatch(
                    r"HTTP \d{3}(?: \(retry (?:after \d+ seconds|later)\))?|"
                    r"(?:unexpected content type|oversized response|empty response|request failed|request timed out|upstream challenge)",
                    message,
                ):
                    message = "request failed"
                failure = SyncError
                if message == "request timed out":
                    failure = SyncTimeout
                elif message in TRANSIENT_ERRORS:
                    failure = SyncUnavailable
                raise failure(f"{label}: {message}")
            delay = RETRY_DELAYS[attempt]
            print(f"{label}: {message}, retrying in {delay} seconds", flush=True)
            time.sleep(delay)

        return self.measure(response.stdout, limit, label)


class Checkpoint:
    def __init__(self, directory, book_id):
        self.directory = directory
        self.book_id = book_id

    def run(self, action, url, media_type, limit, body=None):
        try:
            response = subprocess.run(
                ["node", str(CHECKPOINT_HELPER), action, str(self.directory), self.book_id, url, media_type, str(limit)],
                input=body, capture_output=True, timeout=10, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        return response.stdout if response.returncode == 0 else None

    def read(self, url, media_type, limit):
        return self.run("read", url, media_type, limit)

    def write(self, url, media_type, limit, body):
        self.run("write", url, media_type, limit, body)


def read_resource(upstream, checkpoint, url, media_type, limit, label, parse, *, fresh=False):
    def restore():
        if not checkpoint:
            return None
        cached = checkpoint.read(url, media_type, limit)
        if not cached or len(cached) > limit:
            return None
        try:
            parsed = parse(cached)
        except (ValueError, SyncError):
            return None
        upstream.measure(cached, limit, label)
        print(f"{label}: restored from sync checkpoint", flush=True)
        return parsed

    if not fresh:
        restored = restore()
        if restored is not None:
            return restored
    try:
        body = upstream.fetch(url, media_type, limit, label)
    except SyncUnavailable:
        if not fresh:
            raise
        restored = restore()
        if restored is None:
            raise
        return restored
    parsed = parse(body)
    if checkpoint:
        checkpoint.write(url, media_type, limit, body)
    return parsed


def parse_catalog_response(body, book_id):
    contents = read_catalog(body.decode("utf-8-sig"), book_id)
    catalog_ids = sorted(contents.chapter_ids)
    if not catalog_ids:
        raise SyncError("catalog: no chapter links")
    book_title = contents.book_title()
    if not book_title:
        raise SyncError("catalog: missing book title")
    return book_title, catalog_ids


def parse_png(body):
    if not body.startswith(PNG_SIGNATURE):
        raise ValueError("Invalid PNG signature")
    return body


def sync_chapters(upstream, book_url=CATALOG_URL, checkpoint=None):
    book_id, catalog_url = normalize_book_url(book_url)
    chapter_root = f"{ORIGIN}/read/{book_id}/"
    book_title, catalog_ids = read_resource(
        upstream, checkpoint, catalog_url, "text/html", HTML_LIMIT, "catalog",
        lambda body: parse_catalog_response(body, book_id), fresh=True,
    )
    print(f"catalog: {len(catalog_ids)} chapters", flush=True)

    chapter_ids = []
    missing_chapter_ids = []
    chapters = []
    image_urls = {}
    for chapter_id in catalog_ids:
        label = f"chapter {chapter_id}"
        try:
            title, paragraphs = read_resource(
                upstream, checkpoint, f"{chapter_root}{chapter_id}.html", "text/html", HTML_LIMIT, label,
                lambda body: parse_chapter(body.decode("utf-8-sig"), chapter_root),
            )
        except SyncUnavailable as error:
            missing_chapter_ids.append(chapter_id)
            print(f"{error}, continuing with available chapters", flush=True)
            continue
        except ValueError:
            raise SyncError(f"{label}: unexpected chapter content") from None

        for paragraph in paragraphs:
            for part in paragraph:
                if isinstance(part, dict):
                    image_urls.setdefault(part["image"], None)

        chapter_ids.append(chapter_id)
        chapters.append({"title": title, "paragraphs": paragraphs})
        print(f"{label}: {len(paragraphs)} paragraphs", flush=True)

    if not chapters:
        raise SyncError("sync: no chapters downloaded")

    print(f"images: {len(image_urls)} unique PNGs", flush=True)
    images = []
    missing_glyphs = 0
    for index, url in enumerate(image_urls, start=1):
        label = f"image {index}"
        try:
            png = read_resource(upstream, checkpoint, url, "image/png", PNG_LIMIT, label, parse_png)
        except SyncUnavailable as error:
            image_urls[url] = "□"
            missing_glyphs += 1
            print(f"{error}, using placeholder", flush=True)
            continue
        except ValueError:
            raise SyncError(f"{label}: invalid PNG signature") from None
        image_urls[url] = {"image": len(images)}
        images.append(base64.b64encode(png).decode("ascii"))

    for chapter in chapters:
        chapter["paragraphs"] = [
            [image_urls[part["image"]] if isinstance(part, dict) else part for part in paragraph]
            for paragraph in chapter["paragraphs"]
        ]

    return {
        "id": book_id,
        "title": book_title,
        "chapterIds": chapter_ids,
        "missingChapterIds": missing_chapter_ids,
        "chapters": chapters,
        "images": images,
        "missingGlyphs": missing_glyphs,
    }


def write_package(path, package):
    temporary = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False)
    temporary_path = Path(temporary.name)
    try:
        with temporary:
            json.dump(package, temporary, ensure_ascii=False, separators=(",", ":"))
            temporary.write("\n")
        temporary_path.replace(path)
    finally:
        temporary_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description="Sync the linked reader chapter package.")
    parser.add_argument("output_json", type=Path)
    parser.add_argument("--book-url", default=CATALOG_URL, help="Public lizhiks.com book URL")
    parser.add_argument("--checkpoint-dir", type=Path, help="Directory for encrypted sync progress")
    args = parser.parse_args()
    try:
        if not args.output_json.parent.is_dir() or args.output_json.is_dir():
            raise SyncError("invalid output path")
        checkpoint = None
        if args.checkpoint_dir and os.environ.get("READER_PASSWORD"):
            book_id, _ = normalize_book_url(args.book_url)
            checkpoint = Checkpoint(args.checkpoint_dir, book_id)
        package = sync_chapters(Upstream(), args.book_url, checkpoint)
        write_package(args.output_json, package)
    except SyncError as error:
        print(error, file=sys.stderr)
        return 1
    except (ValueError, OSError):
        print("sync: invalid input, response, or output", file=sys.stderr)
        return 1

    print(f"sync: {len(package['chapters'])} chapters, {len(package['images'])} unique PNGs, "
          f"{package['missingGlyphs']} missing glyphs, {len(package['missingChapterIds'])} missing chapters")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

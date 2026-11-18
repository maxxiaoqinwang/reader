import argparse
import base64
import json
import re
import sys
import tempfile
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, build_opener

ORIGIN = "https://www.lizhiks.com"
HOST = "www.lizhiks.com"
CATALOG_URL = f"{ORIGIN}/book/229314.html"
CHAPTER_ROOT = f"{ORIGIN}/read/229314/"
CHAPTER_PATH = re.compile(r"/read/229314/([1-9][0-9]*)\.html")
PNG_PATH = re.compile(r"/asset/fonts/[0-9]+\.png")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
HTML_LIMIT = 2 * 1024 * 1024
PNG_LIMIT = 256 * 1024
TOTAL_LIMIT = 32 * 1024 * 1024
REQUEST_GAP = 0.5
REQUEST_TIMEOUT = 10
VOID_TAGS = frozenset(
    "area base br col embed hr img input link meta param source track wbr".split()
)
HTML_SPACE = re.compile(r"[\t\n\f\r ]+")


class SyncError(Exception):
    pass


def source_url(value, base):
    try:
        url = urlsplit(urljoin(base, value))
    except ValueError:
        return None
    if url.scheme == "https" and url.netloc.lower() == HOST:
        return url
    return None


class CatalogParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.chapter_ids = set()

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        url = source_url(dict(attrs).get("href") or "", CATALOG_URL)
        match = CHAPTER_PATH.fullmatch(url.path) if url else None
        if match:
            self.chapter_ids.add(int(match[1]))


def parse_catalog(html):
    parser = CatalogParser()
    parser.feed(html)
    parser.close()
    return sorted(parser.chapter_ids)


class ChapterParser(HTMLParser):
    def __init__(self):
        super().__init__()
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
                url = source_url(attributes.get("src") or "", CHAPTER_ROOT)
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


def parse_chapter(html):
    parser = ChapterParser()
    parser.feed(html)
    parser.close()
    title = HTML_SPACE.sub(" ", "".join(parser.title_parts)).strip()
    if not title or not parser.paragraphs or parser.content_stack:
        raise ValueError("Invalid chapter structure")
    return title, parser.paragraphs


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


class Upstream:
    def __init__(self):
        self.opener = build_opener(NoRedirects())
        self.started = False
        self.bytes_read = 0

    def fetch(self, url, media_type, limit, label):
        if self.started:
            time.sleep(REQUEST_GAP)
        self.started = True

        try:
            with self.opener.open(url, timeout=REQUEST_TIMEOUT) as response:
                if response.status != 200:
                    raise SyncError(f"{label}: HTTP {response.status}")
                if response.headers.get("cf-mitigated", "").lower() == "challenge":
                    raise SyncError(f"{label}: challenge")
                if response.headers.get_content_type() != media_type:
                    raise SyncError(f"{label}: unexpected content type")
                body = response.read(limit + 1)
        except HTTPError as error:
            error.close()
            raise SyncError(f"{label}: HTTP {error.code}") from None
        except OSError:
            raise SyncError(f"{label}: request failed") from None

        self.bytes_read += len(body)
        if not body or len(body) > limit or self.bytes_read > TOTAL_LIMIT:
            raise SyncError(f"{label}: empty or oversized response")
        return body


def sync_chapters(upstream):
    catalog = upstream.fetch(CATALOG_URL, "text/html", HTML_LIMIT, "catalog")
    chapter_ids = parse_catalog(catalog.decode("utf-8-sig"))
    if not chapter_ids:
        raise SyncError("catalog: no chapter links")
    print(f"catalog: {len(chapter_ids)} chapters", flush=True)

    chapters = []
    image_urls = {}
    for chapter_id in chapter_ids:
        label = f"chapter {chapter_id}"
        html = upstream.fetch(f"{CHAPTER_ROOT}{chapter_id}.html", "text/html", HTML_LIMIT, label)
        try:
            title, paragraphs = parse_chapter(html.decode("utf-8-sig"))
        except ValueError:
            raise SyncError(f"{label}: unexpected chapter content") from None

        for paragraph in paragraphs:
            for part in paragraph:
                if isinstance(part, dict):
                    part["image"] = image_urls.setdefault(part["image"], len(image_urls))

        chapters.append({"title": title, "paragraphs": paragraphs})
        print(f"{label}: {len(paragraphs)} paragraphs", flush=True)

    images = []
    for url, index in image_urls.items():
        label = f"image {index + 1}"
        png = upstream.fetch(url, "image/png", PNG_LIMIT, label)
        if not png.startswith(PNG_SIGNATURE):
            raise SyncError(f"{label}: invalid PNG signature")
        images.append(base64.b64encode(png).decode("ascii"))

    return {"chapters": chapters, "images": images}


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
    args = parser.parse_args()
    try:
        if not args.output_json.parent.is_dir() or args.output_json.is_dir():
            raise SyncError("invalid output path")
        package = sync_chapters(Upstream())
        write_package(args.output_json, package)
    except SyncError as error:
        print(error, file=sys.stderr)
        return 1
    except (ValueError, OSError):
        print("sync: invalid input, response, or output", file=sys.stderr)
        return 1

    print(f"sync: {len(package['chapters'])} chapters, {len(package['images'])} unique PNGs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

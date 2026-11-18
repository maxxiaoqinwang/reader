const chapterUrl = 'https://www.lizhiks.com/read/229314/1.html';
const chapterMarker = /<div\b[^>]*\s+id\s*=\s*(["'])chapter-content\1[^>]*>/i;

const result = {
  status: null,
  contentType: null,
  hasChapterBody: false,
};

try {
  const response = await fetch(chapterUrl, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });

  result.status = response.status;
  result.contentType = response.headers.get('content-type');
  const cfMitigated = response.headers.get('cf-mitigated');
  const retryAfter = response.headers.get('retry-after');
  if (cfMitigated) result.cfMitigated = cfMitigated;
  if (retryAfter) result.retryAfter = retryAfter;

  if (result.status === 200 && /^text\/html(?:\s*;|$)/i.test(result.contentType ?? '') && !cfMitigated) {
    result.hasChapterBody = chapterMarker.test(await response.text());
  } else {
    await response.body?.cancel();
  }
} catch {
  // Keep partial response metadata available after network or body-read errors.
}

console.log(JSON.stringify(result));
if (!result.hasChapterBody) {
  process.exitCode = 1;
}

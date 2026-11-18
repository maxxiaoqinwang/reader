class RequestError extends Error {}

async function main() {
  const [url, mediaType, maxBytes] = process.argv.slice(2);
  const limit = Number(maxBytes);
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status !== 200 || response.headers.get('cf-mitigated') === 'challenge') {
    await response.body?.cancel();
    const retry = response.headers.get('retry-after');
    const suffix = response.status === 429 && /^\d{1,6}$/.test(retry ?? '')
      ? ' (retry after ' + retry + ' seconds)'
      : '';
    throw new RequestError('HTTP ' + response.status + suffix);
  }
  if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== mediaType) {
    await response.body?.cancel();
    throw new RequestError('unexpected content type');
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw new RequestError('oversized response');
    chunks.push(chunk);
  }
  if (!length) throw new RequestError('empty response');
  process.stdout.write(Buffer.concat(chunks, length));
}

main().catch(error => {
  console.error(error instanceof RequestError ? error.message : 'request failed');
  process.exitCode = 1;
});

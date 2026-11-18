class RequestError extends Error {}

const timeoutCodes = new Set([
  'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

async function main(signal) {
  const [url, mediaType, maxBytes] = process.argv.slice(2);
  const limit = Number(maxBytes);
  const response = await fetch(url, {
    redirect: 'manual',
    signal,
  });

  if (response.status !== 200 || response.headers.get('cf-mitigated') === 'challenge') {
    response.body?.cancel().catch(() => {});
    const retry = response.headers.get('retry-after');
    const suffix = response.status === 429 && /^\d{1,6}$/.test(retry ?? '')
      ? ' (retry after ' + retry + ' seconds)'
      : '';
    throw new RequestError('HTTP ' + response.status + suffix);
  }
  if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== mediaType) {
    response.body?.cancel().catch(() => {});
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

const signal = AbortSignal.timeout(10_000);
main(signal).catch(error => {
  if (error instanceof RequestError) {
    console.error(error.message);
  } else if (signal.reason?.name === 'TimeoutError' || timeoutCodes.has(error?.cause?.code ?? error?.code)) {
    console.error('request timed out');
  } else {
    console.error('request failed');
  }
  process.exitCode = 1;
});

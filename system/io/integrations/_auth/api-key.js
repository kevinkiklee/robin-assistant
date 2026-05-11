export async function validateApiKey({
  baseUrl,
  key,
  headerName = 'Authorization',
  headerPrefix = 'Bearer ',
  testPath,
  fetchFn = globalThis.fetch,
}) {
  const r = await fetchFn(`${baseUrl}${testPath}`, {
    headers: { [headerName]: `${headerPrefix}${key}` },
  });
  if (!r.ok) throw new Error(`api-key validation failed: ${r.status}`);
  return await r.json();
}

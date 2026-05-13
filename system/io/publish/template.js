import { DESCRIPTION_MAX_LENGTH, TITLE_MAX_LENGTH } from './config.js';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s, n) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n) : s;
}

export function wrapHtml({ title, description, slug, bodyHtml, dateUtc, publicBaseUrl }) {
  const safeTitle = escapeHtml(truncate(title, TITLE_MAX_LENGTH));
  const safeDesc = description ? escapeHtml(truncate(description, DESCRIPTION_MAX_LENGTH)) : null;
  const url = `${publicBaseUrl}/p/${slug}`;

  const descTags = safeDesc
    ? `\n  <meta name="description" content="${safeDesc}">\n  <meta property="og:description" content="${safeDesc}">`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeTitle}</title>${descTags}
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${url}">
  <meta name="twitter:card" content="summary">
  <link rel="canonical" href="${url}">
  <link rel="stylesheet" href="/_pub/page.css">
</head>
<body>
  <main class="prose">
${bodyHtml}
  </main>
  <footer class="published-by">
    Published with Robin · ${dateUtc}
  </footer>
</body>
</html>
`;
}

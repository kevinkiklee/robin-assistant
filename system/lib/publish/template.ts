import { DESCRIPTION_MAX_LENGTH, TITLE_MAX_LENGTH } from './config.ts';

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  return s.length > n ? s.slice(0, n) : s;
}

export interface WrapHtmlInput {
  title: string;
  description: string | null;
  slug: string;
  bodyHtml: string;
  dateUtc: string;
  publicBaseUrl: string;
}

export function wrapHtml(input: WrapHtmlInput): string {
  const truncatedTitle = truncate(input.title, TITLE_MAX_LENGTH) ?? '';
  const safeTitle = escapeHtml(truncatedTitle);
  const truncatedDesc = truncate(input.description, DESCRIPTION_MAX_LENGTH);
  const safeDesc = truncatedDesc ? escapeHtml(truncatedDesc) : null;
  const url = `${input.publicBaseUrl}/p/${input.slug}`;

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
  <div class="page-layout">
    <aside class="toc-sidebar" id="toc-sidebar">
      <nav id="toc-nav" aria-label="Table of contents"></nav>
    </aside>
    <main class="prose">
${input.bodyHtml}
    </main>
  </div>
  <footer class="published-by">
    Published with Robin · ${input.dateUtc}
  </footer>
  <script src="/_pub/toc.js" defer></script>
</body>
</html>
`;
}

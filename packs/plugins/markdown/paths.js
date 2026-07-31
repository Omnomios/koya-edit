/**
 * Markdown preview path helpers.
 * Preview uses a virtual path so normal .md opens stay in the text editor.
 */
export const PREVIEW_PREFIX = 'markdown-preview:';

export function isMarkdownSourcePath(path)
{
  return /\.(md|markdown|mdown|mkd)$/i.test(String(path || ''));
}

export function previewPathFor(sourcePath)
{
  return PREVIEW_PREFIX + String(sourcePath || '');
}

export function sourcePathFromPreview(path)
{
  const p = String(path || '');
  if(!p.startsWith(PREVIEW_PREFIX)) return null;
  return p.slice(PREVIEW_PREFIX.length) || null;
}

export function isMarkdownPreviewPath(path)
{
  return String(path || '').startsWith(PREVIEW_PREFIX);
}

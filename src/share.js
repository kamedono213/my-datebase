export function parseSharePayload(params) {
  const get = (key) => String(params?.get?.(key) ?? '').trim();
  const isShareTarget = get('share_target') === '1';
  const title = get('title');
  const text = get('text');
  const url = get('url');
  const parts = [];
  if (text) parts.push(text);
  if (url && !text.includes(url)) parts.push(url);
  return {
    isShareTarget,
    title,
    content: parts.join('\n\n'),
  };
}

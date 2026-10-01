const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export function safeRemoteImage(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || !host.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')
      || /(?:^|\.)(localhost|local|internal|home|lan)$/.test(host)) return null;
    return url.href;
  } catch { return null; }
}

export function rasterImageData(mime, data) {
  mime = mime?.toLowerCase();
  if (!IMAGE_TYPES.has(mime) || typeof data !== 'string' || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return null;
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  let bytes;
  try { bytes = atob(base64); } catch { return null; }
  const signature = mime === 'image/png' ? bytes.startsWith('\x89PNG\r\n\x1a\n')
    : mime === 'image/jpeg' ? bytes.startsWith('\xff\xd8\xff')
      : mime === 'image/gif' ? /^GIF8[79]a/.test(bytes)
        : mime === 'image/webp' ? bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP'
          : bytes.slice(4, 8) === 'ftyp' && /avif|avis/.test(bytes.slice(8, 32));
  return signature && bytes.length <= MAX_IMAGE_BYTES ? `data:${mime};base64,${base64}` : null;
}

export function safeEmbeddedImage(value) {
  if (typeof value !== 'string') return null;
  const match = /^data:(image\/[a-z]+);base64,([\s\S]*)$/i.exec(value);
  return match ? rasterImageData(match[1], match[2]) : null;
}

export function contentId(value) {
  if (typeof value !== 'string' || !/^cid:/i.test(value)) return null;
  try { return decodeURIComponent(value.slice(4)).trim().replace(/^<|>$/g, '').trim(); }
  catch { return null; }
}

export function inlineImageReferences(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return new Set([...template.content.querySelectorAll('img')]
    .map((image) => contentId(image.getAttribute('src'))).filter(Boolean));
}

export async function loadInlineImages(message, account, api, signal) {
  signal?.throwIfAborted();
  const wanted = inlineImageReferences(message.bodyHtml || '');
  const images = new Map();
  if (!wanted.size) return images;
  if (!message.remote || message.accountId !== account?.id) throw new Error('Embedded images require the original connected email account.');
  let total = 0;
  const add = (id, type, bytes) => {
    const image = rasterImageData(type, bytes);
    if (!image) return;
    total += Math.ceil(bytes.length * 3 / 4);
    if (total > MAX_TOTAL_BYTES) throw new Error('Embedded images exceed the 25 MB per-message limit. Open the message at the provider to view them.');
    images.set(id, image);
  };
  if (account.provider === 'gmail') {
    const base = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.remoteId)}`;
    const raw = await api(`${base}?format=full`);
    const parts = [];
    function visit(part) {
      if (!part) return;
      const id = part.headers?.find((header) => header.name.toLowerCase() === 'content-id')?.value?.trim().replace(/^<|>$/g, '').trim();
      if (wanted.has(id) && IMAGE_TYPES.has(part.mimeType?.toLowerCase()) && Number.isFinite(part.body?.size)
        && part.body.size >= 0 && part.body.size <= MAX_IMAGE_BYTES) parts.push({ id, part });
      (part.parts || []).forEach(visit);
    }
    visit(raw.payload);
    for (const { id, part } of parts) {
      signal?.throwIfAborted();
      if (images.has(id)) continue;
      const body = part.body.data ? part.body : part.body.attachmentId
        ? await api(`${base}/attachments/${encodeURIComponent(part.body.attachmentId)}`) : null;
      if (body) add(id, part.mimeType, body.data);
    }
  } else if (account.provider === 'outlook') {
    const base = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(message.remoteId)}/attachments`;
    let url = `${base}?$select=id,contentId,contentType,size,isInline`;
    const seen = new Set();
    while (url) {
      signal?.throwIfAborted();
      if (seen.has(url)) throw new Error('Outlook repeated an attachment page. Image loading stopped.');
      seen.add(url);
      const page = await api(url, { Prefer: 'IdType="ImmutableId"' });
      if (!Array.isArray(page.value)) throw new Error('Outlook returned invalid image metadata.');
      for (const item of page.value) {
        const id = item.contentId?.trim().replace(/^<|>$/g, '').trim();
        if (!wanted.has(id) || images.has(id) || !IMAGE_TYPES.has(item.contentType?.toLowerCase())
          || !Number.isFinite(item.size) || item.size < 0 || item.size > MAX_IMAGE_BYTES) continue;
        const file = await api(`${base}/${encodeURIComponent(item.id)}`, { Prefer: 'IdType="ImmutableId"' });
        add(id, file.contentType, file.contentBytes);
      }
      url = page['@odata.nextLink'] || null;
    }
  } else throw new Error('This provider does not support embedded image loading.');
  signal?.throwIfAborted();
  return images;
}

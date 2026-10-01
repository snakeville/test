import DOMPurify from './vendor/dompurify/dist/purify.es.mjs';
import { safeRemoteImage, safeEmbeddedImage, contentId } from './email-images.js';
import { sanitizeEmailStyle, sanitizeEmailStylesheets } from './email-styles.js';

const TAGS = [
  'a', 'abbr', 'address', 'article', 'b', 'blockquote', 'br', 'caption', 'center',
  'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'font',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'li', 'ol',
  'p', 'pre', 's', 'section', 'small', 'span', 'strike', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
];
const ATTRIBUTES = [
  'href', 'title', 'alt', 'colspan', 'rowspan', 'align', 'valign', 'dir', 'lang', 'class', 'role',
  'style', 'width', 'height', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'color', 'face', 'size', 'start', 'data-gather-image',
];
const attributeText = (value) => value.replace(/[&"<>]/g, (character) =>
  ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character]);

export function safeEmailLink(value) {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function sanitizeEmail(html, { loadImages = false, inlineImages = new Map() } = {}) {
  const template = document.createElement('template');
  // Parse in an inert template before sanitization so even discarded resources never load.
  template.innerHTML = html;
  const stylesheets = sanitizeEmailStylesheets([...template.content.querySelectorAll('style')].map((style) => style.textContent));
  const bodyTag = /<body\b(?:"[^"]*"|'[^']*'|[^'">])*>/i.exec(html)?.[0];
  let bodyAttributes = '';
  const bodyStyle = document.createElement('span').style;
  if (bodyTag) {
    const bodyTemplate = document.createElement('template');
    bodyTemplate.innerHTML = bodyTag.replace(/^<body/i, '<div') + '</div>';
    const body = bodyTemplate.content.firstElementChild;
    bodyStyle.cssText = sanitizeEmailStyle(body.style);
    for (const name of ['class', 'dir', 'lang', 'bgcolor']) {
      const value = body.getAttribute(name);
      if (value) bodyAttributes += ` ${name}="${attributeText(value)}"`;
    }
  }
  for (const [property, value] of [['height', 'auto'], ['min-height', '0'], ['max-height', 'none'], ['overflow', 'visible']]) {
    bodyStyle.setProperty(property, value, 'important');
  }
  bodyAttributes += ` style="${attributeText(bodyStyle.cssText)}"`;
  const sources = new Map();
  for (const image of template.content.querySelectorAll('img')) {
    const key = String(sources.size);
    sources.set(key, image.getAttribute('src'));
    image.removeAttribute('src');
    image.removeAttribute('srcset');
    image.setAttribute('data-gather-image', key);
  }
  const fragment = DOMPurify.sanitize(template.content, {
    ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ATTRIBUTES,
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true, SANITIZE_NAMED_PROPS: true,
    FORBID_CONTENTS: ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'template'],
  });
  for (const element of fragment.querySelectorAll('*')) {
    if (element.hasAttribute('style')) {
      const style = sanitizeEmailStyle(element.style);
      element.removeAttribute('style');
      if (style) element.setAttribute('style', style);
    }
    if (element.tagName === 'IMG') {
      const original = sources.get(element.getAttribute('data-gather-image'));
      const cid = contentId(original);
      const src = loadImages ? safeRemoteImage(original) || safeEmbeddedImage(original)
        || (cid && safeEmbeddedImage(inlineImages.get(cid))) : null;
      if (src) {
        const image = template.content.ownerDocument.createElement('img');
        image.setAttribute('referrerpolicy', 'no-referrer');
        image.setAttribute('decoding', 'async');
        image.alt = element.getAttribute('alt') || 'Email image';
        for (const name of ['width', 'height']) {
          const value = element.getAttribute(name);
          if (value && /^\d+(?:\.\d+)?%?$/.test(value) && parseFloat(value) <= 4096) image.setAttribute(name, value);
        }
        for (const name of ['class', 'style', 'align', 'valign']) {
          if (element.hasAttribute(name)) image.setAttribute(name, element.getAttribute(name));
        }
        image.src = src;
        element.replaceWith(image);
        continue;
      }
      const placeholder = document.createElement('span');
      placeholder.className = 'blocked-image';
      const label = !loadImages ? 'Image blocked' : cid ? 'Embedded image unavailable' : 'Image source unsupported';
      placeholder.textContent = element.getAttribute('alt') ? `[${label}: ${element.getAttribute('alt')}]` : `[${label}]`;
      element.replaceWith(placeholder);
      continue;
    }
    element.removeAttribute('data-gather-image');
    if (element.tagName === 'A') {
      const href = safeEmailLink(element.getAttribute('href'));
      if (href) {
        element.setAttribute('href', href);
        element.setAttribute('title', `Open external link: ${href}`);
        element.setAttribute('rel', 'noopener noreferrer');
        element.setAttribute('target', '_blank');
      } else element.removeAttribute('href');
    }
    for (const attribute of ['colspan', 'rowspan']) {
      if (element.hasAttribute(attribute)) {
        const value = Number(element.getAttribute(attribute));
        if (!Number.isInteger(value) || value < 1 || value > 100) element.removeAttribute(attribute);
      }
    }
  }
  const container = template.content.ownerDocument.createElement('div');
  container.append(fragment);
  return { markup: container.innerHTML, stylesheets, bodyAttributes, hasBody: Boolean(bodyTag) };
}

export function sanitizeEmailHtml(html, options) {
  return sanitizeEmail(html, options).markup;
}

export function createEmailDocument(html, options = {}) {
  const clean = sanitizeEmail(html, options);
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="referrer" content="no-referrer">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src ${options.loadImages ? 'https: http: data:' : "'none'"}; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'">
    <style>
      :root { color-scheme: light; }
      html { overflow: hidden; }
      body { margin: 0; padding: ${clean.hasBody ? '0' : '16px'}; color: #000; background: white; font: ${clean.hasBody ? '16px' : '14px'}/normal Arial, sans-serif; overflow-wrap: anywhere; height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; }
      table, img { max-width: 100% !important; }
      td, th { overflow-wrap: anywhere; }
      pre, code { white-space: pre-wrap !important; overflow-wrap: anywhere; }
      .blocked-image { display: inline-block; padding: 4px 8px; margin: 4px 0; border: 1px dashed #bdcbb3; border-radius: 4px; color: #68765f; font: 11px/1.6 system-ui, sans-serif; }
    </style><style>${clean.stylesheets}</style></head><body${clean.bodyAttributes}>${clean.markup || '<p>No displayable HTML content. Try the plain-text view.</p>'}</body></html>`;
}

export function mountHtmlMessages(root, messages, onLink, imageOptions = () => ({}), displayHtml = (message) => message.bodyHtml) {
  const observers = [];
  const cleanups = [];
  let active = true;
  const frames = root.querySelectorAll('iframe[data-html-message]');
  for (const frame of frames) {
    const message = messages.find((entry) => entry.id === frame.dataset.htmlMessage);
    if (!message?.bodyHtml) continue;
    const fallback = frame.parentElement.querySelector('.html-fallback');
    let initialized = false;
    let animationFrame;
    const onLoad = () => {
      if (!active || !frame.isConnected || initialized) return;
      if (frame.contentDocument?.URL === 'about:blank') return;
      const body = frame.contentDocument?.body;
      if (!body) {
        frame.hidden = true;
        fallback.hidden = false;
        fallback.querySelector('[role="status"]').textContent = 'Formatted view could not load. Showing plain text.';
        return;
      }
      initialized = true;
      body.addEventListener('click', (event) => {
        const link = event.target.closest('a[href]');
        if (!link) return;
        event.preventDefault();
        const href = safeEmailLink(link.getAttribute('href'));
        if (href) onLink(href);
      });
      const resize = () => {
        if (active && frame.isConnected) frame.style.height = `${Math.ceil(Math.max(body.getBoundingClientRect().height, body.scrollHeight))}px`;
      };
      const failedImage = (image) => {
        if (!active || !image.isConnected || image.tagName !== 'IMG') return;
        const placeholder = body.ownerDocument.createElement('span');
        placeholder.className = 'blocked-image';
        placeholder.textContent = `[Image could not be loaded: ${image.alt || 'Email image'}] The image host may be blocking access or the URL may no longer be available. `;
        const retry = body.ownerDocument.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Retry image';
        retry.addEventListener('click', () => {
          const replacement = image.cloneNode(true);
          placeholder.replaceWith(replacement);
          checkCompletedImage(replacement);
        });
        placeholder.append(retry);
        const href = safeRemoteImage(image.getAttribute('src'));
        if (href) {
          const open = body.ownerDocument.createElement('a');
          open.href = href;
          open.textContent = ' Open image';
          open.rel = 'noopener noreferrer';
          open.target = '_blank';
          placeholder.append(open);
        }
        image.replaceWith(placeholder);
      };
      const checkCompletedImage = (image) => {
        // Dimensionless SVGs can load successfully with naturalWidth === 0.
        if (image.complete && image.currentSrc) image.decode().then(resize, () => failedImage(image));
      };
      body.addEventListener('error', (event) => failedImage(event.target), true);
      for (const image of body.querySelectorAll('img')) checkCompletedImage(image);
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(body);
      observers.push(observer);
    };
    frame.addEventListener('load', onLoad);
    cleanups.push(() => { frame.removeEventListener('load', onLoad); cancelAnimationFrame(animationFrame); });
    try {
      frame.srcdoc = createEmailDocument(displayHtml(message), imageOptions(message));
      const initializeWhenParsed = () => {
        if (!active || !frame.isConnected) return;
        if (frame.contentDocument?.URL === 'about:srcdoc' && frame.contentDocument.body) onLoad();
        if (!initialized) animationFrame = requestAnimationFrame(initializeWhenParsed);
      };
      animationFrame = requestAnimationFrame(initializeWhenParsed);
    } catch {
      frame.hidden = true;
      fallback.hidden = false;
      fallback.querySelector('[role="status"]').textContent = 'HTML rendering failed. Showing plain text instead.';
    }
  }
  return () => {
    active = false;
    cleanups.forEach((cleanup) => cleanup());
    observers.forEach((observer) => observer.disconnect());
  };
}

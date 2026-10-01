import { messageQuoteContent } from './email-quotes.js';

const HORIZONTAL_SPACE = /[ \t\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g;

export function normalizePlainText(value) {
  const lines = value.replace(/\r\n?/g, '\n').replace(/[\u200b\ufeff]/g, '').split('\n');
  const result = [];
  let fence = null;
  for (const raw of lines) {
    const line = raw.replace(/[ \t\u00a0\u2000-\u200a\u202f\u205f\u3000]+$/g, '');
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      result.push(line);
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (marker) {
      fence = marker;
      result.push(line);
    } else if (!line.trim()) {
      if (result.length && result.at(-1) !== '') result.push('');
    } else if (/^(?: {4}|\t)/.test(line)) {
      // Preserve indentation and alignment in plain-text code or tabular content.
      result.push(line);
    } else {
      const indentation = /^[ ]*/.exec(line)[0];
      const listIndentation = /^\s*(?:[-*+]|\d+[.)])\s/.test(line) ? indentation : '';
      result.push(listIndentation + line.slice(indentation.length).replace(HORIZONTAL_SPACE, ' '));
    }
  }
  while (result.at(-1) === '') result.pop();
  return result.join('\n');
}

export function plainTextFromHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script,style,iframe,object,embed,svg,math,head,link,meta,form,template').forEach((node) => node.remove());
  const blocks = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'DIV', 'SECTION', 'HEADER', 'FOOTER', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TABLE', 'UL', 'OL', 'DL']);
  const segments = [];
  const add = (text) => {
    const last = segments.at(-1);
    if (last && !last.preformatted) last.text += text;
    else segments.push({ text, preformatted: false });
  };
  const lineBreak = () => {
    const last = segments.at(-1);
    if (last && !last.preformatted && /\n[ \t]*$/.test(last.text)) last.text = last.text.replace(/[ \t]+$/, '');
    else add('\n');
  };
  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) { add(node.textContent.replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ')); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true'
      || node.style.display === 'none' || node.style.visibility === 'hidden' || node.style.getPropertyValue('mso-hide') === 'all') return;
    if (node.tagName === 'PRE') {
      add('\n\n');
      segments.push({ text: node.textContent.replace(/\r\n?/g, '\n'), preformatted: true });
      segments.push({ text: '\n\n', preformatted: false });
      return;
    }
    if (node.tagName === 'BR') { add('\n'); return; }
    if (node.tagName === 'HR') { add('\n\n'); return; }
    if (node.tagName === 'IMG') return;
    const block = blocks.has(node.tagName);
    if (block) add('\n\n');
    if (node.tagName === 'LI') {
      const parent = node.parentElement;
      const start = Number.parseInt(parent?.getAttribute('start'), 10) || 1;
      const siblings = [...(parent?.children || [])].filter((entry) => entry.tagName === 'LI');
      lineBreak();
      add(`${parent?.tagName === 'OL' ? `${start + siblings.indexOf(node)}.` : '-'} `);
    }
    if (node.tagName === 'TR') lineBreak();
    for (const child of node.childNodes) visit(child);
    if (['TD', 'TH'].includes(node.tagName)) add('\t');
    if (['LI', 'TR', 'DT', 'DD'].includes(node.tagName)) add('\n');
    if (block) add('\n\n');
  }
  for (const child of template.content.childNodes) visit(child);
  const output = segments.map((segment) => segment.preformatted ? segment.text : segment.text
    .replace(/[\u200b\ufeff]/g, '')
    .replace(/[ \u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')).join('');
  return output.replace(/^\n+|\n+$/g, '');
}

const displayTextCache = new WeakMap();

export function messagePlainText(message, { hideQuotes = false } = {}) {
  if (hideQuotes) {
    const content = messageQuoteContent(message);
    return content.bodyHtml ? plainTextFromHtml(content.bodyHtml) : normalizePlainText(content.body);
  }
  const cached = displayTextCache.get(message);
  if (cached?.body === message.body && cached?.html === message.bodyHtml) return cached.text;
  const text = message.bodyHtml ? plainTextFromHtml(message.bodyHtml) : normalizePlainText(message.body);
  displayTextCache.set(message, { body: message.body, html: message.bodyHtml, text });
  return text;
}

export const messagePreview = (message) => messagePlainText(message, { hideQuotes: true }).replace(/\s+/g, ' ').trim();

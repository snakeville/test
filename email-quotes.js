const QUOTE_CONTAINERS = '.protonmail_quote, .gmail_quote, .yahoo_quoted, blockquote[type="cite"]';
const ORIGINAL_MESSAGE = /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i;

export function stripQuotedText(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const kept = [];
  let removed = false;
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      kept.push(line);
      continue;
    }
    if (fence || /^(?: {4}|\t)/.test(line)) { kept.push(line); continue; }
    if (ORIGINAL_MESSAGE.test(line)) {
      const header = lines.slice(index + 1, index + 10).join('\n');
      if (/^\s*On\b[\s\S]*wrote:\s*$/im.test(header) || /^\s*From:\s*\S/im.test(header)) {
        removed = true;
        break;
      }
    }
    if (/^\s*From:\s*\S/i.test(line)) {
      const header = lines.slice(index, index + 10).join('\n');
      if (/^\s*(?:Sent|Date):\s*\S/im.test(header) && /^\s*To:\s*\S/im.test(header) && /^\s*Subject:\s*\S/im.test(header)) {
        // Outlook's reply header introduces the previous message and its history.
        if (/^\s*_{5,}\s*$/.test(kept.at(-1) || '')) kept.pop();
        removed = true;
        break;
      }
    }
    if (/^\s*On\b/i.test(line)) {
      let end = index;
      while (end < Math.min(index + 5, lines.length - 1) && !/wrote:\s*$/i.test(lines[end])) end++;
      if (/wrote:\s*$/i.test(lines[end])) {
        let firstQuote = end + 1;
        while (firstQuote < lines.length && !lines[firstQuote].trim()) firstQuote++;
        if (/^\s*>/.test(lines[firstQuote] || '')) {
          let after = firstQuote;
          while (after < lines.length && (!lines[after].trim() || /^\s*>/.test(lines[after]))) after++;
          removed = true;
          index = after - 1;
          continue;
        }
      }
    }
    // A trailing >-quoted history block is safe to collapse; inline replies remain visible.
    if (/^\s*>/.test(line) && kept.some((entry) => entry.trim())
      && lines.slice(index).every((entry) => !entry.trim() || /^\s*>/.test(entry))) {
      removed = true;
      break;
    }
    kept.push(line);
  }
  return { text: removed ? kept.join('\n').trimEnd() : text, hasQuotes: removed };
}

export function stripQuotedHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  let removed = false;
  // Remove provider-marked quote containers, not ordinary editorial blockquotes.
  for (const node of template.content.querySelectorAll(QUOTE_CONTAINERS)) {
    if (!template.content.contains(node)) continue;
    const previous = node.previousElementSibling;
    if (previous?.matches('.gmail_attr, .moz-cite-prefix')) previous.remove();
    node.remove();
    removed = true;
  }
  const outlook = template.content.querySelector('#divRplyFwdMsg, #appendonsend');
  if (outlook) {
    const range = document.createRange();
    range.setStartBefore(outlook);
    range.setEnd(template.content, template.content.childNodes.length);
    range.deleteContents();
    removed = true;
  }
  if (!removed) return { html, hasQuotes: false };
  // Retain body attributes for the existing sanitizer's newsletter layout handling.
  const bodyTag = /<body\b(?:"[^"]*"|'[^']*'|[^'">])*>/i.exec(html)?.[0];
  return {
    html: bodyTag ? `<html>${bodyTag}${template.innerHTML}</body></html>` : template.innerHTML,
    hasQuotes: true,
  };
}

const quoteCache = new WeakMap();

export function messageQuoteContent(message) {
  const cached = quoteCache.get(message);
  if (cached?.body === message.body && cached?.bodyHtml === message.bodyHtml) return cached.content;
  const plain = stripQuotedText(message.body);
  const formatted = message.bodyHtml ? stripQuotedHtml(message.bodyHtml) : null;
  const content = {
    body: plain.text,
    bodyHtml: formatted?.html,
    hasQuotes: formatted ? formatted.hasQuotes : plain.hasQuotes,
  };
  quoteCache.set(message, { body: message.body, bodyHtml: message.bodyHtml, content });
  return content;
}

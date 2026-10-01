const PROPERTIES = new Set([
  'color', 'background-color', 'font', 'font-family', 'font-size', 'font-style', 'font-weight',
  'text-align', 'text-decoration', 'text-decoration-line', 'text-decoration-color',
  'text-transform', 'text-indent', 'line-height', 'letter-spacing', 'word-spacing', 'white-space',
  'vertical-align', 'display', 'visibility', 'opacity', 'position',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'box-sizing',
  'overflow', 'overflow-x', 'overflow-y',
  'border', 'border-color', 'border-style', 'border-width', 'border-collapse', 'border-spacing',
  'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'box-shadow', 'clip-path', 'image-rendering',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'list-style-type', '-webkit-text-size-adjust', 'text-size-adjust',
]);

export function sanitizeEmailStyle(style) {
  const safe = document.createElement('span').style;
  for (const property of style) {
    const value = style.getPropertyValue(property);
    if (!PROPERTIES.has(property) || /[\\<@]|(?:url|image(?:-set)?|expression|var|attr|paint|element|env)\s*\(|v(?:w|h|i|b|min|max)\b|-\d/i.test(value)) continue;
    if (property === 'position' && !['static', 'relative'].includes(value)) continue;
    if (property.startsWith('overflow') && !/^(visible|hidden|clip)( (visible|hidden|clip))?$/.test(value)) continue;
    if ([...value.matchAll(/-?\d+(?:\.\d+)?/g)].some((match) => Math.abs(Number(match[0])) > (property.includes('radius') ? 10000 : 4096))) continue;
    safe.setProperty(property, value, style.getPropertyPriority(property));
  }
  return safe.cssText;
}

function safeMediaQuery(condition) {
  const remainder = condition
    .replace(/\(\s*(?:min-|max-)?width\s*:\s*\d+(?:\.\d+)?(?:px|em|rem)\s*\)/gi, '')
    .replace(/\b(?:only|screen|all|and|or|not)\b/gi, '')
    .replace(/[\s,]/g, '');
  return !remainder && /\bwidth\s*:/i.test(condition);
}

export function sanitizeEmailStylesheets(blocks) {
  const sheet = new CSSStyleSheet();
  const cleanRules = (rules) => [...rules].map((rule) => {
    if (rule.type === CSSRule.STYLE_RULE) {
      if (/[<@]/.test(rule.selectorText) || /:(?:has|visited)\b/i.test(rule.selectorText)) return '';
      const declarations = sanitizeEmailStyle(rule.style);
      return declarations ? `${rule.selectorText}{${declarations}}` : '';
    }
    if (rule.type === CSSRule.MEDIA_RULE && safeMediaQuery(rule.conditionText)) {
      const nested = cleanRules(rule.cssRules);
      return nested ? `@media ${rule.conditionText}{${nested}}` : '';
    }
    return '';
  }).join('\n');
  // Constructable stylesheets are never adopted; imports cannot fetch resources here.
  return blocks.map((css) => {
    sheet.replaceSync(css);
    return cleanRules(sheet.cssRules);
  }).join('\n');
}

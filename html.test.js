import { sanitizeEmailHtml, safeEmailLink, createEmailDocument, mountHtmlMessages } from './email-html.js';
import { safeRemoteImage, safeEmbeddedImage, inlineImageReferences, loadInlineImages } from './email-images.js';
import { sanitizeEmailStylesheets } from './email-styles.js';

const results = [];
async function test(name, check) {
  try { await check(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
}
function assert(condition, message = 'Assertion failed') { if (!condition) throw new Error(message); }
function fragment(html, options) {
  const template = document.createElement('template');
  template.innerHTML = sanitizeEmailHtml(html, options);
  return template.content;
}
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const fixture = document.querySelector('#fixture');
let cleanup = () => {};
async function mount(html, onLink = () => {}, options = {}) {
  cleanup();
  fixture.innerHTML = '<div><iframe data-html-message="fixture-message" sandbox="allow-same-origin" referrerpolicy="no-referrer" title="HTML fixture"></iframe><div class="html-fallback" hidden><p role="status"></p></div></div>';
  cleanup = mountHtmlMessages(fixture, [{ id: 'fixture-message', bodyHtml: html }], onLink, () => options);
  const frame = fixture.querySelector('iframe');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (frame.contentDocument?.URL === 'about:srcdoc' && frame.style.height) { await wait(50); return frame; }
    await wait(20);
  }
  throw new Error('HTML message failed to load or resize.');
}

const canvas = document.createElement('canvas');
canvas.width = 120; canvas.height = 60;
canvas.getContext('2d').fillRect(0, 0, 120, 60);
const PNG = canvas.toDataURL('image/png');
const PNG_BYTES = PNG.split(',')[1];
const newsletterFixture = `<!doctype html><html><head><style>
  body { font-family: Arial, sans-serif; }
  @media (max-width: 512px) { .newsletter { width: 100% !important; } }
  @media (max-width: 480px) {
    .inline-button, .inline-button table { display: none !important; }
    .full-width-button, .full-width-button table { display: table !important; }
  }
</style></head><body style="margin:0;padding:8px 0 0;background-color:#f3f2f0">
  <div class="preheader" style="visibility:hidden;height:0;max-height:0;width:0;overflow:hidden;opacity:0">Hidden preview text</div>
  <table class="newsletter" width="512" align="center" cellpadding="0" cellspacing="0" style="width:512px;max-width:512px;margin:0 auto;background-color:white">
    <tr><td style="padding:24px">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td><img src="${PNG}" width="101" height="37" style="width:101px;height:37px" alt="Sample logo"></td>
        <td align="right"><table class="header-icons" width="auto"><tr><td><img src="${PNG}" height="25" style="height:25px" alt="Sample icon"></td></tr></table></td>
      </tr></table>
      <p style="font-size:20px;text-align:center">People you may know</p>
      <table class="profile-grid" width="100%"><tr>
        <td width="50%" align="center" style="border:1px solid #ddd;border-radius:8px;padding:8px">
          <img class="avatar-photo" src="${PNG}" width="96" height="96" style="width:96px;height:96px;border-radius:9999px;display:inline-block;clip-path:circle(50%)" alt="Sample profile">
          <p>Sample Person</p>
          <table class="connect-button" width="auto" style="border-collapse:separate"><tr><td style="border-width:1px;border-style:solid;border-color:#0a66c2;border-radius:24px;padding:12px 24px">Connect</td></tr></table>
        </td><td width="50%">A second profile</td>
      </tr></table>
      <table class="inline-button" width="auto" style="display:table"><tr><td>Desktop action</td></tr></table>
      <table class="full-width-button" width="100%" style="display:none"><tr><td>Mobile action</td></tr></table>
    </td></tr>
  </table>
</body></html>`;

await test('Preserves headings, emphasis, lists, quotations, tables, and inline formatting', () => {
  const content = fragment('<h2>Welcome</h2><p style="color:red;text-align:center"><strong>Bold</strong> and <em>italic</em></p><ul><li>One</li></ul><blockquote>Quote</blockquote><table><tr><th>Item</th><td colspan="2">Value</td></tr></table>');
  assert(content.querySelector('h2').textContent === 'Welcome');
  assert(content.querySelector('strong') && content.querySelector('em') && content.querySelector('li') && content.querySelector('blockquote'));
  assert(content.querySelector('td').getAttribute('colspan') === '2');
  assert(content.querySelector('p').style.color === 'red' && content.querySelector('p').style.textAlign === 'center');
});
await test('Removes scripts, event handlers, embedded documents, forms, SVG, and metadata', () => {
  const content = fragment('<script>window.emailExecuted=true</script><p onclick="alert(1)">Safe text</p><iframe src="/html-resource-probe"></iframe><form><input name="password"><button>Submit</button></form><svg><a href="javascript:alert(1)">svg</a></svg><math><mi>x</mi></math><object data="/html-resource-probe"></object><meta http-equiv="refresh" content="0;url=/html-resource-probe"><base href="https://example.test"><link rel="stylesheet" href="/html-resource-probe">');
  assert(!content.querySelector('script,iframe,form,input,button,svg,math,object,meta,base,link'));
  assert(!content.querySelector('[onclick]') && content.textContent.includes('Safe text'));
  assert(!content.textContent.includes('emailExecuted'));
});
await test('Blocks remote, embedded, and CID images and preserves their alternative text', () => {
  const content = fragment('<img src="/html-resource-probe" srcset="/html-resource-probe 2x" alt="Company logo"><img src="cid:logo"><img src="data:image/svg+xml,test">');
  assert(!content.querySelector('img,[src],[srcset]'));
  assert(content.querySelectorAll('.blocked-image').length === 3);
  assert(content.textContent.includes('[Image blocked: Company logo]'));
});
await test('Drops external CSS, URL-based styles, positioning, viewport sizing, and scrolling rules', () => {
  const content = fragment('<style>@import "/html-resource-probe";body{position:fixed}</style><p style="color:#45643b;background:url(/html-resource-probe);position:fixed;top:0;z-index:999;overflow:auto;height:10px;font-size:100vh;line-height:100dvh;margin-top:-200px">Visible</p>');
  const style = content.querySelector('p').style;
  assert(style.color && !style.background && !style.position && !style.overflow && style.height === '10px');
  assert(!style.fontSize && !style.lineHeight && !style.marginTop);
  assert(!content.querySelector('style'));
});
await test('Strips clobbering identifiers and unauthorized navigation attributes', () => {
  const content = fragment('<a id="location" name="parent" href="https://example.test/path" target="_top" ping="/html-resource-probe" download accesskey="x">Link</a>');
  const link = content.querySelector('a');
  assert(!link.id && !link.getAttribute('name') && !link.getAttribute('ping') && !link.getAttribute('download'));
  assert(link.target === '_blank' && link.rel === 'noopener noreferrer');
});
await test('Only explicit HTTP, HTTPS, and mailto destinations survive URL validation', () => {
  for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'blob:https://example.test/x',
    '//example.test', '/relative', 'https://user:pass@example.test', 'java\nscript:alert(1)']) {
    assert(safeEmailLink(href) === null, href);
  }
  assert(safeEmailLink('https://example.test/path?q=1') === 'https://example.test/path?q=1');
  assert(safeEmailLink('mailto:friend@example.test') === 'mailto:friend@example.test');
  const content = fragment('<a href="javascript&#58;alert(1)">Bad link</a>');
  assert(!content.querySelector('a').hasAttribute('href'));
});
await test('Message document has a no-script/no-network policy independent of the app policy', () => {
  const html = createEmailDocument('<p>Safe body</p>');
  assert(html.includes("default-src 'none'") && html.includes("script-src 'none'") && html.includes("img-src 'none'"));
  assert(html.includes("form-action 'none'") && html.includes('no-referrer'));
});
await test('Malformed and namespaced payloads cannot create active elements', () => {
  const inputs = [
    '<svg><foreignObject><p onload="alert(1)">Text</p></foreignObject></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=/html-resource-probe onerror=alert(1)>">',
    '<noscript><p title="</noscript><img src=/html-resource-probe onerror=alert(1)>">Text</p>',
    '<form><math><mtext></form><form><mglyph><style></math><img src=/html-resource-probe onerror=alert(1)>',
  ];
  for (const html of inputs) {
    const content = fragment(html);
    assert(!content.querySelector('script,svg,math,iframe,form,img,[src],[onerror],[onload]'));
  }
});
await test('HTML is sandboxed, resizes to fit the entire message, and makes no resource requests', async () => {
  window.emailExecuted = false;
  const probe = `${location.origin}/html-resource-probe`;
  const frame = await mount(`<style>@import "${probe}";</style><script>parent.emailExecuted=true</script><img src="${probe}" onerror="parent.emailExecuted=true" alt="Blocked logo"><p style="background-image:url(${probe})">Hello</p>${'<p>A complete paragraph of formatted email content.</p>'.repeat(70)}`);
  assert(frame.sandbox.value === 'allow-same-origin' && !window.emailExecuted);
  assert(frame.clientHeight > 1500);
  assert(frame.contentDocument.documentElement.scrollHeight <= frame.clientHeight + 1);
  assert(!frame.contentDocument.querySelector('img,script,iframe,form'));
  assert(!performance.getEntriesByType('resource').some((entry) => entry.name.includes('html-resource-probe')));
  assert(!frame.contentWindow.performance.getEntriesByType('resource').some((entry) => entry.name.includes('html-resource-probe')));
});
await test('Email styling cannot change the surrounding application document', async () => {
  const before = getComputedStyle(document.body).backgroundColor;
  const frame = await mount('<style>body{background:red}#summary{display:none}</style><div style="color:blue;position:fixed">Blue text</div>');
  assert(getComputedStyle(document.body).backgroundColor === before);
  assert(frame.contentWindow.getComputedStyle(frame.contentDocument.querySelector('div')).color === 'rgb(0, 0, 255)');
  assert(getComputedStyle(document.querySelector('#summary')).display !== 'none');
});
await test('Link clicks are intercepted for host confirmation rather than navigating the frame', async () => {
  const opened = [];
  const frame = await mount('<a href="https://example.test/destination">Visit</a><a href="javascript:alert(1)">Blocked</a>', (href) => opened.push(href));
  frame.contentDocument.querySelector('a[href]').click();
  assert(opened.length === 1 && opened[0] === 'https://example.test/destination');
  assert(frame.contentDocument.URL === 'about:srcdoc');
});
await test('Wide tables, long words, and preformatted text wrap on narrow screens without nested scrolling', async () => {
  fixture.style.width = '700px';
  const frame = await mount(`<table width="1200" style="width:1200px"><tr><td><strong>${'LongWord'.repeat(35)}</strong></td><td>Second column</td></tr></table><pre>${'UnbrokenCode'.repeat(30)}</pre>${'<p>Another paragraph with wrapping content and details.</p>'.repeat(20)}`);
  const wideHeight = frame.clientHeight;
  fixture.style.width = '280px';
  await wait(200);
  assert(frame.clientHeight > wideHeight);
  assert(frame.contentDocument.documentElement.scrollWidth <= frame.clientWidth + 1);
  assert(frame.contentDocument.documentElement.scrollHeight <= frame.clientHeight + 1);
});
await test('Rendering failures expose an explicit plain-text fallback instead of a blank message', () => {
  cleanup();
  fixture.innerHTML = '<div><iframe data-html-message="broken" sandbox="allow-same-origin"></iframe><div class="html-fallback" hidden><p role="status"></p><div>Plain fallback</div></div></div>';
  cleanup = mountHtmlMessages(fixture, [{ id: 'broken', bodyHtml: { toString() { throw new Error('Simulated rendering failure'); } } }], () => {});
  assert(fixture.querySelector('iframe').hidden);
  assert(!fixture.querySelector('.html-fallback').hidden);
  assert(fixture.querySelector('[role="status"]').textContent.includes('HTML rendering failed'));
});
await test('Image opt-in preserves approved sources without restoring event handlers, srcset, or CSS URLs', async () => {
  const content = fragment('<img src="https://images.example.test/opt-in-probe" srcset="https://images.example.test/extra 2x" alt="Logo" onerror="alert(1)" style="background:url(https://images.example.test/bg)">', { loadImages: true });
  const image = content.querySelector('img');
  assert(image.getAttribute('src') === 'https://images.example.test/opt-in-probe');
  assert(image.getAttribute('referrerpolicy') === 'no-referrer');
  assert(!image.hasAttribute('onerror') && !image.hasAttribute('srcset') && !image.style.backgroundImage && !image.style.cssText.includes('url('));
  await wait(50);
  assert(!performance.getEntriesByType('resource').some((entry) => entry.name.includes('opt-in-probe')), 'Sanitization must not fetch an image in the parent document');
});
await test('Remote image URLs reject local/IP destinations, credentials, executable schemes, and relative paths', () => {
  for (const source of ['http://localhost/a', 'http://host.local/a', 'http://192.168.0.1/a', 'http://127.1/a',
    'http://[::1]/a', 'http://router/a', 'https://user:pass@example.test/a', '/relative', 'javascript:alert(1)', 'file:///image.png', 'blob:https://example.test/1']) {
    assert(safeRemoteImage(source) === null, source);
  }
  assert(safeRemoteImage('//images.example.test/logo') === 'https://images.example.test/logo');
  assert(safeRemoteImage('https://images.example.test/logo') === 'https://images.example.test/logo');
});
await test('Embedded images permit recognized raster types and reject SVG and forged content types', () => {
  assert(safeEmbeddedImage(PNG) === PNG);
  assert(safeEmbeddedImage('data:image/svg+xml;base64,' + btoa('<svg onload="alert(1)"></svg>')) === null);
  assert(safeEmbeddedImage('data:image/png;base64,' + btoa('<svg></svg>')) === null);
  assert(safeEmbeddedImage('data:text/html;base64,' + btoa('<img>')) === null);
  const content = fragment(`<img src="${PNG}"><img src="cid:logo">`, { loadImages: true, inlineImages: new Map([['logo', PNG]]) });
  assert(content.querySelectorAll('img').length === 2);
});
await test('Image consent only relaxes the image policy, not scripts, forms, frames, or API access', () => {
  const html = createEmailDocument(`<img src="${PNG}">`, { loadImages: true });
  assert(html.includes('img-src https: http: data:'));
  for (const directive of ["script-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'"]) assert(html.includes(directive));
});
await test('Image permission can be scoped to one message without enabling its neighbor', async () => {
  cleanup();
  const row = id => `<div><iframe data-html-message="${id}" sandbox="allow-same-origin"></iframe><div class="html-fallback" hidden><p role="status"></p></div></div>`;
  fixture.innerHTML = row('allowed') + row('blocked');
  const messages = ['allowed', 'blocked'].map(id => ({ id, bodyHtml: `<img src="${PNG}" alt="Neighbor image">` }));
  cleanup = mountHtmlMessages(fixture, messages, () => {}, message => ({ loadImages: message.id === 'allowed' }));
  const frames = fixture.querySelectorAll('iframe');
  for (let attempt = 0; attempt < 100 && (!frames[0].style.height || !frames[1].style.height); attempt++) await wait(20);
  assert(frames[0].contentDocument.querySelector('img'));
  assert(!frames[1].contentDocument.querySelector('img') && frames[1].contentDocument.body.textContent.includes('Image blocked'));
});
await test('Opted-in images decode and resize the message; hiding returns to blocked placeholders', async () => {
  fixture.style.width = '280px';
  const html = `<p>A picture:</p><img src="${PNG}" alt="Test image"><p>After the image.</p>`;
  let frame = await mount(html, () => {}, { loadImages: true });
  for (let attempt = 0; attempt < 30 && !frame.contentDocument.querySelector('img')?.naturalWidth; attempt++) await wait(20);
  assert(frame.contentDocument.querySelector('img').naturalWidth === 120);
  await wait(80);
  assert(frame.contentDocument.documentElement.scrollHeight <= frame.clientHeight + 1);
  assert(frame.contentDocument.documentElement.scrollWidth <= frame.clientWidth + 1);
  frame = await mount(html);
  assert(!frame.contentDocument.querySelector('img') && frame.contentDocument.body.textContent.includes('Image blocked'));
});
await test('Failed image decoding gives a visible error instead of an empty broken image', async () => {
  const bad = 'data:image/png;base64,' + btoa('\x89PNG\r\n\x1a\ninvalid');
  const frame = await mount(`<img src="${bad}" alt="Unreadable picture">`, () => {}, { loadImages: true });
  for (let attempt = 0; attempt < 30 && !frame.contentDocument.body.textContent.includes('could not'); attempt++) await wait(20);
  assert(frame.contentDocument.body.textContent.includes('Image could not be loaded: Unreadable picture'));
});
await test('Gmail embedded images are fetched only by requested Content-ID using read-only provider URLs', async () => {
  const account = { id: 'gmail:test', provider: 'gmail' };
  const message = { accountId: account.id, remote: true, remoteId: 'mail/1', bodyHtml: '<img src="cid:logo%40example"><img src="cid:missing">' };
  const calls = [];
  const api = async (url) => {
    calls.push(url);
    return url.includes('/attachments/') ? { data: PNG_BYTES } : { payload: { parts: [
      { mimeType: 'image/png', headers: [{ name: 'Content-ID', value: ' <logo@example> ' }], body: { attachmentId: 'part/1', size: 1000 } },
      { mimeType: 'image/png', headers: [{ name: 'Content-ID', value: '<unrequested>' }], body: { attachmentId: 'secret', size: 1000 } },
    ] } };
  };
  const images = await loadInlineImages(message, account, api);
  assert(images.get('logo@example') === PNG && images.size === 1);
  assert(calls.length === 2 && calls[1].includes('/mail%2F1/attachments/part%2F1'));
  assert(inlineImageReferences(message.bodyHtml).size === 2);
});
await test('Outlook embedded-image lookup paginates, preserves immutable IDs, and skips unrelated/oversized files', async () => {
  const account = { id: 'outlook:test', provider: 'outlook' };
  const message = { accountId: account.id, remote: true, remoteId: 'mail1', bodyHtml: '<img src="cid:logo"><img src="cid:large">' };
  const calls = [];
  const api = async (url, headers) => {
    calls.push(url);
    assert(headers.Prefer.includes('ImmutableId'));
    if (url.endsWith('/file1')) return { contentType: 'image/png', contentBytes: PNG_BYTES };
    if (url.includes('page=2')) return { value: [{ id: 'file1', contentId: 'logo', contentType: 'image/png', size: 1000, isInline: true }] };
    return { value: [
      { id: 'other', contentId: 'unrequested', contentType: 'image/png', size: 1000, isInline: true },
      { id: 'huge', contentId: 'large', contentType: 'image/png', size: 11 * 1024 * 1024, isInline: true },
    ], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages/mail1/attachments?page=2' };
  };
  const images = await loadInlineImages(message, account, api);
  assert(images.get('logo') === PNG && images.size === 1 && calls.length === 3);
});
await test('Images without CID references never call provider APIs and cancelled loads stop immediately', async () => {
  let called = false;
  const api = async () => { called = true; throw new Error('Unexpected API request'); };
  const result = await loadInlineImages({ bodyHtml: `<img src="${PNG}">` }, null, api);
  assert(result.size === 0 && !called);
  const controller = new AbortController();
  controller.abort();
  let aborted = false;
  try { await loadInlineImages({ bodyHtml: '<img src="cid:logo">' }, null, api, controller.signal); }
  catch (error) { aborted = error.name === 'AbortError'; }
  assert(aborted && !called);
});
await test('Newsletter widths, borders, image dimensions, body background, and hidden preheaders are preserved', async () => {
  fixture.style.width = '600px';
  const frame = await mount(newsletterFixture, () => {}, { loadImages: true });
  const doc = frame.contentDocument;
  const css = element => frame.contentWindow.getComputedStyle(element);
  assert(doc.querySelector('.newsletter').getBoundingClientRect().width === 512);
  assert(doc.querySelector('.header-icons').getBoundingClientRect().width < 100, 'Auto-width nested tables must not become full width');
  const avatar = doc.querySelector('.avatar-photo');
  assert(avatar.getBoundingClientRect().width === 96 && avatar.getBoundingClientRect().height === 96);
  assert(css(avatar).borderRadius === '9999px');
  assert(doc.querySelector('img[height="25"]').getBoundingClientRect().height === 25);
  assert(css(doc.querySelector('.connect-button td')).borderTopStyle === 'solid');
  assert(css(doc.body).backgroundColor === 'rgb(243, 242, 240)');
  assert(doc.querySelector('.preheader').getBoundingClientRect().height === 0);
  assert(css(doc.querySelector('.full-width-button')).display === 'none');
});
await test('Newsletter media queries switch layouts on mobile without horizontal or internal vertical scrolling', async () => {
  fixture.style.width = '360px';
  const frame = await mount(newsletterFixture, () => {}, { loadImages: true });
  const doc = frame.contentDocument;
  assert(doc.querySelector('.newsletter').getBoundingClientRect().width === 360);
  assert(frame.contentWindow.getComputedStyle(doc.querySelector('.inline-button')).display === 'none');
  assert(frame.contentWindow.getComputedStyle(doc.querySelector('.full-width-button')).display === 'table');
  assert(doc.documentElement.scrollWidth <= frame.clientWidth + 1);
  assert(doc.documentElement.scrollHeight <= frame.clientHeight + 1);
});
await test('Stylesheets retain safe class/media rules and priorities but cannot load resources or escape the document', () => {
  const css = sanitizeEmailStylesheets([
    '@import url("/stylesheet-probe"); @font-face { font-family: remote; src: url("/font-probe"); }',
    '.card { width:512px; border:1px solid red; position:fixed; background-image:url("/background-probe"); }',
    '@media(max-width:480px){.mobile{display:table !important}}',
    '@media(min-height:10px){body{font-size:40px}}',
    '[title="</style><img src=/style-probe>"] { color:red }',
    '.bad { font-family:"</style><script>bad</script>"; }',
  ]);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const card = [...sheet.cssRules].find(rule => rule.selectorText === '.card');
  assert(card.style.width === '512px' && card.style.borderTopStyle === 'solid');
  assert(css.includes('display: table !important'));
  for (const forbidden of ['url(', '@import', '@font-face', 'position: fixed', 'min-height', '</style>', '<script>']) {
    assert(!css.includes(forbidden), forbidden);
  }
});
await test('Image failures offer an explicit user-driven retry without removing safe sizing', async () => {
  const bad = 'data:image/png;base64,' + btoa('\x89PNG\r\n\x1a\ninvalid');
  const frame = await mount(`<img src="${bad}" width="96" height="96" alt="Unavailable">`, () => {}, { loadImages: true });
  for (let attempt = 0; attempt < 50 && !frame.contentDocument.querySelector('button'); attempt++) await wait(20);
  const retry = frame.contentDocument.querySelector('button');
  assert(retry?.textContent === 'Retry image');
  retry.click();
  for (let attempt = 0; attempt < 50 && !frame.contentDocument.querySelector('button'); attempt++) await wait(20);
  assert(frame.contentDocument.body.textContent.includes('Image could not be loaded'));
});
await test('Author body heights cannot cause iframe resize feedback or clip the full message', async () => {
  const frame = await mount('<html><head><style>body{height:100% !important;max-height:10px !important;overflow:hidden !important}</style></head><body style="height:100% !important;padding:16px"><p>A short message.</p><p>Still visible.</p></body></html>');
  const height = frame.clientHeight;
  await wait(150);
  assert(height > 30 && height < 500 && frame.clientHeight === height);
  assert(frame.contentDocument.documentElement.scrollHeight <= frame.clientHeight + 1);
});
await test('Successful decoding is not treated as failure when intrinsic width is unavailable', async () => {
  cleanup();
  fixture.innerHTML = '<div><iframe data-html-message="dimensionless" sandbox="allow-same-origin"></iframe><div class="html-fallback" hidden><p role="status"></p></div></div>';
  const frame = fixture.querySelector('iframe');
  frame.addEventListener('load', () => {
    const image = frame.contentDocument?.querySelector('img');
    if (image) Object.defineProperty(image, 'naturalWidth', { get: () => 0 });
  });
  cleanup = mountHtmlMessages(fixture, [{ id: 'dimensionless', bodyHtml: `<img src="${PNG}" width="25" height="25" alt="Vector-like image">` }],
    () => {}, () => ({ loadImages: true }));
  for (let attempt = 0; attempt < 100 && !frame.style.height; attempt++) await wait(20);
  await wait(80);
  const image = frame.contentDocument.querySelector('img');
  assert(image && image.naturalWidth === 0 && image.getBoundingClientRect().height === 25);
  assert(!frame.contentDocument.body.textContent.includes('Image could not be loaded'));
});

cleanup();
fixture.remove();
for (const result of results) {
  const item = document.createElement('li');
  item.className = result.passed ? 'pass' : 'fail';
  item.textContent = `${result.passed ? 'PASS' : 'FAIL'}: ${result.name}${result.error ? ` — ${result.error}` : ''}`;
  document.querySelector('#results').append(item);
}
const failures = results.filter((result) => !result.passed);
document.querySelector('#summary').textContent = `${results.length - failures.length}/${results.length} checks passed.`;
document.title = failures.length ? 'FAIL — Gather HTML checks' : 'PASS — Gather HTML checks';
window.testResults = results;

const results = [];
const testDatabase = `gather-ui-test-${crypto.randomUUID()}`;
function assert(condition, name) {
  results.push({ name, passed: Boolean(condition) });
  if (!condition) throw new Error(name);
}

try {
  const response = await fetch('./index.html');
  if (!response.ok) throw new Error(`App could not load: HTTP ${response.status}`);
  const html = await response.text();
  const frame = document.querySelector('#preview');
  // Install storage before the app module runs so checks never touch real demo data.
  const storage = `<script>
    const values = new Map();
    Object.defineProperty(window, 'localStorage', { value: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key)
    } });
    const nativeIndexedDB = window.indexedDB;
    Object.defineProperty(window, 'indexedDB', { value: {
      open: (_name, version) => nativeIndexedDB.open('${testDatabase}', version)
    } });
  </script>`;
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('App frame did not load within 15 seconds.')), 15000);
    frame.addEventListener('load', () => { clearTimeout(timeout); resolve(); }, { once: true });
  });
  frame.srcdoc = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace('<head>', `<head>${storage}`);
  await loaded;
  const documentInFrame = frame.contentDocument;
  const saved = () => JSON.parse(frame.contentWindow.localStorage.getItem('gather-demo-v1'));
  const bubbles = () => documentInFrame.querySelectorAll('[data-chat-message]').length;
  const fill = (text) => {
    const input = documentInFrame.querySelector('#chat-reply');
    input.value = text;
    input.dispatchEvent(new frame.contentWindow.Event('input', { bubbles: true }));
  };
  const saveButton = () => documentInFrame.querySelector('#chat-reply-form [type="submit"]');
  assert(Boolean(saveButton()), 'Chat and Save reply button render');
  const initialCount = bubbles();
  const originalForm = documentInFrame.querySelector('#chat-reply-form');
  saveButton().click();
  assert(documentInFrame.querySelector('#chat-reply-form') === originalForm, 'Empty reply click leaves the form mounted for native validation');
  assert(!documentInFrame.querySelector('#chat-reply').validity.valid, 'Empty reply is rejected by native validation');
  assert(bubbles() === initialCount, 'Empty reply adds no message');
  fill('   ');
  saveButton().click();
  assert(documentInFrame.querySelector('#chat-reply-form .form-error').textContent.includes('Write a message'),
    'Whitespace reply click shows the inline error');
  assert(bubbles() === initialCount, 'Whitespace reply adds no message');
  fill('Reply saved through a real button click.');
  saveButton().click();
  assert(bubbles() === initialCount + 1, 'Clicking Save reply appends exactly one chat bubble');
  assert(saved().messages.at(-1).body === 'Reply saved through a real button click.', 'Button click persists the reply');
  assert(saved().messages.at(-1).to === 'maya.chen@example.com', 'Clicked reply goes to the conversation correspondent');
  assert(documentInFrame.querySelector('#chat-reply').value === '', 'Button click clears the reply draft');
  assert(documentInFrame.querySelector('[data-folder="inbox"]').getAttribute('aria-current') === 'page',
    'Button click keeps the conversation in the inbox');
  fill('Reply saved by clicking the button icon.');
  saveButton().querySelector('svg').dispatchEvent(new frame.contentWindow.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert(bubbles() === initialCount + 2, 'Clicking the nested send icon submits exactly once');
  assert(saved().messages.at(-1).body === 'Reply saved by clicking the button icon.', 'Icon click persists the reply');
  documentInFrame.querySelector('[data-action="back"]').click();
  documentInFrame.querySelector('[data-folder="sent"]').click();
  documentInFrame.querySelector('.message-card').click();
  assert(bubbles() === initialCount + 2, 'Clicked replies appear in the same conversation from Sent');
  const demoBefore = JSON.stringify(saved());
  const windowInFrame = frame.contentWindow;
  const waitFor = async (check) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error('Timed out waiting for UI update');
  };
  const click = (selector) => {
    const element = documentInFrame.querySelector(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    element.click();
  };
  click('[data-action="real-mode"]');
  await waitFor(() => documentInFrame.querySelector('.real-status'));
  assert(!documentInFrame.querySelector('.message-card'), 'Real mode starts empty rather than displaying demo mail');
  click('[data-action="connections"]');
  await waitFor(() => documentInFrame.querySelector('#connection-target').textContent);
  assert(documentInFrame.querySelector('#microsoft-redirect').textContent === new URL('./oauth-redirect.html', document.baseURI).href,
    'Microsoft setup displays the redirect URI on the current browser origin');
  const form = documentInFrame.querySelector('#connection-form');
  form.elements.clientId.value = 'not-a-client-id';
  click('#prepare-provider');
  await waitFor(() => documentInFrame.querySelector('#connection-feedback').classList.contains('form-error'));
  assert(documentInFrame.querySelector('#connection-feedback').textContent.includes('client ID'), 'Invalid OAuth client ID shows an error');
  let partialConsent = false, failContacts = false, denyToken = false, cancelAtMail = false, delayImage = false, folderRenamed = false, folderRemoved = false, rateLimitOnce = false;
  const imageCanvas = document.createElement('canvas');
  imageCanvas.width = 120; imageCanvas.height = 60;
  imageCanvas.getContext('2d').fillRect(0, 0, 120, 60);
  const imageData = imageCanvas.toDataURL('image/png');
  const requests = [];
  const sentCopies = [];
  let sendScenario = 'success', sendCalls = 0, releaseSend;
  const decodeMime = value => new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0)));
  windowInFrame.google = { accounts: { oauth2: {
    hasGrantedAllScopes: () => !partialConsent,
    initTokenClient: (options) => ({ requestAccessToken: () => options.callback({
      access_token: 'ui-test-token', expires_in: 3600,
    }) }),
  } } };
  const originalFetch = windowInFrame.fetch.bind(windowInFrame);
  windowInFrame.fetch = async (input, options = {}) => {
    const url = new URL(String(input), location.href);
    if (!['gmail.googleapis.com', 'people.googleapis.com'].includes(url.hostname)) return originalFetch(input, options);
    requests.push({ url: url.href, method: options.method });
    if (options.method === 'POST') {
      sendCalls++;
      if (!url.pathname.endsWith('/messages/send')) throw new Error('Unexpected mutation endpoint');
      if (sendScenario === 'reject') return new Response('{}', { status: 403 });
      if (sendScenario === 'unknown') throw new TypeError('Simulated lost response');
      if (sendScenario === 'wait') await new Promise(resolve => { releaseSend = resolve; });
      const payload = JSON.parse(options.body);
      const mime = decodeMime(payload.raw);
      const [headers, encodedBody] = mime.split('\r\n\r\n');
      const messageId = /^Message-ID: (.+)$/m.exec(headers)[1].trim();
      const clientSendId = /^X-Gather-Send-ID: (.+)$/m.exec(headers)[1].trim();
      const unfoldedHeaders = headers.replace(/\r\n[ \t]+/g, ' ');
      const to = /^To: (.+)$/m.exec(unfoldedHeaders)[1].trim();
      const cc = /^Cc: (.+)$/m.exec(unfoldedHeaders)?.[1].trim() || '';
      const subject = [...(/^Subject: ([\s\S]*?)\r\nDate:/m.exec(headers)[1]).matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map(part => decodeMime(part[1])).join('');
      const id = `sent-copy-${sentCopies.length + 1}`;
      const raw = {
        id, threadId: payload.threadId || `new-thread-${id}`, labelIds: ['SENT'], internalDate: String(Date.now()),
        payload: { mimeType: 'text/plain', body: { data: encodedBody.replace(/\r\n/g, '') }, headers: [
          { name: 'From', value: 'real-user@example.com' }, { name: 'To', value: to },
          { name: 'Cc', value: cc },
          { name: 'Subject', value: subject }, { name: 'Message-ID', value: messageId },
          { name: 'X-Gather-Send-ID', value: clientSendId },
        ] },
      };
      sentCopies.push(raw);
      return new Response(JSON.stringify({ id, threadId: raw.threadId }));
    }
    if (denyToken) return new Response('{}', { status: 401 });
    if (rateLimitOnce && url.pathname.endsWith('/profile')) {
      rateLimitOnce = false;
      return new Response(JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }), { status: 403 });
    }
    if (url.pathname.endsWith('/profile')) return new Response(JSON.stringify({ emailAddress: 'real-user@example.com', historyId: '100' }));
    if (url.pathname.endsWith('/labels')) return new Response(JSON.stringify({ labels: [
      ...['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD'].map(id => ({ id, name: id, type: 'system' })),
      { id: 'projects', name: 'Projects', type: 'user' },
      ...(folderRemoved ? [] : [{ id: 'nested', name: folderRenamed ? 'Projects/Renamed <team>' : 'Projects/Client <team>', type: 'user' }]),
      { id: 'empty', name: 'Empty folder', type: 'user' },
    ] }));
    if (url.pathname.endsWith('/messages')) {
      if (cancelAtMail) {
        click('#cancel-import');
        throw new DOMException('Cancelled', 'AbortError');
      }
      return new Response(JSON.stringify({ messages: [...['real-1', 'real-2', 'draft', 'spam', 'trash'].map(id => ({ id })), ...sentCopies.map(message => ({ id: message.id }))] }));
    }
    if (url.pathname.endsWith('/history')) return new Response(JSON.stringify({ history: [{ messages: sentCopies.map(message => ({ id: message.id })) }], historyId: '101' }));
    if (url.pathname.includes('/attachments/')) {
      if (delayImage) return new Promise((resolve, reject) => options.signal.addEventListener('abort',
        () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
      return new Response(JSON.stringify({ data: imageData.split(',')[1] }));
    }
    if (url.pathname.includes('/messages/')) {
      const special = url.pathname.split('/').at(-1);
      const sentCopy = sentCopies.find(message => message.id === special);
      if (sentCopy) return new Response(JSON.stringify(sentCopy));
      if (['draft', 'spam', 'trash'].includes(special)) return new Response(JSON.stringify({
        id: special, threadId: `thread-${special}`, labelIds: [special === 'draft' ? 'DRAFT' : special.toUpperCase()],
        internalDate: String(Date.now() - 5000),
        payload: { mimeType: 'text/plain', body: { data: btoa(`${special} content for folder checks`) }, headers: [
          ...(special === 'draft' ? [] : [{ name: 'From', value: 'Maya <maya@example.com>' }, { name: 'To', value: 'real-user@example.com' }]),
          { name: 'Subject', value: `A ${special} message` },
        ] },
      }));
      const sent = url.pathname.endsWith('/real-2');
      const body = btoa(sent ? 'An actual sent message, imported.' : `<h2>Provider HTML</h2><p>A private <strong>imported</strong> message.</p><a href="https://example.test/message">Read more</a><img src="${imageData}" alt="Embedded data image"><img src="cid:logo" alt="Provider image"><div class="protonmail_quote">-------- Original Message --------<blockquote>Earlier quoted content<div class="gmail_quote">Oldest quoted content</div></blockquote></div>`);
      return new Response(JSON.stringify({
        id: sent ? 'real-2' : 'real-1', threadId: 'actual-thread',
        labelIds: sent ? ['SENT'] : ['INBOX', 'UNREAD', 'projects', 'nested'], internalDate: String(Date.now() - (sent ? 1000 : 2000)),
        payload: { mimeType: sent ? 'text/plain' : 'text/html', body: { data: body }, parts: sent ? [] : [
          { mimeType: 'image/png', headers: [{ name: 'Content-ID', value: '<logo>' }], body: { attachmentId: 'image1', size: 1000 }, filename: 'logo.png' },
        ], headers: [
          { name: 'From', value: sent ? 'real-user@example.com' : 'Maya <maya@example.com>' },
          { name: 'To', value: sent ? 'maya@example.com' : 'real-user@example.com, teammate@example.com' },
          { name: 'Cc', value: sent ? '' : 'copied@example.com, TEAMMATE@example.com, real-user@example.com' },
          { name: 'Subject', value: sent ? 'Re: Provider thread' : 'Provider thread' },
          { name: 'Message-ID', value: sent ? '<real-2@example.com>' : '<real-1@example.com>' },
        ] },
      }));
    }
    if (url.hostname === 'people.googleapis.com') return failContacts ? new Response(JSON.stringify({
      error: { status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }], message: 'PRIVATE_DIAGNOSTIC' },
    }), { status: 403 })
      : new Response(JSON.stringify({ connections: [{ resourceName: 'people/1', names: [{ displayName: 'Maya' }], emailAddresses: [{ value: 'maya@example.com' }] }] }));
    throw new Error(`Unexpected API URL ${url}`);
  };
  form.elements.clientId.value = '123-test.apps.googleusercontent.com';
  click('#prepare-provider');
  await waitFor(() => !documentInFrame.querySelector('#connect-provider').hidden);
  assert(requests.length === 0, 'Preparing sign-in does not access mailbox APIs');
  partialConsent = true;
  click('#connect-provider');
  await waitFor(() => documentInFrame.querySelector('#connection-feedback').textContent.includes('Both read-only'));
  assert(requests.length === 0, 'Partial consent blocks mailbox access');
  partialConsent = false;
  click('#connect-provider');
  await waitFor(() => documentInFrame.querySelector('#connection-feedback').textContent.startsWith('Imported '));
  assert(documentInFrame.querySelectorAll('.connected-account').length === 1, 'Account connection imports and lists the real account');
  assert(JSON.stringify(saved()) === demoBefore, 'Real import leaves demo localStorage unchanged');
  assert(!windowInFrame.localStorage.getItem('gather-oauth-public-client-ids-v1').includes('token'), 'Only public client configuration is saved in localStorage');
  click('#close-accounts');
  const folderButton = path => [...documentInFrame.querySelectorAll('[data-provider-folder]')].find(button => button.title === path);
  assert(documentInFrame.querySelector('.sidebar .provider-folders'), 'Provider folder browser lives in the left pane');
  const folderTree = documentInFrame.querySelector('.provider-folders');
  const contactsLink = documentInFrame.querySelector('[data-folder="contacts"]');
  assert(Boolean(folderTree.compareDocumentPosition(contactsLink) & windowInFrame.Node.DOCUMENT_POSITION_FOLLOWING),
    'Folder tree appears before Contacts in the sidebar');
  assert([...documentInFrame.querySelectorAll('[data-toggle-folder-account]')].every(button => button.getAttribute('aria-expanded') === 'false'),
    'Every imported account starts collapsed');
  assert(folderButton('Inbox').getClientRects().length === 0, 'Collapsed account hides its folder list');
  click('[data-toggle-folder-account]');
  assert(documentInFrame.querySelector('[data-toggle-folder-account]').getAttribute('aria-expanded') === 'true'
    && folderButton('Inbox').getClientRects().length > 0, 'Account chevron reveals top-level folders');
  assert(documentInFrame.activeElement.matches('[data-toggle-folder-account]'), 'Account toggle retains keyboard focus after rendering');
  assert(['Inbox', 'Sent', 'Drafts', 'Spam', 'Trash', 'Projects', 'Projects/Client <team>', 'Empty folder'].every(path => folderButton(path)),
    'All provider labels, nested labels, drafts, spam, trash, and empty folders appear');
  assert(folderButton('Projects/Client <team>').closest('.provider-folder-row').style.getPropertyValue('--folder-depth') === '1', 'Nested label is indented under its parent');
  assert(folderButton('Projects/Client <team>').getClientRects().length === 0, 'Nested folder branch starts collapsed');
  const toggleProject = () => folderButton('Projects').closest('.provider-folder-row').querySelector('[data-toggle-provider-folder]').click();
  toggleProject();
  assert(folderButton('Projects/Client <team>').getClientRects().length > 0, 'Parent chevron reveals nested folders');
  assert(documentInFrame.activeElement.matches('[data-toggle-provider-folder]'), 'Nested toggle retains keyboard focus');
  assert(folderButton('Inbox').querySelector('.provider-folder-count').textContent === '1', 'Folder badge counts cached matching messages');
  folderButton('Projects/Client <team>').click();
  assert(documentInFrame.querySelector('.breadcrumb strong').textContent === 'Projects/Client <team>', 'Custom folder title is escaped and shown in breadcrumb');
  assert(documentInFrame.querySelectorAll('.message-card').length === 1, 'Selecting a custom label filters by actual provider membership');
  assert(documentInFrame.querySelector('[data-provider-folder][aria-current="page"]').title === 'Projects/Client <team>', 'Selected provider label is highlighted');
  toggleProject();
  assert(folderButton('Projects/Client <team>').getClientRects().length === 0, 'Parent chevron collapses its descendants');
  assert(documentInFrame.querySelector('.breadcrumb strong').textContent === 'Projects/Client <team>'
    && documentInFrame.querySelectorAll('.message-card').length === 1, 'Collapsing a branch preserves the current folder selection and messages');
  toggleProject();
  click('[data-toggle-folder-account]');
  assert(folderButton('Projects').getClientRects().length === 0, 'Account chevron collapses the entire folder tree');
  click('[data-toggle-folder-account]');
  assert(folderButton('Projects/Client <team>').getClientRects().length > 0, 'Reopening an account preserves expanded nested branches');
  click('[data-folder="contacts"]');
  assert(folderButton('Projects/Client <team>').getClientRects().length > 0, 'Tree expansion survives navigation to Contacts');
  folderButton('Projects/Client <team>').click();
  click('.message-card');
  assert(bubbles() === 2, 'Custom label opens the complete received and sent thread');
  click('[data-action="back"]');
  folderButton('Drafts').click();
  click('.message-card');
  assert(documentInFrame.querySelector('.chat-message-footer').textContent.includes('Draft · Not sent'), 'Draft is explicitly marked not sent');
  assert(documentInFrame.querySelector('.chat-addresses').textContent.includes('No recipient yet'), 'Recipient-less drafts remain readable');
  assert(!documentInFrame.querySelector('#chat-reply-form'), 'Draft view cannot send or modify provider drafts');
  click('[data-action="back"]');
  folderButton('Spam').click();
  assert(documentInFrame.querySelector('.message-card').textContent.includes('spam message'), 'Spam label displays its synced mail');
  folderButton('Trash').click();
  assert(documentInFrame.querySelector('.message-card').textContent.includes('trash message'), 'Trash label displays its synced mail');
  folderButton('Empty folder').click();
  assert(!documentInFrame.querySelector('.message-card') && documentInFrame.querySelector('.empty-state'), 'Empty provider folders remain selectable');
  click('[data-folder="inbox"]');
  assert(documentInFrame.querySelectorAll('.message-card').length === 1, 'Imported inbox groups received and sent mail by provider thread');
  click('.message-card');
  assert(bubbles() === 2, 'Real conversation displays imported received and sent messages');
  await waitFor(() => documentInFrame.querySelector('.html-message')?.contentDocument?.querySelector('strong')
    && documentInFrame.querySelector('.html-message').style.height);
  let htmlFrame = documentInFrame.querySelector('.html-message');
  assert(htmlFrame.contentDocument.querySelector('strong').textContent === 'imported', 'Imported HTML renders formatting inside an isolated frame');
  assert(!htmlFrame.contentDocument.body.textContent.includes('Earlier quoted content'), 'Conversation hides nested reply history by default');
  assert(documentInFrame.querySelector('[data-action="toggle-quotes"]').getAttribute('aria-expanded') === 'false', 'Quoted-history control starts collapsed');
  click('[data-action="toggle-quotes"]');
  await waitFor(() => documentInFrame.querySelector('.html-message')?.contentDocument?.body?.textContent.includes('Oldest quoted content'));
  assert(documentInFrame.querySelector('[data-action="toggle-quotes"]').textContent === 'Hide quoted text', 'Quote control restores the complete nested history');
  click('[data-action="toggle-html"]');
  assert(documentInFrame.querySelector('.incoming .message-body').textContent.includes('Earlier quoted content'), 'Expanded history remains visible when switching to plain text');
  click('[data-action="toggle-quotes"]');
  assert(!documentInFrame.querySelector('.incoming .message-body').textContent.includes('Earlier quoted content'), 'Collapsing hides history in plain-text mode');
  click('[data-action="toggle-html"]');
  await waitFor(() => documentInFrame.querySelector('.html-message')?.contentDocument?.querySelector('strong'));
  htmlFrame = documentInFrame.querySelector('.html-message');
  assert(!htmlFrame.contentDocument.body.textContent.includes('Earlier quoted content'), 'Collapsed history stays hidden after switching back to HTML');
  assert(htmlFrame.sandbox.value === 'allow-same-origin', 'HTML frame cannot run scripts, forms, or navigate the app');
  assert(!htmlFrame.contentDocument.querySelector('img') && htmlFrame.contentDocument.body.textContent.includes('Image blocked'),
    'Imported HTML blocks images by default');
  const originalConfirm = windowInFrame.confirm;
  const originalOpen = windowInFrame.open;
  let confirmed = '', opened = null;
  windowInFrame.confirm = message => { confirmed = message; return false; };
  windowInFrame.open = (...args) => { opened = args; };
  htmlFrame.contentDocument.querySelector('a[href]').click();
  assert(confirmed.includes('https://example.test/message') && opened === null, 'Cancelling an email link confirmation leaves the destination unopened');
  windowInFrame.confirm = () => true;
  htmlFrame.contentDocument.querySelector('a[href]').click();
  assert(opened[0] === 'https://example.test/message' && opened[2] === 'noopener,noreferrer',
    'Confirmed email link opens separately without opener or referrer');
  windowInFrame.confirm = originalConfirm;
  windowInFrame.open = originalOpen;
  const beforeImageRequests = requests.length;
  let imageWarning = '';
  windowInFrame.confirm = message => { imageWarning = message; return false; };
  click('[data-action="load-images"]');
  assert(imageWarning.includes('IP address') && imageWarning.includes('not saved'), 'Image loading asks for explicit per-message privacy consent');
  assert(requests.length === beforeImageRequests && !htmlFrame.contentDocument.querySelector('img'),
    'Declining images makes no provider requests and keeps images blocked');
  windowInFrame.confirm = () => true;
  click('[data-action="load-images"]');
  await waitFor(() => documentInFrame.querySelector('.html-message')?.contentDocument?.querySelectorAll('img').length === 2
    && [...documentInFrame.querySelector('.html-message').contentDocument.querySelectorAll('img')].every(image => image.naturalWidth === 120));
  assert(requests.some(request => request.url.includes('/attachments/image1')), 'Approved CID image is fetched from its provider');
  assert(documentInFrame.querySelector('[data-action="hide-images"]'), 'Approved message exposes Hide images');
  assert(JSON.stringify(saved()) === demoBefore, 'Image permissions and bytes are not written into demo storage');
  click('[data-action="hide-images"]');
  await waitFor(() => documentInFrame.querySelector('.html-message')?.contentDocument?.body?.textContent.includes('Image blocked'));
  assert(!documentInFrame.querySelector('.html-message').contentDocument.querySelector('img'), 'Hide images returns to blocked rendering');
  denyToken = true;
  click('[data-action="load-images"]');
  await waitFor(() => documentInFrame.querySelector('.image-status.form-error'));
  assert(documentInFrame.querySelector('.image-status').textContent.includes('Reconnect'), 'Expired authorization for embedded images is surfaced with reconnect guidance');
  denyToken = false;
  click('[data-action="hide-images"]');
  delayImage = true;
  const beforeSlow = requests.filter(request => request.url.includes('/attachments/')).length;
  click('[data-action="load-images"]');
  await waitFor(() => requests.filter(request => request.url.includes('/attachments/')).length > beforeSlow);
  click('[data-action="hide-images"]');
  await waitFor(() => documentInFrame.querySelector('.html-message')?.contentDocument?.body?.textContent.includes('Image blocked'));
  assert(!documentInFrame.querySelector('[data-action="hide-images"]') && !documentInFrame.querySelector('.image-status'),
    'Hiding images cancels an in-flight attachment load without restoring stale images');
  delayImage = false;
  click('[data-action="load-images"]');
  await waitFor(() => documentInFrame.querySelector('.html-message')?.contentDocument?.querySelectorAll('img').length === 2);
  click('[data-action="demo-mode"]');
  click('[data-action="real-mode"]');
  await waitFor(() => documentInFrame.querySelector('.message-card'));
  click('.message-card');
  await waitFor(() => documentInFrame.querySelector('.html-message')?.contentDocument?.body?.textContent.includes('Image blocked'));
  assert(!documentInFrame.querySelector('[data-action="hide-images"]'), 'Switching mailboxes clears per-message image permission');
  windowInFrame.confirm = originalConfirm;
  click('[data-action="toggle-html"]');
  assert(!documentInFrame.querySelector('.html-message') && documentInFrame.querySelector('.incoming .message-body').textContent.includes('A private imported message.'),
    'Plain-text toggle shows the searchable fallback without HTML');
  click('[data-action="toggle-html"]');
  await waitFor(() => documentInFrame.querySelector('.html-message')?.contentDocument?.querySelector('strong'));
  assert(documentInFrame.querySelector('.html-message'), 'HTML toggle restores the formatted view');
  assert(documentInFrame.querySelector('#chat-reply-form [type="submit"]').textContent.includes('Send reply'),
    'Authorized real conversations expose Send reply, not demo Save reply');
  assert(!documentInFrame.querySelector('[data-action="archive"]') && !documentInFrame.querySelector('[data-action="star"]'), 'Real conversation has no mutation controls');
  assert(documentInFrame.querySelector('.outgoing').textContent.includes('Sent · Imported from provider'), 'Real sent messages are not mislabeled as demo replies');
  assert(documentInFrame.querySelector('.incoming').textContent.includes('Unread'), 'Reading real mail does not alter provider read flags');
  assert(requests.every((request) => request.method === 'GET'), 'Real-mail integration only makes read requests');
  click('[data-action="back"]');
  if (windowInFrame.navigator.locks) {
    let acquired, release;
    const ready = new Promise(resolve => { acquired = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const lock = navigator.locks.request('gather-mail-sync:gmail:real-user@example.com', async () => {
      acquired();
      await hold;
    });
    await ready;
    const countBeforeLock = requests.length;
    try {
      click('[data-action="sync"]');
      await waitFor(() => documentInFrame.querySelector('.real-status').textContent.includes('another Gather tab'));
      assert(requests.length === countBeforeLock, 'Another tab holding the account lock prevents duplicate sync API requests');
    } finally { release(); await lock; }
  }
  rateLimitOnce = true;
  click('[data-action="sync"]');
  await waitFor(() => documentInFrame.querySelector('.real-status').textContent.includes('Waiting 5 seconds'));
  assert(documentInFrame.querySelector('[data-action="cancel-real-sync"]'), 'Gmail backoff is visible and exposes a cancellation control');
  await new Promise(resolve => setTimeout(resolve, 5200));
  await waitFor(() => !documentInFrame.querySelector('[data-action="sync"]').disabled);
  assert(documentInFrame.querySelector('.real-status').textContent.includes('Synced 1 account'),
    'Sync recovers from a transient Gmail rate limit without another consent prompt');
  folderButton('Projects/Client <team>').click();
  folderRenamed = true;
  click('[data-action="sync"]');
  await waitFor(() => folderButton('Projects/Renamed <team>') && !documentInFrame.querySelector('[data-action="sync"]').disabled);
  assert(documentInFrame.querySelector('.breadcrumb strong').textContent === 'Projects/Renamed <team>', 'Folder rename sync preserves selection by stable provider ID');
  assert(folderButton('Projects/Renamed <team>').getClientRects().length > 0
    && documentInFrame.querySelector('[data-toggle-folder-account]').getAttribute('aria-expanded') === 'true',
    'Account and branch expansion survive a folder rename and sync');
  folderRemoved = true;
  click('[data-action="sync"]');
  await waitFor(() => !folderButton('Projects/Renamed <team>') && !documentInFrame.querySelector('[data-action="sync"]').disabled);
  assert(documentInFrame.querySelector('[data-folder="inbox"]').getAttribute('aria-current') === 'page', 'Deleted folder is removed and selection safely returns to Inbox');
  assert(!folderButton('Projects/Renamed <team>'), 'Removed provider labels do not remain in the sidebar');
  frame.style.width = '390px';
  await new Promise(resolve => setTimeout(resolve, 80));
  assert(documentInFrame.documentElement.scrollWidth <= windowInFrame.innerWidth, 'Provider folders and long names fit the mobile sidebar');
  frame.style.width = '1200px';
  click('[data-folder="contacts"]');
  assert(documentInFrame.querySelectorAll('.contact-tile').length === 1, 'Imported contacts are available');
  assert(!documentInFrame.querySelector('[data-edit-contact]') && documentInFrame.querySelector('[data-write]'), 'Imported contacts remain read-only but their addresses open the composer');
  failContacts = true;
  click('[data-action="sync"]');
  await waitFor(() => documentInFrame.querySelector('.real-status.storage-error'));
  assert(documentInFrame.querySelectorAll('.contact-tile').length === 1, 'Failed contact sync preserves the cached contacts');
  assert(documentInFrame.querySelector('.real-status').textContent.includes('Google People API (contacts sync)')
    && documentInFrame.querySelector('.real-status').textContent.includes('enable People API')
    && documentInFrame.querySelector('.real-status').textContent.includes('SERVICE_DISABLED'),
    'Gmail contact-sync denial identifies People API and gives the correct enablement action');
  assert(!documentInFrame.querySelector('.real-status').textContent.includes('PRIVATE_DIAGNOSTIC'),
    'Provider diagnostics do not display raw response messages');
  failContacts = false;
  denyToken = true;
  click('[data-action="sync"]');
  await waitFor(() => documentInFrame.querySelector('.real-status').textContent.includes('expired'));
  assert(documentInFrame.querySelector('.real-status').textContent.includes('Reconnect'), 'Expired authorization displays actionable reconnect guidance');
  denyToken = false;
  click('[data-action="connections"]');
  await waitFor(() => documentInFrame.querySelector('[data-reconnect]') && !documentInFrame.querySelector('[data-reconnect]').disabled);
  click('[data-reconnect]');
  form.elements.days.value = '7';
  form.elements.days.dispatchEvent(new windowInFrame.Event('change', { bubbles: true }));
  click('#prepare-provider');
  await waitFor(() => !documentInFrame.querySelector('#connect-provider').hidden);
  cancelAtMail = true;
  click('#connect-provider');
  await waitFor(() => documentInFrame.querySelector('#connection-feedback').textContent.includes('cancelled'));
  assert(documentInFrame.querySelectorAll('.connected-account').length === 1, 'Cancelled replacement import preserves the existing cached account');
  cancelAtMail = false;
  click('#close-accounts');
  click('[data-folder="inbox"]');
  click('.message-card');
  const sendConfirm = windowInFrame.confirm;
  const countBeforeSending = bubbles();
  const replyLabel = documentInFrame.querySelector('label[for="chat-reply"]').textContent;
  assert(replyLabel.includes('Reply to all') && replyLabel.includes('maya@example.com') && replyLabel.includes('teammate@example.com')
    && replyLabel.includes('Cc: copied@example.com') && !replyLabel.includes('real-user@example.com'),
    'Reply form defaults to all original To/Cc participants except the sending address');
  const shortGap = documentInFrame.querySelector('#chat-reply-form').getBoundingClientRect().top
    - documentInFrame.querySelector('.chat-message:last-child').getBoundingClientRect().bottom;
  assert(shortGap >= 0 && shortGap <= 24, 'Short conversation places its reply form immediately after the last message');
  fill('A real reply from Gather.');
  let replyConfirmation = '';
  windowInFrame.confirm = text => { replyConfirmation = text; return false; };
  saveButton().click();
  assert(sendCalls === 0 && documentInFrame.querySelector('#chat-reply').value === 'A real reply from Gather.',
    'Declining real-send confirmation preserves the draft and makes no send request');
  assert(replyConfirmation.includes('Reply to all') && replyConfirmation.includes('To: maya@example.com, teammate@example.com')
    && replyConfirmation.includes('Cc: copied@example.com'), 'Send confirmation lists the actual To and Cc recipients');
  windowInFrame.confirm = () => true;
  sendScenario = 'wait';
  saveButton().click();
  await waitFor(() => Boolean(releaseSend));
  const inFlightCalls = sendCalls;
  documentInFrame.querySelector('#chat-reply-form').requestSubmit();
  assert(sendCalls === inFlightCalls && documentInFrame.querySelector('#chat-reply-form [type="submit"]').disabled,
    'Duplicate submit while sending cannot send a second email');
  releaseSend();
  await waitFor(() => documentInFrame.querySelector('.chat-message:last-child').textContent.includes('Accepted by provider')
    && !documentInFrame.querySelector('#chat-reply-form [type="submit"]').disabled);
  assert(bubbles() === countBeforeSending + 1 && documentInFrame.querySelector('#chat-reply').value === '',
    'Accepted real reply appears immediately in the same conversation and clears the draft');
  assert(documentInFrame.querySelector('[data-folder="inbox"]').getAttribute('aria-current') === 'page',
    'Real reply does not navigate away from inbox');
  assert(sentCopies[0].threadId === 'actual-thread', 'Real reply sends the existing provider thread ID');
  assert(sentCopies[0].payload.headers.find(header => header.name === 'To').value === 'maya@example.com, teammate@example.com'
    && sentCopies[0].payload.headers.find(header => header.name === 'Cc').value === 'copied@example.com',
    'Reply-all addresses reach the actual send payload with Cc preserved');
  sendScenario = 'success';
  click('[data-action="sync"]');
  await waitFor(() => !documentInFrame.querySelector('[data-action="sync"]').disabled);
  assert(bubbles() === countBeforeSending + 1 && !documentInFrame.querySelector('.chat-message:last-child').textContent.includes('pending sync'),
    'Sync replaces the local send record with one provider copy without duplicate bubbles');
  sendScenario = 'reject';
  fill('A rejected send remains editable.');
  saveButton().click();
  await waitFor(() => documentInFrame.querySelector('#chat-reply-form .form-error').textContent.includes('rejected'));
  assert(documentInFrame.querySelector('#chat-reply').value === 'A rejected send remains editable.', 'Rejected sending retains the reply draft');
  assert(documentInFrame.querySelector('.chat-message:last-child').textContent.includes('Send rejected'), 'Rejected messages are not labeled sent');
  sendScenario = 'unknown';
  fill('A send with an uncertain outcome.');
  saveButton().click();
  await waitFor(() => documentInFrame.querySelector('#chat-reply-form .form-error').textContent.includes('may already'));
  const uncertainCalls = sendCalls;
  saveButton().click();
  await waitFor(() => documentInFrame.querySelector('#chat-reply-form .form-error').textContent.includes('identical send'));
  assert(sendCalls === uncertainCalls, 'An identical uncertain send is blocked instead of automatically resubmitted');
  const unknownBubble = [...documentInFrame.querySelectorAll('.chat-message')].find(element => element.textContent.includes('Send status unknown'));
  unknownBubble.querySelector('[data-action="remove-send-attempt"]').click();
  await waitFor(() => ![...documentInFrame.querySelectorAll('.chat-message')].some(element => element.textContent.includes('Send status unknown')));
  assert(sendCalls === uncertainCalls, 'Removing a confirmed local attempt does not send or recall any provider email');
  sendScenario = 'success';
  click('[data-action="compose"]');
  const composeForm = documentInFrame.querySelector('#compose-form');
  composeForm.elements.to.value = 'new-person@example.com';
  composeForm.elements.subject.value = 'A new real conversation';
  composeForm.elements.body.value = 'A new email from Gather.';
  composeForm.querySelector('[type="submit"]').click();
  await waitFor(() => !documentInFrame.querySelector('#compose-dialog').open);
  assert(documentInFrame.querySelector('[data-folder="sent"]').getAttribute('aria-current') === 'page'
    && documentInFrame.querySelector('.subject-heading').textContent === 'A new real conversation',
    'New real email opens in Sent as a new conversation');
  assert(documentInFrame.querySelector('.chat-message').textContent.includes('Accepted by provider'),
    'New email is labeled provider-accepted, not delivered');
  assert(JSON.stringify(saved()) === demoBefore, 'Real sending never writes into demo localStorage');
  windowInFrame.confirm = sendConfirm;
  click('[data-action="connections"]');
  await waitFor(() => documentInFrame.querySelector('[data-remove-account]') && !documentInFrame.querySelector('[data-remove-account]').disabled);
  const confirmOriginal = windowInFrame.confirm;
  windowInFrame.confirm = () => true;
  click('[data-remove-account]');
  await waitFor(() => !documentInFrame.querySelector('.connected-account'));
  windowInFrame.confirm = confirmOriginal;
  click('#close-accounts');
  assert(!documentInFrame.querySelector('.contact-tile'), 'Removing local account data removes its imported contacts');
  assert(!documentInFrame.querySelector('[data-action="sync"]').disabled, 'Account removal releases the busy state so sync stays usable');
  click('[data-action="demo-mode"]');
  assert(documentInFrame.querySelectorAll('.message-card').length === 7, 'Switching back restores the demo inbox');
  assert(JSON.stringify(saved()) === demoBefore, 'Connection, failed sync, cancellation, and removal leave demo data unchanged');
  click('[data-message="m5"]');
  await waitFor(() => documentInFrame.querySelector('.html-message')?.contentDocument?.querySelector('blockquote'));
  assert(documentInFrame.querySelector('.html-message').contentDocument.querySelector('em').textContent === 'landscape photography',
    'Fresh demo data includes a formatted HTML conversation');
  click('[data-message="m1"]');
  const spacedBody = '  A   tidier\u00a0\u00a0reply.  \r\n \t\r\n\r\n\r\nAnother    paragraph.  \r\n';
  fill(spacedBody);
  saveButton().click();
  assert(documentInFrame.querySelector('.chat-message:last-child .message-body').textContent === 'A tidier reply.\n\nAnother paragraph.',
    'Plain-text chat bubbles remove extra spaces and blank lines');
  assert(saved().messages.at(-1).body.includes('Another    paragraph.'),
    'Display cleanup does not rewrite the original saved message');
  assert(documentInFrame.querySelector('.message-card.selected .message-preview').textContent === 'You: A tidier reply. Another paragraph.',
    'Conversation preview uses compact whitespace');
  fill(Array.from({ length: 60 }, (_, index) => `Long conversation line ${index + 1}.`).join('\n'));
  saveButton().click();
  async function checkFullHeight(width) {
    frame.style.width = `${width}px`;
    frame.style.height = '700px';
    await new Promise((resolve) => setTimeout(resolve, 80));
    const timeline = documentInFrame.querySelector('.chat-timeline');
    const lastMessage = documentInFrame.querySelector('.chat-message:last-child');
    const rect = timeline.getBoundingClientRect();
    assert(windowInFrame.getComputedStyle(timeline).overflowY === 'visible',
      `${width}px conversation uses page scrolling instead of internal scrolling`);
    assert(timeline.scrollHeight <= timeline.clientHeight + 1 && rect.height > 1000,
      `${width}px conversation expands to contain the complete long message`);
    assert(lastMessage.getBoundingClientRect().bottom <= rect.bottom + 1,
      `${width}px last message is not clipped`);
    assert(documentInFrame.querySelector('#chat-reply-form').getBoundingClientRect().top >= lastMessage.getBoundingClientRect().bottom,
      `${width}px reply box follows the full message history`);
    assert(documentInFrame.querySelector('#chat-reply-form').getBoundingClientRect().top - lastMessage.getBoundingClientRect().bottom <= 24,
      `${width}px reply box has no flex-grown gap after the last message`);
    assert(documentInFrame.documentElement.scrollHeight > windowInFrame.innerHeight,
      `${width}px browser page scrolls for long conversations`);
    assert(documentInFrame.documentElement.scrollWidth <= windowInFrame.innerWidth,
      `${width}px layout has no horizontal overflow`);
    click('[data-action="back"]');
    const list = documentInFrame.querySelector('.group-list');
    assert(list.scrollHeight <= list.clientHeight + 1 && windowInFrame.getComputedStyle(list).overflowY === 'visible',
      `${width}px topic list displays fully without an internal scrollbar`);
    click('[data-message="m1"]');
    click('[data-message="m3"]');
    const shortReply = documentInFrame.querySelector('#chat-reply-form');
    const shortMessage = documentInFrame.querySelector('.chat-message:last-child');
    assert(shortReply.getBoundingClientRect().top - shortMessage.getBoundingClientRect().bottom <= 24,
      `${width}px short-thread reply stays close even beside a taller message list`);
    click('[data-message="m1"]');
  }
  await checkFullHeight(1200);
  await checkFullHeight(390);
} catch (error) {
  if (!results.some((result) => !result.passed)) {
    const doc = document.querySelector('#preview')?.contentDocument;
    const detail = [...(doc?.querySelectorAll('.form-error, .real-status') || [])].map(element => element.textContent).filter(Boolean).join(' | ');
    results.push({ name: `${error.message}${detail ? ` (${detail})` : ''}`, passed: false });
  }
} finally {
  document.querySelector('#preview').remove();
  await new Promise((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase(testDatabase);
    deletion.onsuccess = resolve;
    deletion.onerror = () => reject(deletion.error);
  });
}

for (const result of results) {
  const item = document.createElement('li');
  item.className = result.passed ? 'pass' : 'fail';
  item.textContent = `${result.passed ? 'PASS' : 'FAIL'}: ${result.name}`;
  document.querySelector('#results').append(item);
}
const failures = results.filter((result) => !result.passed);
document.querySelector('#summary').textContent = `${results.length - failures.length}/${results.length} checks passed.`;
document.title = failures.length ? 'FAIL — Gather UI checks' : 'PASS — Gather UI checks';
window.testResults = results;

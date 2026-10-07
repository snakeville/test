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
  const windowInFrame = frame.contentWindow;
  const waitFor = async (check) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error('Timed out waiting for UI update');
  };
  const changeSelect = (selector, value) => {
    const input = documentInFrame.querySelector(selector);
    input.value = value;
    input.dispatchEvent(new windowInFrame.Event('change', { bubbles: true }));
  };
  const click = (selector) => {
    let element = documentInFrame.querySelector(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    if (element.matches('[data-message]')) {
      const group = element.closest('.group-messages');
      if (group?.hidden) {
        const id = element.dataset.message;
        group.closest('.contact-group').querySelector('[data-group]').click();
        element = [...documentInFrame.querySelectorAll('[data-message]')].find(button => button.dataset.message === id);
      }
    }
    element.click();
  };
  const chooseFolder = (id) => {
    const virtual = documentInFrame.querySelector(`[data-folder="${id}"]`);
    if (virtual) { virtual.click(); return; }
    const names = { inbox: 'Inbox', sent: 'Sent', archive: 'Archive' };
    const provider = [...documentInFrame.querySelectorAll('[data-provider-folder]')].find(button => button.title === names[id]);
    if (!provider) throw new Error(`Missing folder ${id}`);
    provider.click();
  };
  const chooseMode = (mode) => {
    if (!documentInFrame.querySelector('.welcome-screen')) click('a[data-home]');
    click(`[data-action="enter-${mode}"]`);
  };
  frame.style.width = '1200px';
  await new Promise(resolve => setTimeout(resolve, 60));
  assert(documentInFrame.querySelector('#app').dataset.stage === 'home'
    && documentInFrame.querySelector('.welcome-screen'), 'Root page opens on the clean welcome screen');
  assert(documentInFrame.querySelectorAll('.welcome-choice').length === 2, 'Welcome offers two large Demo and Real mail choices');
  assert(documentInFrame.querySelector('#demo-choice-description').textContent.includes('No sign-in')
    && documentInFrame.querySelector('#real-choice-description').textContent.includes('Gmail or Outlook'),
    'Each mailbox choice has a clear description');
  assert(!documentInFrame.querySelector('.sidebar, .topbar, .message-list, .real-status'),
    'Welcome does not expose mailbox navigation or message data');
  assert(documentInFrame.querySelector('.welcome-choice').getBoundingClientRect().height >= 230, 'Mailbox choice buttons have a generous touch target');
  click('[data-action="enter-demo"]');
  assert(!documentInFrame.querySelector('.breadcrumb, .mode-switch, .account-item'), 'Legacy breadcrumbs, mode switch, and account lists are removed');
  assert(!documentInFrame.querySelector('#mailbox-mode') && documentInFrame.querySelector('.sidebar #account-select'),
    'Mailbox dropdown is removed while account selection stays in the sidebar');
  assert(documentInFrame.querySelector('#account-select').value === 'gmail', 'Demo selects the first account rather than mixing mailboxes');
  assert([...documentInFrame.querySelectorAll('[data-group]')].every(button => button.getAttribute('aria-expanded') === 'false'),
    'Conversation groups start collapsed');
  assert(!documentInFrame.querySelector('.chat-reader'), 'No conversation is selected automatically');
  const rect = selector => documentInFrame.querySelector(selector).getBoundingClientRect();
  const visible = element => Boolean(element?.checkVisibility({ checkVisibilityCSS: true }));
  assert(rect('.brand-row').left < rect('.topbar').left && rect('.sidebar').left < rect('.main').left,
    'Wide layout places logo and navigation on the left and toolbar and conversations on the right');
  assert(visible(documentInFrame.querySelector('.topbar .desktop-compose'))
    && !visible(documentInFrame.querySelector('.mobile-compose')), 'Wide toolbar contains New message rather than breadcrumbs');
  assert(rect('#account-select').top < rect('.provider-folders').top
    && rect('.provider-folders').bottom <= rect('.contacts-nav').top,
    'Sidebar order is account dropdown, folders, then Contacts');
  assert(documentInFrame.querySelectorAll('.message-card').length === 5
    && ![...documentInFrame.querySelectorAll('.message-card')].some(visible), 'Selected-account list is collapsed by default');
  click('[data-audience="unknown"]');
  assert(documentInFrame.querySelectorAll('.message-card').length === 2
    && documentInFrame.querySelector('[data-audience="unknown"]').getAttribute('aria-selected') === 'true',
    'Unknown senders tab filters only the current account and folder');
  documentInFrame.querySelector('[data-audience="unknown"]').dispatchEvent(new windowInFrame.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert(documentInFrame.querySelector('[data-audience="contacts"]').getAttribute('aria-selected') === 'true',
    'Sender tabs support keyboard navigation');
  changeSelect('#account-select', 'outlook');
  assert(documentInFrame.querySelectorAll('.message-card').length === 2
    && documentInFrame.querySelector('#account-select').value === 'outlook', 'Changing account shows only that account’s conversations');
  changeSelect('#account-select', 'gmail');
  chooseFolder('sent');
  assert(documentInFrame.querySelectorAll('.message-card').length === 1, 'Folder tree filters selected account mail');
  click('[data-audience="unknown"]');
  assert(!documentInFrame.querySelector('.message-card'), 'Unknown senders tab does not leak inbox mail into Sent');
  chooseFolder('inbox');
  click('[data-audience="contacts"]');
  frame.style.width = '390px';
  await new Promise(resolve => setTimeout(resolve, 80));
  click('a[data-home]');
  assert(documentInFrame.querySelector('.welcome-screen') && !documentInFrame.querySelector('.sidebar'),
    'Tapping the mobile logo returns to a clean home screen');
  const mobileChoices = [...documentInFrame.querySelectorAll('.welcome-choice')].map(element => element.getBoundingClientRect());
  assert(mobileChoices[0].bottom <= mobileChoices[1].top, 'Mobile welcome choices stack vertically');
  assert(documentInFrame.documentElement.scrollWidth <= windowInFrame.innerWidth, 'Mobile welcome fits without horizontal overflow');
  click('[data-action="enter-demo"]');
  click('[data-action="show-folders"]');
  assert(documentInFrame.querySelector('#app').dataset.stage === 'folders' && visible(documentInFrame.querySelector('.sidebar')),
    'Mobile folder selection exposes navigation instead of conversations');
  assert(rect('.brand-row').bottom <= rect('.topbar').top
    && rect('.topbar').bottom <= rect('.sidebar').top, 'Mobile order is logo/New message, search/Sync, then navigation');
  assert(visible(documentInFrame.querySelector('.mobile-compose')) && !visible(documentInFrame.querySelector('.desktop-compose')),
    'Mobile New message sits beside the logo');
  assert(parseFloat(windowInFrame.getComputedStyle(documentInFrame.querySelector('#search')).fontSize) >= 16
    && parseFloat(windowInFrame.getComputedStyle(documentInFrame.querySelector('#account-select')).fontSize) >= 16,
    'Mobile inputs have readable 16px text');
  assert(!visible(documentInFrame.querySelector('.mail-workspace')), 'Conversation list is hidden until a mobile folder is chosen');
  chooseFolder('inbox');
  assert(!visible(documentInFrame.querySelector('.sidebar'))
    && visible(documentInFrame.querySelector('.topbar')) && visible(documentInFrame.querySelector('.sender-tabs')),
    'Choosing a folder replaces mobile dropdowns and folder tree with sender tabs and conversations');
  assert(!visible(documentInFrame.querySelector('.real-status')), 'Mobile folder view keeps search/Sync but removes sync-info clutter below it');
  assert([...documentInFrame.querySelectorAll('[data-group]')].every(button => button.getAttribute('aria-expanded') === 'false'),
    'Mobile conversations remain collapsed until explicitly expanded');
  click('[data-message="m1"]');
  assert(visible(documentInFrame.querySelector('.chat-reader')) && !visible(documentInFrame.querySelector('.message-list')),
    'Mobile conversation selection shows the chat instead of the list');
  assert(parseFloat(windowInFrame.getComputedStyle(documentInFrame.querySelector('.message-body')).fontSize) >= 16,
    'Mobile message body uses increased font size');
  assert(!visible(documentInFrame.querySelector('.topbar')) && !visible(documentInFrame.querySelector('.conversation-navigation')),
    'Mobile reader hides mailbox search, Sync, folder navigation, and sender tabs');
  assert(visible(documentInFrame.querySelector('#conversation-search'))
    && documentInFrame.querySelector('#conversation-search').placeholder === 'Search within conversation',
    'Mobile reader offers a dedicated conversation search');
  const searchConversation = value => {
    const input = documentInFrame.querySelector('#conversation-search');
    input.focus();
    input.value = value;
    input.dispatchEvent(new windowInFrame.Event('input', { bubbles: true }));
  };
  searchConversation('FIREPLACE');
  assert(documentInFrame.querySelectorAll('[data-chat-message]').length === 1
    && documentInFrame.querySelector('[data-chat-message]').dataset.chatMessage === 'm1',
    'Conversation search filters received messages case-insensitively');
  assert(documentInFrame.querySelector('#conversation-search-count').textContent === '1 of 2 messages match',
    'Conversation search displays matching message count');
  assert(documentInFrame.activeElement.id === 'conversation-search' && documentInFrame.querySelector('#search').value === '',
    'Conversation search preserves input focus and leaves mailbox search unchanged');
  searchConversation('book pile');
  assert(documentInFrame.querySelector('[data-chat-message]').classList.contains('outgoing'),
    'Conversation search includes sent message text');
  searchConversation('Saturday coffee');
  assert(documentInFrame.querySelector('.conversation-no-results') && documentInFrame.querySelector('.chat-reader'),
    'No-results search stays in this conversation and does not match another topic');
  assert(documentInFrame.querySelector('#chat-reply-form'), 'A no-results search does not remove the reply form');
  searchConversation('fireplace');
  frame.style.width = '1200px';
  await new Promise(resolve => setTimeout(resolve, 80));
  assert(visible(documentInFrame.querySelector('.reader-toolbar .conversation-search'))
    && documentInFrame.querySelectorAll('[data-chat-message]').length === 1 && visible(documentInFrame.querySelector('.topbar')),
    'Desktop shows conversation search in the reader toolbar and retains the mailbox toolbar');
  assert(!documentInFrame.querySelector('.reader-context'), 'Conversation search replaces the One of your people label');
  searchConversation('book pile');
  assert(documentInFrame.querySelector('[data-chat-message]').classList.contains('outgoing')
    && documentInFrame.activeElement.id === 'conversation-search', 'Desktop conversation search filters messages and retains typing focus');
  searchConversation('fireplace');
  frame.style.width = '390px';
  await new Promise(resolve => setTimeout(resolve, 80));
  assert(documentInFrame.querySelectorAll('[data-chat-message]').length === 1
    && documentInFrame.querySelector('#conversation-search').value === 'fireplace', 'Mobile search is restored when returning from desktop width');
  click('[data-action="back"]');
  assert(visible(documentInFrame.querySelector('.message-list')) && !documentInFrame.querySelector('.chat-reader'),
    'Chat back button returns to the filtered conversation list');
  assert(visible(documentInFrame.querySelector('.topbar')) && visible(documentInFrame.querySelector('.sender-tabs')),
    'Leaving a mobile conversation restores mailbox search, Sync, and sender tabs');
  click('[data-message="m2"]');
  assert(documentInFrame.querySelector('#conversation-search').value === '', 'A different conversation has an independent search');
  click('[data-action="back"]');
  click('[data-message="m1"]');
  assert(documentInFrame.querySelector('#conversation-search').value === 'fireplace', 'Returning to a conversation preserves its search in this tab');
  click('[data-action="clear-conversation-search"]');
  assert(documentInFrame.querySelectorAll('[data-chat-message]').length === 2
    && documentInFrame.querySelector('#conversation-search').value === '', 'Clear restores all conversation messages');
  click('[data-action="back"]');
  click('[data-action="show-folders"]');
  chooseFolder('contacts');
  assert(visible(documentInFrame.querySelector('.contacts-page')) && !visible(documentInFrame.querySelector('.sidebar')),
    'Mobile Contacts link opens the address book');
  click('[data-action="show-folders"]');
  assert(visible(documentInFrame.querySelector('.sidebar')), 'Contacts has a route back to folder selection');
  assert(documentInFrame.documentElement.scrollWidth <= windowInFrame.innerWidth, 'Mobile navigation has no horizontal overflow');
  frame.style.width = '1200px';
  await new Promise(resolve => setTimeout(resolve, 80));
  chooseFolder('inbox');
  click('[data-message="m1"]');
  const saved = () => JSON.parse(frame.contentWindow.localStorage.getItem('gather-demo-v1'));
  const bubbles = () => documentInFrame.querySelectorAll('[data-chat-message]').length;
  const fill = (text) => {
    const input = documentInFrame.querySelector('#chat-reply');
    input.value = text;
    input.dispatchEvent(new frame.contentWindow.Event('input', { bubbles: true }));
  };
  const saveButton = () => documentInFrame.querySelector('#chat-reply-form [type="submit"]');
  assert(Boolean(saveButton()), 'Chat and Save reply button render');
  fill('A draft to keep when returning home.');
  click('a[data-home]');
  assert(documentInFrame.querySelector('#app').dataset.stage === 'home'
    && documentInFrame.activeElement.id === 'welcome-title', 'Logo returns home and moves keyboard focus to the welcome heading');
  click('[data-action="enter-demo"]');
  chooseFolder('inbox');
  click('[data-message="m1"]');
  assert(documentInFrame.querySelector('#chat-reply').value === 'A draft to keep when returning home.',
    'Returning home preserves unsent conversation drafts in memory');
  fill('');
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
  click('[data-action="back"]');
  chooseFolder('sent');
  click('.message-card');
  assert(bubbles() === initialCount + 2, 'Clicked replies appear in the same conversation from Sent');
  const demoBefore = JSON.stringify(saved());
  const chooseFormat = (format, allowImages = false) => {
    const previousConfirm = windowInFrame.confirm;
    windowInFrame.confirm = () => allowImages;
    click(`[data-action="conversation-format"][data-format="${format}"]`);
    windowInFrame.confirm = previousConfirm;
  };
  chooseMode('real');
  await waitFor(() => documentInFrame.querySelector('#account-select').disabled);
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
  const createdContacts = [];
  const conversationChanges = new Map();
  let actionCalls = 0, rejectAction = false, uncertainContact = false, writeGrants = false;
  let readCalls = 0, rejectRead = false;
  const readThreads = new Set();
  let sendScenario = 'success', sendCalls = 0, releaseSend;
  const decodeMime = value => new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0)));
  windowInFrame.google = { accounts: { oauth2: {
    hasGrantedAllScopes: (_response, ...scopes) => !partialConsent
      && (writeGrants || scopes.every(scope => !scope.endsWith('/gmail.modify') && !scope.endsWith('/contacts'))),
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
      if (url.pathname.includes('/threads/')) {
        if (JSON.parse(options.body || '{}').removeLabelIds?.includes('UNREAD')) {
          readCalls++;
          if (rejectRead) return new Response('{}', { status: 403 });
          readThreads.add(decodeURIComponent(url.pathname.split('/').at(-2)));
          return new Response('{}');
        }
        actionCalls++;
        if (rejectAction) return new Response('{}', { status: 403 });
        const parts = url.pathname.split('/');
        const thread = decodeURIComponent(parts.at(-2));
        const action = parts.at(-1);
        if (!['trash', 'modify'].includes(action)) throw new Error('Unexpected conversation mutation');
        if (action === 'modify') assert(JSON.parse(options.body).removeLabelIds.join() === 'INBOX', 'Archive removes only the Inbox label');
        conversationChanges.set(thread, action === 'trash' ? 'trash' : 'archive');
        return new Response('{}');
      }
      if (url.pathname === '/v1/people:createContact') {
        actionCalls++;
        if (uncertainContact) throw new TypeError('Contact creation response lost');
        const body = JSON.parse(options.body);
        const contact = { resourceName: `people/added-${createdContacts.length}`, names: [{ displayName: body.names[0].unstructuredName }], emailAddresses: body.emailAddresses };
        createdContacts.push(contact);
        return new Response(JSON.stringify(contact));
      }
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
      return new Response(JSON.stringify({ messages: [...['real-1', 'real-2', 'draft', 'spam', 'trash', 'new-sender'].map(id => ({ id })), ...sentCopies.map(message => ({ id: message.id }))] }));
    }
    if (url.pathname.endsWith('/history')) return new Response(JSON.stringify({ history: [{ messages: [...sentCopies.map(message => ({ id: message.id })), { id: 'new-sender' }] }], historyId: '101' }));
    if (url.pathname.includes('/threads/')) {
      const threadId = decodeURIComponent(url.pathname.split('/').at(-1));
      if (threadId === 'actual-thread') return new Response(JSON.stringify({ messages: [
        { id: 'real-1', labelIds: readThreads.has(threadId) ? ['INBOX'] : ['INBOX', 'UNREAD'] },
        { id: 'real-2', labelIds: ['SENT'] },
      ] }));
      const changed = conversationChanges.get('new-sender-thread');
      return new Response(JSON.stringify({ messages: [{ id: 'new-sender', labelIds: changed === 'trash' ? ['TRASH'] : changed === 'archive' ? [] : ['INBOX'] }] }));
    }
    if (url.pathname.includes('/attachments/')) {
      if (delayImage) return new Promise((resolve, reject) => options.signal.addEventListener('abort',
        () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
      return new Response(JSON.stringify({ data: imageData.split(',')[1] }));
    }
    if (url.pathname.includes('/messages/')) {
      const special = url.pathname.split('/').at(-1);
      if (special === 'new-sender') {
        const changed = conversationChanges.get('new-sender-thread');
        return new Response(JSON.stringify({
          id: 'new-sender', threadId: 'new-sender-thread', internalDate: String(Date.now() - 5000),
          labelIds: changed === 'trash' ? ['TRASH', 'projects'] : changed === 'archive' ? ['projects'] : ['INBOX', 'projects'],
          payload: { mimeType: 'text/plain', body: { data: btoa('A conversation from a new sender.') }, headers: [
            { name: 'From', value: 'New Person <new-person@example.com>' }, { name: 'To', value: 'real-user@example.com' },
            { name: 'Subject', value: 'New sender conversation' }, { name: 'Message-ID', value: '<new-sender@example.com>' },
          ] },
        }));
      }
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
      const body = btoa(sent ? `<p>An actual <em>sent</em> message, imported.</p><img src="${imageData}" alt="Sent image">` : `<h2>Provider HTML</h2><p>A private <strong>imported</strong> message.</p><a href="https://example.test/message">Read more</a><img src="${imageData}" alt="Embedded data image"><img src="cid:logo" alt="Provider image"><div class="protonmail_quote">-------- Original Message --------<blockquote>Earlier quoted content<div class="gmail_quote">Oldest quoted content</div></blockquote></div>`);
      return new Response(JSON.stringify({
        id: sent ? 'real-2' : 'real-1', threadId: 'actual-thread',
        labelIds: sent ? ['SENT'] : ['INBOX', ...(readThreads.has('actual-thread') ? [] : ['UNREAD']), 'projects', 'nested'], internalDate: String(Date.now() - (sent ? 1000 : 2000)),
        payload: { mimeType: 'text/html', body: { data: body }, parts: sent ? [] : [
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
      : new Response(JSON.stringify({ connections: [{ resourceName: 'people/1', names: [{ displayName: 'Maya' }], emailAddresses: [{ value: 'maya@example.com' }] }, ...createdContacts] }));
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
  assert(!documentInFrame.querySelector('[data-toggle-folder-account]'), 'Current-account tree no longer needs a second account-expansion control');
  assert(documentInFrame.querySelector('#account-select').value === 'gmail:real-user@example.com'
    && folderButton('Inbox').getClientRects().length > 0, 'Connected account is selected and its top-level folders are visible');
  assert(['Inbox', 'Sent', 'Drafts', 'Spam', 'Trash', 'Projects', 'Projects/Client <team>', 'Empty folder'].every(path => folderButton(path)),
    'All provider labels, nested labels, drafts, spam, trash, and empty folders appear');
  assert(folderButton('Projects/Client <team>').closest('.provider-folder-row').style.getPropertyValue('--folder-depth') === '1', 'Nested label is indented under its parent');
  assert(folderButton('Projects/Client <team>').getClientRects().length === 0, 'Nested folder branch starts collapsed');
  const toggleProject = () => folderButton('Projects').closest('.provider-folder-row').querySelector('[data-toggle-provider-folder]').click();
  toggleProject();
  assert(folderButton('Projects/Client <team>').getClientRects().length > 0, 'Parent chevron reveals nested folders');
  assert(documentInFrame.activeElement.matches('[data-toggle-provider-folder]'), 'Nested toggle retains keyboard focus');
  assert(folderButton('Inbox').querySelector('.provider-folder-count').textContent === '2', 'Folder badge counts cached messages from both known and unknown senders');
  folderButton('Projects/Client <team>').click();
  assert(documentInFrame.querySelector('.current-folder-label').textContent === 'Projects/Client <team>', 'Custom folder title is escaped and shown above the list');
  assert(documentInFrame.querySelectorAll('.message-card').length === 1, 'Selecting a custom label filters by actual provider membership');
  assert(documentInFrame.querySelector('[data-provider-folder][aria-current="page"]').title === 'Projects/Client <team>', 'Selected provider label is highlighted');
  toggleProject();
  assert(folderButton('Projects/Client <team>').getClientRects().length === 0, 'Parent chevron collapses its descendants');
  assert(documentInFrame.querySelector('.current-folder-label').textContent === 'Projects/Client <team>'
    && documentInFrame.querySelectorAll('.message-card').length === 1, 'Collapsing a branch preserves the current folder selection and messages');
  toggleProject();
  documentInFrame.querySelector('.provider-folders summary').click();
  assert(!documentInFrame.querySelector('.provider-folders').open && !visible(folderButton('Projects')), 'Folder summary collapses the tree');
  documentInFrame.querySelector('.provider-folders summary').click();
  assert(folderButton('Projects/Client <team>').getClientRects().length > 0, 'Reopening an account preserves expanded nested branches');
  click('[data-folder="contacts"]');
  assert(folderButton('Projects/Client <team>').getClientRects().length > 0, 'Tree expansion survives navigation to Contacts');
  folderButton('Projects/Client <team>').click();
  click('.message-card');
  assert(bubbles() === 2, 'Custom label opens the complete received and sent thread');
  click('[data-action="back"]');
  folderButton('Drafts').click();
  click('[data-audience="unknown"]');
  click('.message-card');
  assert(documentInFrame.querySelector('.chat-message-footer').textContent.includes('Draft · Not sent'), 'Draft is explicitly marked not sent');
  assert(documentInFrame.querySelector('.chat-person').textContent.includes('Draft without recipient'), 'Recipient-less drafts remain readable');
  assert(!documentInFrame.querySelector('#chat-reply-form'), 'Draft view cannot send or modify provider drafts');
  click('[data-action="back"]');
  folderButton('Spam').click();
  click('[data-audience="contacts"]');
  assert(documentInFrame.querySelector('.message-card').textContent.includes('spam message'), 'Spam label displays its synced mail');
  folderButton('Trash').click();
  assert(documentInFrame.querySelector('.message-card').textContent.includes('trash message'), 'Trash label displays its synced mail');
  folderButton('Empty folder').click();
  assert(!documentInFrame.querySelector('.message-card') && documentInFrame.querySelector('.empty-state'), 'Empty provider folders remain selectable');
  chooseFolder('inbox');
  assert(documentInFrame.querySelectorAll('.message-card').length === 1, 'Imported inbox groups received and sent mail by provider thread');
  click('.message-card');
  assert(bubbles() === 2, 'Real conversation displays imported received and sent messages');
  assert(documentInFrame.querySelector('[data-action="archive-conversation"]').disabled
    && documentInFrame.querySelector('[data-action="trash-conversation"]').disabled
    && documentInFrame.querySelector('.action-help').textContent.includes('Reconnect'),
    'Read/send-only accounts explain the additional permission needed for conversation actions');
  assert(!documentInFrame.querySelector('.html-message')
    && documentInFrame.querySelector('[data-format="plain"]').getAttribute('aria-pressed') === 'true',
    'Conversations open as plain text by default, without mounting HTML or requesting images');
  frame.style.width = '390px';
  await new Promise(resolve => setTimeout(resolve, 80));
  assert(readCalls === 0, 'Opening without mail-write permission makes no provider write');
  assert(documentInFrame.querySelector('.chat-message-footer').textContent.includes('Unread'),
    'Opening without mail-write permission preserves unread state');
  await waitFor(() => documentInFrame.querySelector('.real-status').textContent.includes('Could not mark'));
  assert(documentInFrame.querySelector('.real-status').textContent.includes('Reconnect'),
    'Opening without mail-write permission explains how to reconnect');
  searchConversation('Oldest quoted content');
  assert(documentInFrame.querySelectorAll('[data-chat-message]').length === 1
    && documentInFrame.querySelector('.incoming .message-body').textContent.includes('Oldest quoted content')
    && documentInFrame.querySelector('.quote-search-note'),
    'Conversation search reveals quoted history when needed to show a matching result');
  click('[data-action="clear-conversation-search"]');
  assert(!documentInFrame.querySelector('.incoming .message-body').textContent.includes('Oldest quoted content'),
    'Clearing conversation search restores the previous collapsed quote state');
  frame.style.width = '1200px';
  await new Promise(resolve => setTimeout(resolve, 80));
  let formatPrompts = [];
  const initialConfirm = windowInFrame.confirm;
  const requestsBeforeHtml = requests.length;
  windowInFrame.confirm = message => { formatPrompts.push(message); return false; };
  click('[data-action="conversation-format"][data-format="html"]');
  windowInFrame.confirm = initialConfirm;
  assert(formatPrompts.length === 1 && formatPrompts[0].includes('this conversation') && formatPrompts[0].includes('IP address'),
    'Switching a multi-message conversation to HTML asks once about loading its images');
  assert(requests.length === requestsBeforeHtml, 'Declining the conversation image prompt makes no provider image requests');
  await waitFor(() => documentInFrame.querySelector('.html-message')?.contentDocument?.querySelector('strong')
    && documentInFrame.querySelector('.html-message').style.height);
  let htmlFrame = documentInFrame.querySelector('.html-message');
  assert(htmlFrame.contentDocument.querySelector('strong').textContent === 'imported', 'Imported HTML renders formatting inside an isolated frame');
  assert(documentInFrame.querySelectorAll('.conversation-format').length === 1
    && documentInFrame.querySelector('.chat-heading .conversation-format'), 'One display-format switch appears in the conversation header');
  assert(documentInFrame.querySelectorAll('.html-message').length === 2, 'HTML mode renders both received and sent HTML messages');
  assert(documentInFrame.querySelector('[data-format="html"]').getAttribute('aria-pressed') === 'true',
    'Declining images still switches the conversation to HTML');
  assert(!documentInFrame.querySelector('.chat-message .chat-addresses'), 'Message bubbles omit repeated From, To, and Cc address lines');
  assert(!htmlFrame.contentDocument.body.textContent.includes('Earlier quoted content'), 'Conversation hides nested reply history by default');
  assert(documentInFrame.querySelector('[data-action="toggle-quotes"]').getAttribute('aria-expanded') === 'false', 'Quoted-history control starts collapsed');
  click('[data-action="toggle-quotes"]');
  await waitFor(() => documentInFrame.querySelector('.html-message')?.contentDocument?.body?.textContent.includes('Oldest quoted content'));
  assert(documentInFrame.querySelector('[data-action="toggle-quotes"]').textContent === 'Hide quoted text', 'Quote control restores the complete nested history');
  chooseFormat('plain');
  assert(!documentInFrame.querySelector('.html-message')
    && documentInFrame.querySelectorAll('.chat-message .message-body').length === 2,
    'Conversation Plain text selection changes every HTML message together');
  assert(documentInFrame.querySelector('[data-format="plain"]').getAttribute('aria-pressed') === 'true',
    'Conversation format exposes its selected state accessibly');
  assert(documentInFrame.querySelector('.incoming .message-body').textContent.includes('Earlier quoted content'), 'Expanded history remains visible when switching to plain text');
  click('[data-action="toggle-quotes"]');
  assert(!documentInFrame.querySelector('.incoming .message-body').textContent.includes('Earlier quoted content'), 'Collapsing hides history in plain-text mode');
  chooseFormat('html');
  await waitFor(() => documentInFrame.querySelector('.html-message')?.contentDocument?.querySelector('strong')
    && documentInFrame.querySelector('.html-message').style.height);
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
  chooseMode('demo');
  chooseMode('real');
  await waitFor(() => documentInFrame.querySelector('.message-card'));
  click('.message-card');
  await waitFor(() => documentInFrame.querySelector('.html-message')?.contentDocument?.body?.textContent.includes('Image blocked'));
  assert(!documentInFrame.querySelector('[data-action="hide-images"]'), 'Switching mailboxes clears per-message image permission');
  windowInFrame.confirm = originalConfirm;
  chooseFormat('plain');
  assert(!documentInFrame.querySelector('.html-message') && documentInFrame.querySelector('.incoming .message-body').textContent.includes('A private imported message.'),
    'Plain-text toggle shows the searchable fallback without HTML');
  click('[data-action="back"]');
  folderButton('Drafts').click();
  click('[data-audience="unknown"]');
  click('.message-card');
  assert(documentInFrame.querySelector('[data-format="plain"]').getAttribute('aria-pressed') === 'true',
    'Other conversations retain their default plain-text format');
  click('[data-action="back"]');
  chooseFolder('inbox');
  click('[data-audience="contacts"]');
  click('.message-card');
  assert(!documentInFrame.querySelector('.html-message')
    && documentInFrame.querySelector('[data-format="plain"]').getAttribute('aria-pressed') === 'true',
    'Plain-text conversation preference survives folder and conversation navigation');
  chooseFormat('html');
  await waitFor(() => documentInFrame.querySelector('.html-message')?.contentDocument?.querySelector('strong'));
  assert(documentInFrame.querySelector('.html-message'), 'HTML toggle restores the formatted view');
  chooseFormat('plain');
  const countBeforeApprove = requests.length;
  chooseFormat('html', true);
  await waitFor(() => [...documentInFrame.querySelectorAll('.html-message')].length === 2
    && [...documentInFrame.querySelectorAll('.html-message')].every(iframe => {
      const images = [...(iframe.contentDocument?.querySelectorAll('img') || [])];
      return images.length && images.every(image => image.naturalWidth === 120);
    }));
  assert(documentInFrame.querySelectorAll('[data-action="hide-images"]').length === 2 && requests.length > countBeforeApprove,
    'Approving the conversation prompt enables images for all its current image-containing messages');
  formatPrompts = [];
  windowInFrame.confirm = message => { formatPrompts.push(message); return true; };
  click('[data-action="conversation-format"][data-format="html"]');
  windowInFrame.confirm = initialConfirm;
  assert(formatPrompts.length === 0, 'Clicking the already-selected HTML mode does not ask again');
  chooseFormat('plain');
  assert(!documentInFrame.querySelector('.html-message'), 'Returning to plain text removes image-bearing HTML frames');
  chooseFormat('html');
  await waitFor(() => [...documentInFrame.querySelectorAll('.html-message')].every(iframe => iframe.contentDocument?.body?.textContent.includes('Image blocked')));
  assert(!documentInFrame.querySelector('[data-action="hide-images"]'),
    'Switching back to HTML and declining does not reuse old image permissions');
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
  assert(documentInFrame.querySelector('.current-folder-label').textContent === 'Projects/Renamed <team>', 'Folder rename sync preserves selection by stable provider ID');
  assert(folderButton('Projects/Renamed <team>').getClientRects().length > 0
    && documentInFrame.querySelector('.provider-folders').open,
    'Tree and branch expansion survive a folder rename and sync');
  folderRemoved = true;
  click('[data-action="sync"]');
  await waitFor(() => !folderButton('Projects/Renamed <team>') && !documentInFrame.querySelector('[data-action="sync"]').disabled);
  assert(documentInFrame.querySelector('.current-folder-label').textContent === 'Inbox', 'Deleted folder is removed and selection safely returns to Inbox');
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
  writeGrants = true;
  click('#prepare-provider');
  await waitFor(() => !documentInFrame.querySelector('#connect-provider').hidden);
  cancelAtMail = true;
  click('#connect-provider');
  await waitFor(() => documentInFrame.querySelector('#connection-feedback').textContent.includes('cancelled'));
  assert(documentInFrame.querySelectorAll('.connected-account').length === 1, 'Cancelled replacement import preserves the existing cached account');
  cancelAtMail = false;
  click('#close-accounts');
  chooseFolder('inbox');
  rejectRead = true;
  click('[data-action="unread-filter"]');
  click('.message-card');
  await waitFor(() => documentInFrame.querySelector('.real-status').textContent.includes('Could not mark')
    && !documentInFrame.querySelector('[data-action="sync"]').disabled);
  assert(readCalls === 1 && documentInFrame.querySelector('.message-card.selected').classList.contains('unread'),
    'A rejected read update leaves the conversation unread and visible');
  rejectRead = false;
  click('[data-action="sync"]');
  click('.message-card.selected');
  assert(readCalls === 1, 'Opening during sync queues the read update rather than competing with the import');
  await waitFor(() => readThreads.has('actual-thread') && !documentInFrame.querySelector('[data-action="sync"]').disabled);
  assert(!documentInFrame.querySelector('.message-card.unread')
    && !documentInFrame.querySelector('.chat-message-footer').textContent.includes('Unread')
    && documentInFrame.querySelector('.chat-reader')
    && documentInFrame.querySelector('[data-action="unread-filter"]').getAttribute('aria-pressed') === 'true',
    'Opening a real conversation marks all its messages read and keeps the reader open with the Unread filter enabled');
  const persistedRead = await new Promise((resolve, reject) => {
    const request = indexedDB.open(testDatabase);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('accounts');
      const records = transaction.objectStore('accounts').getAll();
      records.onsuccess = () => resolve(records.result[0].messages.find(message => message.remoteId === 'real-1').unread);
      records.onerror = () => reject(records.error);
      transaction.oncomplete = () => database.close();
      transaction.onabort = () => database.close();
    };
  });
  assert(persistedRead === false, 'Confirmed read status is persisted in the real mailbox cache');
  const readsAfterOpen = readCalls;
  click('[data-action="unread-filter"]');
  click('.message-card');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert(readCalls === readsAfterOpen, 'Reopening an already-read conversation makes no redundant provider write');
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
  click('a[data-home]');
  assert(!documentInFrame.querySelector('.welcome-screen'), 'Home navigation does not interrupt an in-flight real send');
  documentInFrame.querySelector('#chat-reply-form').requestSubmit();
  assert(sendCalls === inFlightCalls && documentInFrame.querySelector('#chat-reply-form [type="submit"]').disabled,
    'Duplicate submit while sending cannot send a second email');
  releaseSend();
  await waitFor(() => documentInFrame.querySelector('.chat-message:last-child').textContent.includes('Accepted by provider')
    && !documentInFrame.querySelector('#chat-reply-form [type="submit"]').disabled);
  assert(bubbles() === countBeforeSending + 1 && documentInFrame.querySelector('#chat-reply').value === '',
    'Accepted real reply appears immediately in the same conversation and clears the draft');
  assert(documentInFrame.querySelectorAll('.html-message').length === 2
    && documentInFrame.querySelector('.chat-message:last-child .message-body').textContent === 'A real reply from Gather.',
    'HTML conversation mode preserves readability of newly sent plain-text messages');
  assert(documentInFrame.querySelector('.current-folder-label').textContent === 'Inbox',
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
  assert(documentInFrame.querySelector('.current-folder-label').textContent === 'Sent'
    && documentInFrame.querySelector('.subject-heading').textContent === 'A new real conversation',
    'New real email opens in Sent as a new conversation');
  assert(documentInFrame.querySelector('.chat-message').textContent.includes('Accepted by provider'),
    'New email is labeled provider-accepted, not delivered');
  assert(JSON.stringify(saved()) === demoBefore, 'Real sending never writes into demo localStorage');
  click('[data-action="back"]');
  chooseFolder('inbox');
  click('[data-audience="unknown"]');
  click('[data-message="gmail:real-user@example.com:new-sender"]');
  assert(documentInFrame.querySelector('[data-action="add-conversation-sender"]')
    && !documentInFrame.querySelector('[data-action="archive-conversation"]').disabled,
    'Conversation header exposes provider contact, archive, and trash actions');
  click('[data-action="add-conversation-sender"]');
  assert(documentInFrame.querySelector('#sender-form [name="sender"]').value === 'new-person@example.com',
    'Add sender dialog uses the actual received sender');
  documentInFrame.querySelector('#sender-form [name="name"]').value = 'New Friend';
  uncertainContact = true;
  documentInFrame.querySelector('#sender-form [type="submit"]').click();
  await waitFor(() => documentInFrame.querySelector('#sender-form .form-error').textContent.includes('could not be confirmed'));
  const afterUncertainContact = actionCalls;
  documentInFrame.querySelector('#sender-form [type="submit"]').click();
  await waitFor(() => documentInFrame.querySelector('#sender-form .form-error').textContent.includes('unconfirmed result'));
  assert(actionCalls === afterUncertainContact, 'Uncertain contact creation is not automatically or manually duplicated without resolution');
  click('#sender-form [data-close]');
  click('[data-action="connections"]');
  await waitFor(() => documentInFrame.querySelector('[data-clear-contact-attempt]') && !documentInFrame.querySelector('[data-clear-contact-attempt]').disabled);
  click('[data-clear-contact-attempt]');
  await waitFor(() => !documentInFrame.querySelector('[data-clear-contact-attempt]'));
  assert(actionCalls === afterUncertainContact, 'Clearing a checked contact attempt only changes local recovery state');
  click('#close-accounts');
  uncertainContact = false;
  click('[data-action="add-conversation-sender"]');
  documentInFrame.querySelector('#sender-form [name="name"]').value = 'New Friend';
  documentInFrame.querySelector('#sender-form [type="submit"]').click();
  await waitFor(() => !documentInFrame.querySelector('#sender-dialog').open);
  assert(createdContacts.length === 1 && createdContacts[0].emailAddresses[0].value === 'new-person@example.com',
    'Adding a sender creates the contact at the provider');
  assert(documentInFrame.querySelector('[data-audience="contacts"]').getAttribute('aria-selected') === 'true'
    && documentInFrame.querySelector('.chat-person').textContent.includes('New Friend'),
    'Provider contact creation immediately reclassifies the current conversation under Contacts');
  assert(!documentInFrame.querySelector('[data-action="add-conversation-sender"]'), 'Known senders do not get a duplicate add-contact action');
  const beforeCancelAction = actionCalls;
  windowInFrame.confirm = () => false;
  click('[data-action="trash-conversation"]');
  assert(actionCalls === beforeCancelAction, 'Declining Trash confirmation performs no mutation');
  windowInFrame.confirm = () => true;
  rejectAction = true;
  click('[data-action="archive-conversation"]');
  await waitFor(() => documentInFrame.querySelector('.real-status.storage-error')?.textContent.includes('403')
    && !documentInFrame.querySelector('[data-action="sync"]').disabled);
  assert(documentInFrame.querySelector('.chat-reader'), 'Rejected archive keeps the conversation visible and shows an error');
  rejectAction = false;
  failContacts = true;
  click('[data-action="archive-conversation"]');
  await waitFor(() => !documentInFrame.querySelector('.chat-reader') && !documentInFrame.querySelector('[data-action="sync"]').disabled);
  assert(conversationChanges.get('new-sender-thread') === 'archive', 'Archive updates Gmail and removes the conversation from Inbox');
  assert(documentInFrame.querySelector('.real-status.storage-error').textContent.includes('Refresh failed'),
    'A successful provider action followed by refresh failure is reported explicitly');
  failContacts = false;
  folderButton('Projects').click();
  click('[data-message="gmail:real-user@example.com:new-sender"]');
  click('[data-action="trash-conversation"]');
  await waitFor(() => !documentInFrame.querySelector('[data-action="sync"]').disabled && conversationChanges.get('new-sender-thread') === 'trash');
  folderButton('Trash').click();
  click('[data-message="gmail:real-user@example.com:new-sender"]');
  assert(documentInFrame.querySelector('.chat-message-footer').textContent.includes('Deleted / Trash'),
    'Deleted conversation remains readable in provider Trash instead of being permanently removed');
  assert(JSON.stringify(saved()) === demoBefore, 'Provider contact and conversation actions do not alter demo data');
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
  chooseMode('demo');
  assert(documentInFrame.querySelectorAll('.message-card').length === 5, 'Switching back restores the selected demo account inbox');
  assert(JSON.stringify(saved()) === demoBefore, 'Connection, failed sync, cancellation, and removal leave demo data unchanged');
  click('[data-message="m5"]');
  formatPrompts = [];
  windowInFrame.confirm = message => { formatPrompts.push(message); return false; };
  click('[data-action="conversation-format"][data-format="html"]');
  windowInFrame.confirm = initialConfirm;
  assert(formatPrompts.length === 0, 'HTML messages without images switch formats without an image prompt');
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
    click('[data-message="m4"]');
    const shortReply = documentInFrame.querySelector('#chat-reply-form');
    const shortMessage = documentInFrame.querySelector('.chat-message:last-child');
    assert(shortReply.getBoundingClientRect().top - shortMessage.getBoundingClientRect().bottom <= 24,
      `${width}px short-thread reply stays close even beside a taller message list`);
    click('[data-message="m1"]');
  }
  await checkFullHeight(1200);
  await checkFullHeight(390);
  await checkFullHeight(320);
  assert(documentInFrame.querySelector('.chat-person > div:not(.conversation-format)').getBoundingClientRect().width >= 110,
    'Narrow-screen correspondent details remain readable instead of being squeezed into a vertical column');
  const demoConfirm = windowInFrame.confirm;
  windowInFrame.confirm = () => true;
  click('[data-action="archive-conversation"]');
  assert(saved().messages.find(message => message.id === 'm1').folder === 'archive',
    'Demo conversation archive moves received mail locally');
  assert(saved().messages.find(message => message.id === 'demo-reply-m1').folder === 'sent',
    'Demo archive preserves sent replies');
  chooseFolder('archive');
  click('.message-card');
  click('[data-action="trash-conversation"]');
  chooseFolder('trash');
  click('.message-card');
  assert([...documentInFrame.querySelectorAll('.chat-message-footer')].every(element => !element.textContent.includes('Archived')),
    'Demo Trash keeps the conversation readable after moving all its messages');
  assert(saved().messages.filter(message => message.subject.includes('getaway')).every(message => message.folder === 'trash'),
    'Demo Trash action covers the entire topic rather than only visible search results');
  chooseFolder('inbox');
  click('[data-audience="unknown"]');
  click('.message-card');
  assert([...documentInFrame.querySelectorAll('.conversation-actions button')].every(button => {
    const bounds = button.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= windowInFrame.innerWidth && bounds.height >= 40;
  }), 'All three conversation actions fit the narrow mobile layout with usable tap targets');
  click('[data-action="add-conversation-sender"]');
  const demoContactForm = documentInFrame.querySelector('#contact-form');
  assert(documentInFrame.querySelector('#contact-dialog').open
    && !documentInFrame.querySelector('.contact-target').hidden,
    'Demo add-sender preserves the choice of a new or existing contact');
  const senderEmail = demoContactForm.querySelector('[name="email"]').value;
  const contactsBefore = saved().contacts.length;
  const target = demoContactForm.elements.target;
  target.value = target.options[1].value;
  target.dispatchEvent(new windowInFrame.Event('change', { bubbles: true }));
  demoContactForm.querySelector('[type="submit"]').click();
  assert(saved().contacts.length === contactsBefore
    && saved().contacts.find(contact => contact.id === target.value).emails.includes(senderEmail),
    'Demo sender can be added to an existing contact without creating a duplicate');
  assert(documentInFrame.querySelector('[data-audience="contacts"]').getAttribute('aria-selected') === 'true'
    && documentInFrame.querySelector('.chat-reader'),
    'Adding a demo sender keeps the conversation open under Contacts');
  windowInFrame.confirm = demoConfirm;
  frame.style.width = '1200px';
  await new Promise(resolve => setTimeout(resolve, 80));
  click('[data-action="sync"]');
  const accountPicker = documentInFrame.querySelector('#account-select');
  accountPicker.focus();
  await waitFor(() => !documentInFrame.querySelector('[data-action="sync"]').disabled);
  assert(accountPicker.isConnected && documentInFrame.querySelector('#account-select') === accountPicker
    && documentInFrame.activeElement === accountPicker,
    'Desktop account picker remains connected and focused through a background mailbox redraw');
  changeSelect('#account-select', 'outlook');
  assert(documentInFrame.querySelector('#account-select').value === 'outlook'
    && documentInFrame.querySelectorAll('.message-card').length === 2,
    'Account switching still updates the mailbox after the picker survives a redraw');
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

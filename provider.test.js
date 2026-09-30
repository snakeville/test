import { createApi, ProviderError, plainTextFromHtml, gmailMessage, graphMessage, importMailbox, combineSnapshots } from './provider-mail.js';
import { openMailboxStore, isValidSnapshot } from './mailbox-store.js';
import { validateClientId, prepareSignIn, hasSession, forgetSession, getAccountApi } from './auth.js';
import { conversationMessages, visibleConversations, replyToConversation } from './mail.js';

const results = [];
async function test(name, check) {
  try { await check(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
}
function assert(condition, message = 'Assertion failed') { if (!condition) throw new Error(message); }
async function rejects(callback, includes = '') {
  try { await callback(); } catch (error) {
    assert(error.message.includes(includes), `Expected "${includes}", got "${error.message}"`);
    return;
  }
  throw new Error('Expected an error');
}
const gmailAccount = { id: 'gmail:alex@example.com', provider: 'gmail', email: 'alex@example.com', clientId: '123-test.apps.googleusercontent.com' };
const graphAccount = { id: 'outlook:user-1', provider: 'outlook', email: 'alex@outlook.example', clientId: '11111111-2222-3333-4444-555555555555' };
const now = Date.now();
const since = new Date(now - 30 * 86400000).toISOString();
const base64 = (value) => btoa(String.fromCharCode(...new TextEncoder().encode(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function gmailRaw(id = 'g1', labels = ['INBOX', 'UNREAD']) {
  return { id, threadId: 'g-thread', internalDate: String(now - 1000), labelIds: labels,
    payload: { mimeType: 'text/plain', headers: [
      { name: 'From', value: 'Maya Chen <maya@example.com>' }, { name: 'To', value: 'Alex <alex@example.com>' },
      { name: 'Subject', value: 'A real conversation' }, { name: 'Message-ID', value: '<g1@example.com>' },
    ], body: { data: base64('Hello, café 🌿') } } };
}
function graphRaw(id = 'o1') {
  return { id, conversationId: 'o-thread', from: { emailAddress: { address: 'maya@example.com', name: 'Maya Chen' } },
    toRecipients: [{ emailAddress: { address: 'alex@outlook.example' } }], subject: 'A real conversation',
    body: { contentType: 'text', content: 'An Outlook message.' }, receivedDateTime: new Date(now - 1000).toISOString(),
    isRead: false, isDraft: false, flag: { flagStatus: 'flagged' }, internetMessageId: '<o1@example.com>' };
}
function makeSnapshot(account, messages = []) {
  return { version: 1, account, messages, contacts: [], days: 30, since, lastSync: new Date().toISOString(), cursors: {} };
}
function gmailApi({ history = false, failContacts = false, expired = false } = {}) {
  const calls = [];
  const api = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    if (url.endsWith('/profile')) return { emailAddress: gmailAccount.email, historyId: '100' };
    if (parsed.pathname.endsWith('/history')) {
      if (expired) throw new ProviderError('Expired history', 404);
      return { history: [{ messages: [{ id: 'g1' }, { id: 'deleted' }, { id: 'g3' }] }], historyId: '102' };
    }
    if (parsed.pathname.endsWith('/messages')) return parsed.searchParams.has('pageToken')
      ? { messages: [{ id: 'g2' }] } : { messages: [{ id: 'g1' }], nextPageToken: 'page-2' };
    if (parsed.pathname.includes('/messages/')) {
      const id = parsed.pathname.split('/').at(-1);
      if (id === 'deleted') throw new ProviderError('Gone', 404);
      return gmailRaw(id, history && id === 'g1' ? ['STARRED'] : ['INBOX', 'UNREAD']);
    }
    if (parsed.hostname === 'people.googleapis.com') {
      if (failContacts) throw new ProviderError('Contacts denied', 403);
      return parsed.searchParams.has('pageToken')
        ? { connections: [{ resourceName: 'people/2', names: [{ displayName: 'James' }], emailAddresses: [{ value: 'james@example.com' }] }] }
        : { connections: [{ resourceName: 'people/1', names: [{ displayName: 'Maya' }], emailAddresses: [{ value: 'MAYA@EXAMPLE.COM' }] }], nextPageToken: 'contacts-2' };
    }
    throw new Error(`Unexpected Gmail URL ${url}`);
  };
  return { api, calls };
}
function graphApi({ delta = false, expire = false, sparse = false } = {}) {
  const calls = [];
  const api = async (url, headers) => {
    calls.push({ url, headers });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/me')) return { id: 'user-1', mail: graphAccount.email };
    if (parsed.pathname.includes('/me/messages/')) return graphRaw('o1');
    if (parsed.pathname.includes('/mailFolders/')) {
      const folder = parsed.pathname.split('/mailFolders/')[1].split('/')[0];
      if (folder === 'archive') throw new ProviderError('Missing archive folder', 404);
      if (expire && parsed.searchParams.get('cursor') === 'old') throw new ProviderError('Expired delta', 410);
      if (folder === 'sentitems') return { value: [], '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages/delta?cursor=new` };
      if (!parsed.searchParams.has('page') && !parsed.searchParams.has('cursor')) {
        return { value: [graphRaw('o1')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?page=2' };
      }
      return { value: delta ? [{ id: 'o2', '@removed': { reason: 'deleted' } }, sparse ? { id: 'o1', isRead: true } : { ...graphRaw('o1'), isRead: true }]
        : [graphRaw('o2')], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?cursor=old' };
    }
    if (parsed.pathname.endsWith('/contacts')) return { value: [{ id: 'c1', displayName: 'Maya', emailAddresses: [{ address: 'maya@example.com' }] }] };
    throw new Error(`Unexpected Graph URL ${url}`);
  };
  return { api, calls };
}

await test('Gmail MIME decoding preserves Unicode, account identity, flags, and provider thread IDs', () => {
  const message = gmailMessage(gmailRaw(), gmailAccount, since);
  assert(message.body === 'Hello, café 🌿');
  assert(message.sender === 'maya@example.com' && message.to === gmailAccount.email);
  assert(message.remote && message.unread && message.folder === 'inbox' && message.threadId === 'g-thread');
});
await test('Plain-text display removes active HTML, images, links, styles, and script content', () => {
  const text = plainTextFromHtml('<style>bad-css</style><script>bad-script</script><p>Hello<br>World</p><img src="https://tracking.invalid/x"><iframe>bad-frame</iframe><a href="javascript:alert(1)">A label</a>');
  assert(text.includes('Hello\nWorld') && text.includes('A label'));
  assert(!text.includes('bad-') && !text.includes('tracking') && !text.includes('javascript:'));
});
await test('Gmail selects plain text before HTML and never renders attachments', () => {
  const raw = gmailRaw();
  raw.payload.mimeType = 'multipart/alternative';
  raw.payload.body = {};
  raw.payload.parts = [
    { mimeType: 'text/html', body: { data: base64('<p>HTML alternative</p>') } },
    { mimeType: 'text/plain', body: { data: base64('Plain alternative') } },
    { mimeType: 'text/plain', filename: 'attachment.txt', body: { data: base64('Not the message') } },
  ];
  assert(gmailMessage(raw, gmailAccount, since).body === 'Plain alternative');
  raw.payload.parts = [{ mimeType: 'text/plain', body: { attachmentId: 'large-body' } }];
  assert(gmailMessage(raw, gmailAccount, since).body.includes('stored this body as an attachment'));
});
await test('Gmail excludes drafts, trash, spam, and messages older than the selected starting date', () => {
  for (const label of ['DRAFT', 'TRASH', 'SPAM']) assert(gmailMessage(gmailRaw('g1', [label]), gmailAccount, since) === null);
  const old = gmailRaw();
  old.internalDate = String(now - 60 * 86400000);
  assert(gmailMessage(old, gmailAccount, since) === null);
});
await test('Outlook body text and HTML normalize to inert text with provider flags', () => {
  const raw = graphRaw();
  raw.body = { contentType: 'HTML', content: '<p>Hello</p><img src="https://tracking.invalid/x">' };
  const message = graphMessage(raw, graphAccount, 'inbox', since);
  assert(message.body === 'Hello' && message.starred && message.unread);
  assert(message.threadId === 'o-thread' && message.internetMessageId === '<o1@example.com>');
});
await test('Real provider threads include different participants but remain account scoped', async () => {
  const first = gmailMessage(gmailRaw(), gmailAccount, since);
  const sent = { ...first, id: 'reply', folder: 'sent', sender: gmailAccount.email, to: 'james@example.com' };
  const other = { ...first, id: 'other', accountId: 'gmail:other@example.com' };
  const state = { messages: [first, sent, other], contacts: [] };
  assert(conversationMessages(state, first.id).length === 2);
  await rejects(() => replyToConversation(state, first.id, 'Should not send'), 'read-only');
});
await test('Provider transport restricts authorization to approved API origins and GET requests', async () => {
  let called = 0;
  const api = createApi(async () => 'test-token', 'outlook', undefined, async (url, options) => {
    called++;
    assert(options.method === 'GET' && options.credentials === 'omit' && options.redirect === 'error');
    assert(options.headers.Authorization === 'Bearer test-token');
    return new Response('{"value":[]}');
  });
  await api('https://graph.microsoft.com/v1.0/me/contacts');
  await rejects(() => api('https://attacker.invalid/steal'), 'unsafe');
  await rejects(() => api('http://graph.microsoft.com/v1.0/me'), 'unsafe');
  await rejects(() => api('https://user@graph.microsoft.com/v1.0/me'), 'unsafe');
  assert(called === 1);
});
await test('Provider transport surfaces permission expiry and rate limiting without leaking provider error bodies', async () => {
  for (const [status, expected] of [[401, 'Reconnect'], [403, 'permissions'], [500, 'HTTP 500']]) {
    const api = createApi(async () => 'token', 'gmail', undefined, async () => new Response('private error body', { status }));
    await rejects(() => api('https://gmail.googleapis.com/gmail/v1/users/me/profile'), expected);
  }
});
await test('Provider transport retries a throttled request and honors cancellation', async () => {
  let calls = 0;
  const api = createApi(async () => 'token', 'gmail', undefined, async () => ++calls === 1
    ? new Response('', { status: 429, headers: { 'Retry-After': '0' } }) : new Response('{}'));
  await api('https://gmail.googleapis.com/gmail/v1/users/me/profile');
  assert(calls === 2);
  const controller = new AbortController();
  controller.abort();
  await rejects(() => createApi(async () => 'token', 'gmail', controller.signal, () => { throw new Error('Must not fetch'); })('https://gmail.googleapis.com/gmail/v1/users/me/profile'));
});
await test('Gmail initial import paginates mail and contacts and stores a history cursor', async () => {
  const mock = gmailApi();
  const snapshot = await importMailbox({ account: gmailAccount, api: mock.api });
  assert(snapshot.messages.length === 2 && snapshot.contacts.length === 2);
  assert(snapshot.cursors.historyId === '100' && isValidSnapshot(snapshot));
  assert(mock.calls.some((url) => url.includes('pageToken=page-2')));
  assert(mock.calls.some((url) => url.includes('pageToken=contacts-2')));
});
await test('Gmail history applies deletion, label changes, and additions without losing the old cache', async () => {
  const previous = await importMailbox({ account: gmailAccount, api: gmailApi().api });
  previous.messages.push({ ...previous.messages[0], id: `${gmailAccount.id}:deleted`, remoteId: 'deleted' });
  const before = JSON.stringify(previous);
  const mock = gmailApi({ history: true });
  const snapshot = await importMailbox({ account: gmailAccount, previous, api: mock.api });
  assert(snapshot.messages.length === 3 && snapshot.cursors.historyId === '102');
  assert(snapshot.messages.find((message) => message.remoteId === 'g1').folder === 'archive');
  assert(!snapshot.messages.some((message) => message.remoteId === 'deleted'));
  assert(!mock.calls.some((url) => new URL(url).pathname.endsWith('/messages')));
  assert(JSON.stringify(previous) === before);
});
await test('Expired Gmail history rebuilds the selected range instead of merging stale records', async () => {
  const previous = await importMailbox({ account: gmailAccount, api: gmailApi().api });
  previous.messages.push({ ...previous.messages[0], id: 'stale', remoteId: 'stale' });
  const statuses = [];
  const snapshot = await importMailbox({ account: gmailAccount, previous, api: gmailApi({ expired: true }).api, progress: (message) => statuses.push(message) });
  assert(snapshot.messages.length === 2 && !snapshot.messages.some((message) => message.remoteId === 'stale'));
  assert(statuses.some((message) => message.includes('expired')));
});
await test('A failed contacts import and wrong-account authorization do not mutate the previous snapshot', async () => {
  const previous = await importMailbox({ account: gmailAccount, api: gmailApi().api });
  const before = JSON.stringify(previous);
  await rejects(() => importMailbox({ account: gmailAccount, previous, api: gmailApi({ failContacts: true }).api }), 'denied');
  await rejects(() => importMailbox({ account: gmailAccount, api: async () => ({ emailAddress: 'other@example.com' }) }), 'different account');
  assert(JSON.stringify(previous) === before);
});
await test('Outlook import follows pages, requests text and immutable IDs, and records per-folder delta links', async () => {
  const mock = graphApi();
  const snapshot = await importMailbox({ account: graphAccount, api: mock.api });
  assert(snapshot.messages.length === 2 && snapshot.contacts.length === 1 && isValidSnapshot(snapshot));
  assert(snapshot.cursors.inbox.includes('cursor=old') && snapshot.cursors.sentitems);
  assert(mock.calls.filter((call) => call.url.includes('/mailFolders/')).every((call) => call.headers.Prefer.includes('ImmutableId')));
});
await test('Outlook delta removes deleted messages and hydrates sparse change records', async () => {
  const previous = await importMailbox({ account: graphAccount, api: graphApi().api });
  const before = JSON.stringify(previous);
  const mock = graphApi({ delta: true, sparse: true });
  const snapshot = await importMailbox({ account: graphAccount, previous, api: mock.api });
  assert(snapshot.messages.length === 1 && snapshot.messages[0].remoteId === 'o1');
  assert(mock.calls.some((call) => call.url.includes('/me/messages/o1')));
  assert(JSON.stringify(previous) === before);
});
await test('Outlook expired deltas are rebuilt, malformed pages fail, and repeated next links are rejected', async () => {
  const previous = await importMailbox({ account: graphAccount, api: graphApi().api });
  const statuses = [];
  const snapshot = await importMailbox({ account: graphAccount, previous, api: graphApi({ expire: true }).api, progress: (message) => statuses.push(message) });
  assert(snapshot.messages.length === 2 && statuses.some((message) => message.includes('expired')));
  const base = graphApi().api;
  await rejects(() => importMailbox({ account: graphAccount, api: (url) => url.includes('/mailFolders/') ? Promise.resolve({ unexpected: [] }) : base(url) }), 'invalid collection');
  await rejects(() => importMailbox({ account: graphAccount, api: (url) => url.includes('/mailFolders/') ? Promise.resolve({ value: [], '@odata.nextLink': url }) : base(url) }), 'repeated');
});
await test('Outlook switches to full pagination at the filtered delta limit without dropping later messages', async () => {
  const base = graphApi().api;
  const messages = Array.from({ length: 5000 }, (_, index) => graphRaw(`large-${index}`));
  let fullCalls = 0, deltaCalls = 0;
  const api = async (url, headers) => {
    if (url.includes('/mailFolders/inbox/messages/delta')) {
      deltaCalls++;
      return { value: messages, '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?cursor=limited' };
    }
    if (url.includes('/mailFolders/inbox/messages?')) {
      fullCalls++;
      return new URL(url).searchParams.has('page')
        ? { value: [graphRaw('beyond-limit')] }
        : { value: messages, '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?page=2' };
    }
    return base(url, headers);
  };
  const first = await importMailbox({ account: graphAccount, api });
  assert(first.messages.length === 5001 && first.cursors.inbox === 'full');
  const second = await importMailbox({ account: graphAccount, previous: first, api });
  assert(second.messages.length === 5001 && deltaCalls === 1 && fullCalls === 4);
});
await test('Gmail detects repeated mail and contacts continuation tokens', async () => {
  const base = gmailApi().api;
  await rejects(() => importMailbox({ account: gmailAccount, api: (url) => new URL(url).pathname.endsWith('/messages')
    ? Promise.resolve({ messages: [], nextPageToken: 'repeat' }) : base(url) }), 'repeated a mail page');
  await rejects(() => importMailbox({ account: gmailAccount, api: (url) => url.includes('people.googleapis.com')
    ? Promise.resolve({ connections: [], nextPageToken: 'repeat' }) : base(url) }), 'repeated a contacts page');
});
await test('Imported contact overlaps merge safely without mutating per-account contact books', () => {
  const a = makeSnapshot(gmailAccount), b = makeSnapshot(graphAccount);
  const contact = { id: 'c1', name: 'Maya', emails: ['maya@example.com'], source: 'gmail', note: '', color: 'sage', accountId: gmailAccount.id };
  a.contacts = [contact, { ...contact, id: 'c2', emails: ['maya.work@example.com'] }];
  b.contacts = [{ ...contact, id: 'c3', emails: ['maya@example.com', 'maya.work@example.com'], source: 'outlook', accountId: graphAccount.id }];
  const before = JSON.stringify([a, b]);
  const combined = combineSnapshots([a, b]);
  assert(combined.contacts.length === 1 && combined.contacts[0].accountIds.length === 2);
  assert(combined.contacts[0].emails.length === 2 && JSON.stringify([a, b]) === before);
  assert(combineSnapshots([b]).contacts.length === 1);
});
await test('IndexedDB stores valid snapshots atomically, rejects invalid imports, and removes local account data', async () => {
  const name = `gather-provider-test-${crypto.randomUUID()}`;
  const store = await openMailboxStore(name);
  try {
    const snapshot = await importMailbox({ account: gmailAccount, api: gmailApi().api });
    await store.save(snapshot);
    assert((await store.list()).length === 1);
    await rejects(() => store.save({ ...snapshot, messages: [null] }), 'Invalid mailbox');
    assert((await store.list())[0].messages.length === 2);
    await store.remove(snapshot.account.id);
    assert((await store.list()).length === 0);
  } finally {
    store.close();
    await new Promise((resolve, reject) => {
      const deletion = indexedDB.deleteDatabase(name);
      deletion.onsuccess = resolve;
      deletion.onerror = () => reject(deletion.error);
    });
  }
});
await test('OAuth client ID validation rejects secrets, malformed IDs, and unsupported providers', async () => {
  assert(validateClientId('gmail', gmailAccount.clientId) === gmailAccount.clientId);
  assert(validateClientId('outlook', graphAccount.clientId) === graphAccount.clientId);
  for (const [provider, value] of [['gmail', 'a-secret'], ['outlook', 'client-secret'], ['other', graphAccount.clientId]]) {
    await rejects(() => validateClientId(provider, value), 'client');
  }
});
await test('Google authorization handles permissions, popup errors, wrong-account reconnects, and token cleanup', async () => {
  const originalGoogle = window.google;
  const originalFetch = window.fetch;
  let granted = true, config, failPopup = false;
  window.google = { accounts: { oauth2: {
    hasGrantedAllScopes: () => granted,
    initTokenClient: (options) => {
      config = options;
      return { requestAccessToken: () => failPopup ? options.error_callback({ type: 'popup_closed' })
        : options.callback({ access_token: 'test-access-token', expires_in: 3600 }) };
    },
  } } };
  window.fetch = async () => new Response(JSON.stringify({ emailAddress: gmailAccount.email }));
  try {
    const connect = await prepareSignIn('gmail', gmailAccount.clientId);
    const account = await connect();
    assert(hasSession(account.id) && config.include_granted_scopes === false);
    assert(config.scope.includes('gmail.readonly') && !config.scope.includes('gmail.modify'));
    await forgetSession(account.id);
    assert(!hasSession(account.id));
    await rejects(() => getAccountApi(account), 'Reconnect');
    granted = false;
    await rejects(() => connect(), 'Both read-only');
    granted = true;
    await rejects(() => connect(undefined, 'gmail:other@example.com'), 'different account');
    assert(!hasSession(account.id));
    failPopup = true;
    await rejects(() => connect(), 'cancelled');
  } finally {
    window.google = originalGoogle;
    window.fetch = originalFetch;
  }
});
await test('Microsoft auth uses PKCE SDK with memory-only caches and read-only permissions', async () => {
  const originalMsal = window.msal, originalFetch = window.fetch;
  let configuration, scopes, cleared = false;
  window.msal = {
    PublicClientApplication: class {
      constructor(config) { configuration = config; }
      async initialize() {}
      async acquireTokenPopup(request) { scopes = request.scopes; return { account: { homeAccountId: 'test' } }; }
      async acquireTokenSilent() { return { accessToken: 'ms-token' }; }
      async clearCache() { cleared = true; }
    },
    InteractionRequiredAuthError: class extends Error {},
  };
  window.fetch = async () => new Response(JSON.stringify({ id: 'user-1', mail: graphAccount.email }));
  try {
    const connect = await prepareSignIn('outlook', graphAccount.clientId);
    const account = await connect();
    assert(configuration.cache.cacheLocation === 'memoryStorage' && configuration.cache.temporaryCacheLocation === 'memoryStorage');
    assert(configuration.auth.redirectUri.endsWith('/oauth-redirect.html'));
    assert(scopes.join(',') === 'User.Read,Mail.Read,Contacts.Read');
    await forgetSession(account.id);
    assert(cleared && !hasSession(account.id));
  } finally { window.msal = originalMsal; window.fetch = originalFetch; }
});

for (const result of results) {
  const item = document.createElement('li');
  item.className = result.passed ? 'pass' : 'fail';
  item.textContent = `${result.passed ? 'PASS' : 'FAIL'}: ${result.name}${result.error ? ` — ${result.error}` : ''}`;
  document.querySelector('#results').append(item);
}
const failures = results.filter((result) => !result.passed);
document.querySelector('#summary').textContent = `${results.length - failures.length}/${results.length} checks passed.`;
document.title = failures.length ? 'FAIL — Gather provider checks' : 'PASS — Gather provider checks';
window.testResults = results;

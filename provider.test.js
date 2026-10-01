import { createApi, ProviderError, plainTextFromHtml, gmailMessage, graphMessage, importMailbox, combineSnapshots, discoverFolders } from './provider-mail.js';
import { openMailboxStore, isValidSnapshot } from './mailbox-store.js';
import { validateClientId, prepareSignIn, hasSession, forgetSession, getAccountApi } from './auth.js';
import { conversationMessages, visibleMessages, visibleConversations, replyToConversation, providerFolderId, conversationAddress, isOutgoing } from './mail.js';

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
    if (parsed.pathname.endsWith('/labels')) return { labels: ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD'].map((id) => ({ id, name: id, type: 'system' })) };
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
    if (parsed.pathname.endsWith('/mailFolders')) return { value: [
      { id: 'inbox', displayName: 'Inbox', childFolderCount: 0 },
      { id: 'sentitems', displayName: 'Sent Items', childFolderCount: 0 },
    ] };
    if (/\/mailFolders\/[^/]+$/.test(parsed.pathname)) {
      const id = parsed.pathname.split('/').at(-1);
      if (!['inbox', 'sentitems'].includes(id)) throw new ProviderError('Folder absent', 404);
      return { id };
    }
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

function allGraphFolders({ round = 0, removed = false, fail = false } = {}) {
  const calls = [];
  const catalog = [
    { id: 'box-in', displayName: 'Boite de reception', kind: 'inbox' },
    { id: 'box-sent', displayName: 'Envoyes', kind: 'sentitems' },
    { id: 'box-archive', displayName: 'Archives', kind: 'archive' },
    { id: 'box-draft', displayName: 'Brouillons', kind: 'drafts' },
    { id: 'box-junk', displayName: 'Courrier indesirable', kind: 'junkemail' },
    { id: 'box-trash', displayName: 'Supprimes', kind: 'deleteditems', childFolderCount: 1 },
    { id: 'box-out', displayName: 'En attente', kind: 'outbox' },
    { id: 'projects', displayName: round ? 'Renamed Projects' : 'Projects', childFolderCount: removed ? 0 : 1 },
    { id: 'search', displayName: 'Search results', '@odata.type': '#microsoft.graph.mailSearchFolder' },
    { id: 'hidden', displayName: 'Hidden mail', isHidden: true },
    { id: 'empty', displayName: 'Empty folder' },
  ].map(item => ({ childFolderCount: 0, isHidden: false, ...item }));
  const folderItems = (id) => {
    const message = (messageId, extra = {}) => ({ ...graphRaw(messageId), parentFolderId: id, ...extra });
    if (id === 'box-in') return round ? [{ id: 'incoming', '@removed': { reason: 'deleted' } }]
      : [message('incoming')];
    if (id === 'box-sent') return [message('outgoing', { from: { emailAddress: { address: graphAccount.email } }, toRecipients: [{ emailAddress: { address: 'maya@example.com' } }] })];
    if (id === 'box-draft') return [message('unfinished', {
      isDraft: true, conversationId: undefined, from: undefined, toRecipients: [], receivedDateTime: undefined,
      lastModifiedDateTime: new Date(now - 500).toISOString(),
    })];
    if (id === 'box-out') return [message('pending', { from: { emailAddress: { address: graphAccount.email } } })];
    if (id === 'box-junk') return [message('junk')];
    if (id === 'box-trash') return [message('trashed')];
    if (id === 'trash-child') return [message('nested-trashed')];
    if (id === 'hidden') return [message('hidden-mail')];
    if (id === 'projects') return round ? [{ id: 'moved', '@removed': { reason: 'deleted' } }] : [message('moved')];
    if (id === 'client/child') return round ? [message('moved')] : [message('nested')];
    if (id === 'search') return [message(round ? 'moved' : 'incoming', { parentFolderId: round ? 'client/child' : 'box-in' })];
    return [];
  };
  const api = async (url, headers) => {
    calls.push({ url, headers });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/me')) return { id: 'user-1', mail: graphAccount.email };
    if (parsed.pathname.endsWith('/contacts')) return { value: [] };
    if (parsed.pathname.endsWith('/mailFolders')) return parsed.searchParams.has('page')
      ? { value: catalog.slice(5) }
      : { value: catalog.slice(0, 5), '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders?page=2&includeHiddenFolders=true' };
    const match = /\/mailFolders\/([^/]+)(.*)/.exec(parsed.pathname);
    if (!match) throw new Error(`Unexpected all-folder URL: ${url}`);
    const id = decodeURIComponent(match[1]), suffix = match[2];
    if (!suffix) {
      const system = catalog.find(folder => folder.kind === id);
      if (!system) throw new ProviderError('Not found', 404);
      return { id: system.id };
    }
    if (suffix === '/childFolders') {
      if (id === 'projects') return { value: [{ id: 'client/child', displayName: 'Client', childFolderCount: 0, isHidden: false }] };
      if (id === 'box-trash') return { value: [{ id: 'trash-child', displayName: 'Deleted project', childFolderCount: 0, isHidden: false }] };
      throw new Error('Unexpected child-folder request');
    }
    if (fail && id === 'client/child') throw new ProviderError('Folder access denied', 403);
    const value = folderItems(id);
    if (suffix === '/messages/delta') return {
      value, '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(id)}/messages/delta?cursor=${round}`,
    };
    if (suffix === '/messages') return { value };
    throw new Error(`Unexpected folder URL ${url}`);
  };
  return { api, calls };
}

await test('Outlook discovers paginated, localized, nested, hidden, and search folders', async () => {
  const mock = allGraphFolders();
  const folders = await discoverFolders(graphAccount, mock.api);
  assert(folders.length === 13);
  assert(folders.find(folder => folder.remoteId === 'box-in').kind === 'inbox');
  assert(folders.find(folder => folder.remoteId === 'client/child').path === 'Projects/Client');
  assert(folders.find(folder => folder.remoteId === 'client/child').parentId === providerFolderId(graphAccount.id, 'projects'));
  assert(folders.find(folder => folder.remoteId === 'trash-child').kind === 'trash');
  assert(folders.find(folder => folder.remoteId === 'hidden').hidden);
  assert(folders.find(folder => folder.remoteId === 'search').search);
  assert(mock.calls.some(call => call.url.includes('page=2')));
  assert(mock.calls.filter(call => call.url.includes('/childFolders')).every(call => call.url.includes('includeHiddenFolders=true')));
});
await test('Outlook syncs every discovered folder and keeps recipient-less drafts and outgoing mail distinct', async () => {
  const mock = allGraphFolders();
  const snapshot = await importMailbox({ account: graphAccount, api: mock.api });
  assert(snapshot.folderFormat === 1 && snapshot.folders.length === 13 && isValidSnapshot(snapshot));
  for (const folder of snapshot.folders) assert(mock.calls.some(call => call.url.includes(`/mailFolders/${encodeURIComponent(folder.remoteId)}/messages`)));
  const draft = snapshot.messages.find(message => message.remoteId === 'unfinished');
  assert(draft.isDraft && draft.folder === 'drafts' && draft.recipientMissing && draft.sender === graphAccount.email);
  assert(draft.body && isOutgoing(draft));
  assert(snapshot.messages.find(message => message.remoteId === 'pending').folder === 'outbox');
  assert(snapshot.messages.find(message => message.remoteId === 'junk').folder === 'spam');
  assert(snapshot.messages.find(message => message.remoteId === 'nested-trashed').folder === 'trash');
  const incoming = snapshot.messages.find(message => message.remoteId === 'incoming');
  assert(incoming.folder === 'inbox' && incoming.folderIds.length === 2, 'Search results must not duplicate or reclassify physical mail');
  assert(snapshot.cursors['box-draft'] === 'full' && snapshot.cursors.search === 'full');
  assert(mock.calls.filter(call => call.url.includes('/box-draft/messages')).every(call => !call.url.includes('$filter')));
  const state = combineSnapshots([snapshot]);
  assert(visibleMessages(state, { folder: providerFolderId(graphAccount.id, 'client/child') }).length === 1);
  assert(!visibleMessages(state, { folder: 'archive' }).some(message => message.remoteId === 'moved'));
  assert(!visibleMessages(state, { folder: 'starred' }).some(message => ['spam', 'trash', 'drafts'].includes(message.folder)));
  assert(conversationMessages(state, draft.id).length === 1, 'Unsent draft must not join a delivered-message conversation');
});
await test('Folder sync updates moves, names, memberships, deleted folders, and their cursors atomically', async () => {
  const previous = await importMailbox({ account: graphAccount, api: allGraphFolders().api });
  const before = JSON.stringify(previous);
  const moved = await importMailbox({ account: graphAccount, previous, api: allGraphFolders({ round: 1 }).api });
  const message = moved.messages.find(entry => entry.remoteId === 'moved');
  assert(!message.folderIds.includes(providerFolderId(graphAccount.id, 'projects')));
  assert(message.folderIds.includes(providerFolderId(graphAccount.id, 'client/child')));
  assert(moved.folders.find(folder => folder.remoteId === 'client/child').path === 'Renamed Projects/Client');
  assert(!moved.messages.some(entry => entry.remoteId === 'incoming'));
  assert(JSON.stringify(previous) === before);
  const removed = await importMailbox({ account: graphAccount, previous, api: allGraphFolders({ removed: true }).api });
  assert(!removed.folders.some(folder => folder.remoteId === 'client/child'));
  assert(!Object.hasOwn(removed.cursors, 'client/child'));
  assert(!removed.messages.some(entry => entry.remoteId === 'nested'));
  await rejects(() => importMailbox({ account: graphAccount, previous, api: allGraphFolders({ fail: true }).api }), 'denied');
  assert(JSON.stringify(previous) === before);
});
await test('New Outlook folders get an initial sync even when other folders have delta cursors', async () => {
  const previous = await importMailbox({ account: graphAccount, api: allGraphFolders().api });
  const mock = allGraphFolders({ round: 1 });
  const snapshot = await importMailbox({ account: graphAccount, previous, api: async (url, headers) => {
    const response = await mock.api(url, headers);
    if (new URL(url).pathname.endsWith('/mailFolders') && !new URL(url).searchParams.has('page')) {
      response.value.push({ id: 'new-folder', displayName: 'New folder', childFolderCount: 0, isHidden: false });
    }
    return response;
  } });
  assert(snapshot.folders.some(folder => folder.remoteId === 'new-folder'));
  const request = mock.calls.find(call => call.url.includes('/mailFolders/new-folder/messages/delta?'));
  assert(request && request.url.includes('$select=') && !request.url.includes('cursor='));
  assert(snapshot.cursors['new-folder'] && isValidSnapshot(snapshot));
});
await test('Moving a folder beneath Deleted Items reclassifies unchanged cached messages', async () => {
  const mock = allGraphFolders();
  const previous = await importMailbox({ account: graphAccount, api: mock.api });
  const update = allGraphFolders();
  const snapshot = await importMailbox({ account: graphAccount, previous, api: async (url, headers) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/mailFolders/projects/childFolders')) return { value: [] };
    if (parsed.pathname.endsWith('/mailFolders/box-trash/childFolders')) return { value: [
      { id: 'trash-child', displayName: 'Deleted project', childFolderCount: 0, isHidden: false },
      { id: 'client/child', displayName: 'Client', childFolderCount: 0, isHidden: false },
    ] };
    if (parsed.pathname.includes('/mailFolders/client%2Fchild/messages/delta') && parsed.searchParams.has('cursor')) {
      return { value: [], '@odata.deltaLink': url };
    }
    return update.api(url, headers);
  } });
  assert(snapshot.messages.find(message => message.remoteId === 'nested').folder === 'trash');
  assert(snapshot.folders.find(folder => folder.remoteId === 'client/child').path === 'Supprimes/Client');
});
await test('Legacy snapshots migrate once to all-folder sync while preserving the selected start date', async () => {
  const previous = await importMailbox({ account: gmailAccount, api: gmailApi().api });
  delete previous.folderFormat;
  delete previous.folders;
  previous.messages.forEach(message => { delete message.folderIds; });
  assert(isValidSnapshot(previous));
  const mock = gmailApi();
  const updated = await importMailbox({ account: gmailAccount, previous, api: mock.api });
  assert(updated.folderFormat === 1 && updated.since === previous.since);
  const request = mock.calls.find(url => new URL(url).pathname.endsWith('/messages'));
  assert(new URL(request).searchParams.get('includeSpamTrash') === 'true');
  assert(!new URL(request).searchParams.get('q').includes('-in:'));
  assert(isValidSnapshot(updated));
});
await test('Gmail nested labels and multiple memberships do not duplicate messages or leak across accounts', async () => {
  const base = gmailApi().api;
  const api = async url => {
    if (url.endsWith('/labels')) return { labels: [
      { id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'p', name: 'Projects', type: 'user' },
      { id: 'c', name: 'Projects/Client', type: 'user' }, { id: 'z', name: 'Empty', type: 'user' },
    ] };
    if (url.includes('/messages/')) return gmailRaw(new URL(url).pathname.split('/').at(-1), ['INBOX', 'p', 'c']);
    return base(url);
  };
  const snapshot = await importMailbox({ account: gmailAccount, api });
  assert(snapshot.messages.length === 2 && snapshot.folders.find(folder => folder.remoteId === 'c').parentId === providerFolderId(gmailAccount.id, 'p'));
  const otherAccount = { ...gmailAccount, id: 'gmail:other@example.com', email: 'other@example.com' };
  const other = { ...snapshot, account: otherAccount, messages: snapshot.messages.map(message => ({ ...message, id: `other-${message.id}`, accountId: otherAccount.id,
    folderIds: ['INBOX', 'p', 'c'].map(id => providerFolderId(otherAccount.id, id)) })), contacts: [], folders: snapshot.folders.map(folder => ({
      ...folder, id: providerFolderId(otherAccount.id, folder.remoteId), accountId: otherAccount.id,
    })) };
  const combined = combineSnapshots([snapshot, other]);
  assert(visibleMessages(combined, { folder: providerFolderId(gmailAccount.id, 'c') }).length === 2);
  assert(visibleMessages(combined, { folder: providerFolderId(gmailAccount.id, 'c'), account: otherAccount.id }).length === 0);
  assert(visibleMessages(combined, { folder: providerFolderId(gmailAccount.id, 'z') }).length === 0);
});
await test('Gmail label deletion removes membership without losing mail or mutating the old snapshot', async () => {
  const previous = await importMailbox({ account: gmailAccount, api: gmailApi().api });
  const before = JSON.stringify(previous);
  const base = gmailApi().api;
  const updated = await importMailbox({ account: gmailAccount, previous, api: url => {
    if (url.endsWith('/labels')) return Promise.resolve({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] });
    if (url.includes('/history?')) return Promise.resolve({ history: [], historyId: '101' });
    return base(url);
  } });
  assert(updated.messages.length === previous.messages.length);
  assert(updated.messages.every(message => message.folderIds.length === 1));
  assert(JSON.stringify(previous) === before);
});
await test('Drafts tolerate incomplete addressing and are never labeled or grouped as sent', () => {
  const raw = gmailRaw('draft', ['DRAFT']);
  raw.payload.headers = [{ name: 'Subject', value: 'Unfinished' }];
  const message = gmailMessage(raw, gmailAccount, since);
  assert(message.sender === gmailAccount.email && message.recipientMissing && message.isDraft && message.folder === 'drafts');
  const sent = gmailMessage(gmailRaw('sent', ['SENT', 'TRASH']), gmailAccount, since);
  assert(sent.folder === 'trash' && sent.outgoing);
  assert(conversationAddress(sent) === sent.to);
  assert(visibleMessages({ messages: [message, sent], contacts: [] }, { folder: 'sent' }).length === 0);
});
await test('Bad folder membership and malformed catalogs are rejected instead of replacing valid cache', async () => {
  const snapshot = await importMailbox({ account: gmailAccount, api: gmailApi().api });
  snapshot.messages[0].folderIds = ['unrecognized'];
  assert(!isValidSnapshot(snapshot));
  const base = gmailApi().api;
  await rejects(() => importMailbox({ account: gmailAccount, api: url => url.endsWith('/labels') ? Promise.resolve({}) : base(url) }), 'invalid label');
  const graph = graphApi().api;
  await rejects(() => discoverFolders(graphAccount, url => new URL(url).pathname.endsWith('/mailFolders')
    ? Promise.resolve({ value: [{ id: 'broken', displayName: 'Incomplete' }] }) : graph(url)), 'incomplete folder');
});

await test('Gmail MIME decoding preserves Unicode, account identity, flags, and provider thread IDs', () => {
  const message = gmailMessage(gmailRaw(), gmailAccount, since);
  assert(message.body === 'Hello, café 🌿');
  assert(message.sender === 'maya@example.com' && message.to === gmailAccount.email);
  assert(message.remote && message.unread && message.folder === 'inbox' && message.threadId === 'g-thread');
});
await test('Gmail and Outlook retain Cc separately for reply-all while keeping visible participants', () => {
  const gmail = gmailRaw();
  gmail.payload.headers.push({ name: 'Cc', value: 'Teammate <TEAM@example.com>, Other <other@example.com>' });
  const googleMessage = gmailMessage(gmail, gmailAccount, since);
  assert(googleMessage.ccRecipients.join() === 'team@example.com,other@example.com');
  const outlook = graphRaw();
  outlook.ccRecipients = [{ emailAddress: { address: 'TEAM@example.com' } }];
  const microsoftMessage = graphMessage(outlook, graphAccount, 'inbox', since);
  assert(microsoftMessage.ccRecipients.join() === 'team@example.com' && microsoftMessage.participants.includes('team@example.com'));
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
  const normalized = gmailMessage(raw, gmailAccount, since);
  assert(normalized.body === 'Plain alternative');
  assert(normalized.bodyHtml === '<p>HTML alternative</p>');
  raw.payload.parts = [{ mimeType: 'text/plain', body: { attachmentId: 'large-body' } }];
  assert(gmailMessage(raw, gmailAccount, since).body.includes('stored this body as an attachment'));
});
await test('Gmail includes drafts, trash, and spam while honoring the selected starting date', () => {
  for (const [label, folder] of [['DRAFT', 'drafts'], ['TRASH', 'trash'], ['SPAM', 'spam']]) {
    const message = gmailMessage(gmailRaw('g1', [label]), gmailAccount, since);
    assert(message.folder === folder && message.folderIds.includes(providerFolderId(gmailAccount.id, label)));
  }
  const old = gmailRaw();
  old.internalDate = String(now - 60 * 86400000);
  assert(gmailMessage(old, gmailAccount, since) === null);
});
await test('Outlook body text and HTML normalize to inert text with provider flags', () => {
  const raw = graphRaw();
  raw.body = { contentType: 'HTML', content: '<p>Hello</p><img src="https://tracking.invalid/x">' };
  const message = graphMessage(raw, graphAccount, 'inbox', since);
  assert(message.body === 'Hello' && message.starred && message.unread);
  assert(message.bodyHtml === raw.body.content);
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
await test('Google disabled-API errors identify the failing service, project action, and operation', async () => {
  for (const [url, service, operation] of [
    ['https://people.googleapis.com/v1/people/me/connections', 'People API', 'contacts sync'],
    ['https://gmail.googleapis.com/gmail/v1/users/me/labels', 'Gmail API', 'folder/label discovery'],
  ]) {
    for (const error of [
      { errors: [{ reason: 'accessNotConfigured' }], message: 'PRIVATE_PROVIDER_MESSAGE' },
      { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED',
        metadata: { consumer: 'PRIVATE_PROJECT', activationUrl: 'https://untrusted.invalid/' } }], status: 'PERMISSION_DENIED' },
    ]) {
      let calls = 0, failure;
      const api = createApi(async () => 'PRIVATE_TOKEN', 'gmail', undefined, async () => {
        calls++;
        return new Response(JSON.stringify({ error }), { status: 403 });
      });
      try { await api(url); } catch (exception) { failure = exception; }
      assert(failure?.status === 403 && failure.message.includes(service) && failure.message.includes(operation));
      assert(failure.message.includes('project that owns your OAuth client ID') && failure.message.includes('SERVICE_DISABLED'));
      assert(!failure.message.includes('PRIVATE') && !failure.message.includes('untrusted.invalid'));
      assert(calls === 1, 'Disabled APIs must not be retried as transient failures');
    }
  }
});
await test('Google missing-scope errors name the exact mail or contacts scope without retrying', async () => {
  for (const [url, scope] of [
    ['https://people.googleapis.com/v1/people/me/connections', 'contacts.readonly'],
    ['https://gmail.googleapis.com/gmail/v1/users/me/messages', 'gmail.readonly'],
  ]) {
    let calls = 0;
    const api = createApi(async () => 'token', 'gmail', undefined, async () => {
      calls++;
      return new Response(JSON.stringify({ error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }), { status: 403 });
    });
    await rejects(() => api(url), scope);
    assert(calls === 1);
  }
});
await test('Google domain and daily quota failures give distinct actions rather than consent advice', async () => {
  for (const [reason, expected] of [['domainPolicy', 'administrator'], ['dailyLimitExceeded', 'quota'], ['QUOTA_EXCEEDED', 'quota']]) {
    let calls = 0;
    const api = createApi(async () => 'token', 'gmail', undefined, async () => {
      calls++;
      return new Response(JSON.stringify({ error: { errors: [{ reason }] } }), { status: 403 });
    });
    await rejects(() => api('https://gmail.googleapis.com/gmail/v1/users/me/profile'), expected);
    assert(calls === 1);
  }
});
await test('Transient Google 403 rate limits retry and recover without reporting permission denial', async () => {
  let calls = 0;
  const waits = [], statuses = [];
  const api = createApi(async () => 'token', 'gmail', undefined, async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }), { status: 403 })
      : new Response('{"messages":[]}');
  }, { wait: async (delay) => { waits.push(delay); }, onWait: (message) => statuses.push(message) });
  const result = await api('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  assert(calls === 2 && Array.isArray(result.messages));
  assert(waits.join() === '5000' && statuses[0].includes('Waiting 5 seconds'));
});
await test('Persistent Google 403 rate limits stop after bounded retries with a specific error', async () => {
  let calls = 0;
  const waits = [];
  const api = createApi(async () => 'token', 'gmail', undefined, async () => {
    calls++;
    return new Response(JSON.stringify({ error: { details: [{ reason: 'RATE_LIMIT_EXCEEDED' }] } }), { status: 403 });
  }, { wait: async (delay) => { waits.push(delay); } });
  await rejects(() => api('https://people.googleapis.com/v1/people/me/connections'), 'RATE_LIMIT_EXCEEDED');
  assert(calls === 5 && waits.join() === '5000,10000,20000,40000');
});
await test('Google rate limits honor long Retry-After and cancellation during retry backoff', async () => {
  const payload = JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } });
  let calls = 0;
  const api = createApi(async () => 'token', 'gmail', undefined, async () => {
    calls++;
    return new Response(payload, { status: 403, headers: { 'Retry-After': '180' } });
  });
  await rejects(() => api('https://gmail.googleapis.com/gmail/v1/users/me/messages'), '180 second pause');
  assert(calls === 1);
  const controller = new AbortController();
  let abortedCalls = 0;
  const cancellable = createApi(async () => 'token', 'gmail', controller.signal, async () => {
    abortedCalls++;
    setTimeout(() => controller.abort(), 10);
    return new Response(payload, { status: 403 });
  });
  await rejects(() => cancellable('https://gmail.googleapis.com/gmail/v1/users/me/messages'));
  assert(abortedCalls === 1);
});
await test('Gmail requests are paced across API clients and honor Retry-After within the retry budget', async () => {
  const starts = [];
  const fetcher = async () => { starts.push(Date.now()); return new Response('{}'); };
  const first = createApi(async () => 'token-a', 'gmail', undefined, fetcher);
  const second = createApi(async () => 'token-b', 'gmail', undefined, fetcher);
  await Promise.all([
    first('https://gmail.googleapis.com/gmail/v1/users/me/messages'),
    second('https://gmail.googleapis.com/gmail/v1/users/me/labels'),
    first('https://gmail.googleapis.com/gmail/v1/users/me/profile'),
  ]);
  assert(starts[1] - starts[0] >= 180 && starts[2] - starts[1] >= 180, 'Requests must not burst across clients');
  const waits = [];
  let calls = 0;
  const api = createApi(async () => 'token', 'gmail', undefined, async () => ++calls === 1
    ? new Response(JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }), { status: 403, headers: { 'Retry-After': '60' } })
    : new Response('{}'), { wait: async (delay) => { waits.push(delay); } });
  await api('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  assert(calls === 2 && waits.join() === '60000');
});
await test('Malformed or unrecognized 403 responses retain service and HTTP context without leaking raw content', async () => {
  for (const body of ['', '<html>PRIVATE_TOKEN</html>', 'null', '{"error":{"details":"not-an-array","errors":[null],"message":"PRIVATE_TOKEN"}}']) {
    const api = createApi(async () => 'token', 'gmail', undefined, async () => new Response(body, { status: 403 }));
    let failure;
    try { await api('https://people.googleapis.com/v1/people/me/connections'); } catch (error) { failure = error; }
    assert(failure.message.includes('People API (contacts sync)') && failure.message.includes('HTTP 403'));
    assert(!failure.message.includes('PRIVATE'));
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
await test('Outlook import follows pages, requests HTML and immutable IDs, and records per-folder delta links', async () => {
  const mock = graphApi();
  const snapshot = await importMailbox({ account: graphAccount, api: mock.api });
  assert(snapshot.messages.length === 2 && snapshot.contacts.length === 1 && isValidSnapshot(snapshot));
  assert(snapshot.cursors.inbox.includes('cursor=old') && snapshot.cursors.sentitems);
  assert(mock.calls.filter((call) => call.url.includes('/mailFolders/') && call.url.includes('/messages')).every((call) =>
    call.headers.Prefer.includes('ImmutableId') && call.headers.Prefer.includes('outlook.body-content-type="html"')));
});
await test('Old text-only Gmail caches rebuild to fetch unchanged HTML without changing the original start date', async () => {
  const previous = await importMailbox({ account: gmailAccount, api: gmailApi().api });
  delete previous.bodyFormat;
  const mock = gmailApi();
  const updated = await importMailbox({ account: gmailAccount, previous, api: mock.api });
  assert(updated.bodyFormat === 3 && updated.since === previous.since);
  assert(mock.calls.some((url) => new URL(url).pathname.endsWith('/messages')));
  assert(!mock.calls.some((url) => new URL(url).pathname.endsWith('/history')));
});
await test('Old Outlook caches discard text-only delta cursors and request fresh HTML bodies', async () => {
  const previous = await importMailbox({ account: graphAccount, api: graphApi().api });
  delete previous.bodyFormat;
  const mock = graphApi();
  const updated = await importMailbox({ account: graphAccount, previous, api: mock.api });
  assert(updated.bodyFormat === 3 && updated.since === previous.since);
  assert(mock.calls.some((call) => call.url.includes('/mailFolders/inbox/messages/delta?') && call.url.includes('$select=')));
  assert(!mock.calls.some((call) => call.url.includes('cursor=')));
});
await test('HTML mailbox content persists and malformed HTML fields are rejected without invalidating old caches', async () => {
  const snapshot = await importMailbox({ account: gmailAccount, api: gmailApi().api });
  assert(isValidSnapshot(snapshot));
  snapshot.messages[0].bodyHtml = '<p><strong>Formatted text</strong></p>';
  assert(isValidSnapshot(JSON.parse(JSON.stringify(snapshot))));
  snapshot.messages[0].bodyHtml = { html: '<p>not a string</p>' };
  assert(!isValidSnapshot(snapshot));
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
  await rejects(() => importMailbox({ account: graphAccount, api: (url) => url.includes('/mailFolders/') && url.includes('/messages') ? Promise.resolve({ unexpected: [] }) : base(url) }), 'invalid collection');
  await rejects(() => importMailbox({ account: graphAccount, api: (url) => url.includes('/mailFolders/') && url.includes('/messages') ? Promise.resolve({ value: [], '@odata.nextLink': url }) : base(url) }), 'repeated');
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
    assert((await store.list())[0].folders.length === 7 && (await store.list())[0].folderFormat === 1);
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
await test('Microsoft auth uses PKCE SDK with memory-only caches and explicit sending permission', async () => {
  const originalMsal = window.msal, originalFetch = window.fetch;
  let configuration, scopes, cleared = false;
  window.msal = {
    PublicClientApplication: class {
      constructor(config) { configuration = config; }
      async initialize() {}
      async acquireTokenPopup(request) { scopes = request.scopes; return { account: { homeAccountId: 'test' }, scopes: request.scopes }; }
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
    assert(configuration.auth.redirectUri === new URL('./oauth-redirect.html', document.baseURI).href);
    assert(scopes.join(',') === 'User.Read,Mail.Read,Contacts.Read,Mail.Send');
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

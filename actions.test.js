import { unknownSenders, updateDemoConversation, createActionRequest, changeProviderConversation, addProviderSender } from './conversation-actions.js';
import { createDemo, conversationMessages, providerFolderId, isValidState } from './mail.js';
import { prepareSignIn, canManageMail, canManageContacts, mutationToken, forgetSession } from './auth.js';

const results = [];
async function test(name, check) {
  try { await check(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
}
function assert(value, message = 'Assertion failed') { if (!value) throw new Error(message); }
async function rejects(fn, expected) {
  try { await fn(); } catch (error) {
    assert(!expected || error.message.includes(expected), error.message);
    return error;
  }
  throw new Error('Expected a rejection');
}
function snapshot(provider = 'gmail') {
  const account = { id: provider === 'gmail' ? 'gmail:me@example.com' : 'outlook:test', provider, email: 'me@example.com', clientId: 'test' };
  const folder = (remoteId, kind) => ({ remoteId, kind, id: providerFolderId(account.id, remoteId), accountId: account.id });
  const folders = provider === 'gmail' ? [folder('INBOX', 'label'), folder('SENT', 'label'), folder('TRASH', 'label')]
    : ['inbox', 'sent', 'drafts', 'spam', 'trash', 'archive', 'outbox', 'other'].map(kind => folder(`folder-${kind}`, kind));
  const messages = ['inbox', 'sent'].map((kind, index) => ({
    id: `local-${index}`, remoteId: `remote-${index}`, remote: true, accountId: account.id, threadId: "thread'id",
    sender: index ? account.email : 'sender@example.com', senderName: index ? 'Me' : 'Sender',
    to: index ? 'sender@example.com' : account.email, outgoing: Boolean(index), isDraft: false,
    folder: kind, folderIds: [providerFolderId(account.id, provider === 'gmail' ? kind.toUpperCase() : `folder-${kind}`)],
    providerParentId: `folder-${kind}`, subject: 'Example', body: 'Message', unread: !index, starred: false,
  }));
  return { account, folders, messages, contacts: [] };
}
function apiFor(state, threadMessages = []) {
  return async url => {
    if (url.endsWith('/profile')) return { emailAddress: state.account.email };
    if (url.includes('/me?$select=')) return { id: 'test', mail: state.account.email };
    if (url.includes('/threads/')) return { messages: threadMessages.length ? threadMessages
      : [{ id: 'remote-0', labelIds: ['INBOX'] }, { id: 'remote-1', labelIds: ['SENT'] }, { id: 'old-uncached', labelIds: ['INBOX'] }] };
    if (url.includes('/mailFolders/archive?')) return { id: 'folder-archive' };
    if (url.includes('/mailFolders/deleteditems?')) return { id: 'folder-trash' };
    if (url.includes('/me/messages?')) return { value: threadMessages, '@odata.nextLink': undefined };
    if (url.includes('/people/me/connections')) return { connections: [] };
    if (url.includes('/me/contacts?')) return { value: [] };
    throw new Error(`Unexpected fixture URL ${url}`);
  };
}

await test('Unknown sender candidates are scoped, deduplicated, and exclude own and known senders', () => {
  const state = snapshot();
  state.messages.push({ ...state.messages[0], id: 'duplicate' }, { ...state.messages[0], id: 'other', threadId: 'other', sender: 'other@example.com' });
  assert(unknownSenders(state, 'local-0').length === 1);
  state.contacts = [{ id: 'known', emails: ['SENDER@example.com'] }];
  assert(unknownSenders(state, 'local-0').length === 0);
});
await test('Demo archive preserves sent mail; Trash moves the complete conversation and survives reload', () => {
  const original = createDemo(), before = JSON.stringify(original);
  const archived = updateDemoConversation(original, 'm1', 'archive');
  assert(archived.messages.find(message => message.id === 'm1').folder === 'archive');
  assert(archived.messages.find(message => message.id === 'demo-reply-m1').folder === 'sent');
  const trashed = updateDemoConversation(archived, 'm1', 'trash');
  assert(conversationMessages(trashed, 'm1').length === 2);
  assert(conversationMessages(trashed, 'm1').every(message => message.folder === 'trash'));
  assert(isValidState(JSON.parse(JSON.stringify(trashed))) && JSON.stringify(original) === before);
});
await test('Mutation transport permits only specific reversible action endpoints', async () => {
  const calls = [];
  const post = createActionRequest(async () => 'test-token', 'gmail', async (url, options) => {
    calls.push({ url, options }); return new Response('{}');
  });
  await post('https://gmail.googleapis.com/gmail/v1/users/me/threads/id/trash');
  assert(calls[0].options.method === 'POST' && calls[0].options.body === undefined);
  assert(calls[0].options.credentials === 'omit' && calls[0].options.redirect === 'error');
  for (const url of ['https://gmail.googleapis.com/gmail/v1/users/me/threads/id', 'https://attacker.invalid/trash',
    'https://people.googleapis.com/v1/people/id:deleteContact', 'https://user@gmail.googleapis.com/gmail/v1/users/me/threads/id/trash']) {
    await rejects(() => post(url), 'Unsupported');
  }
  assert(calls.length === 1);
});
await test('Mutation errors never auto-retry and distinguish rejection from uncertain outcome', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    let count = 0;
    const post = createActionRequest(async () => 'token', 'outlook', async () => { count++; return new Response('{}', { status }); });
    const failure = await rejects(() => post('https://graph.microsoft.com/v1.0/me/messages/id/move', { destinationId: 'deleteditems' }));
    assert(count === 1 && failure.uncertain === (status === 500));
  }
  const post = createActionRequest(async () => 'token', 'gmail', async () => { throw new TypeError('Offline'); });
  assert((await rejects(() => post('https://gmail.googleapis.com/gmail/v1/users/me/threads/id/trash'))).uncertain);
});
await test('Gmail uses full provider-thread archive and trash, including uncached history', async () => {
  const state = snapshot(), before = JSON.stringify(state), calls = [];
  const post = async (url, body) => { calls.push({ url, body }); return {}; };
  const archived = await changeProviderConversation(state, 'local-0', 'archive', apiFor(state), post);
  assert(archived.changed === 2 && calls[0].url.endsWith('/modify'));
  assert(JSON.stringify(calls[0].body) === '{"removeLabelIds":["INBOX"]}');
  assert(archived.updates.length === 1 && archived.updates[0].folder === 'archive');
  const trashed = await changeProviderConversation(state, 'local-0', 'trash', apiFor(state), post);
  assert(trashed.changed === 3 && trashed.updates.length === 2 && calls[1].url.endsWith('/trash'));
  assert(trashed.updates.every(message => message.folder === 'trash') && calls[1].body === undefined);
  assert(JSON.stringify(state) === before);
});
await test('Unconfirmed sends, drafts, wrong accounts, and unsupported actions fail before any mutation', async () => {
  const state = snapshot();
  let posts = 0;
  const post = async () => { posts++; };
  await rejects(() => changeProviderConversation(state, 'local-0', 'delete-permanently', apiFor(state), post), 'Unsupported');
  await rejects(() => changeProviderConversation({ ...state, messages: state.messages.map(message => ({ ...message, sendState: 'accepted' })) }, 'local-0', 'trash', apiFor(state), post), 'Sync');
  await rejects(() => changeProviderConversation(state, 'local-0', 'trash', async () => ({ emailAddress: 'other@example.com' }), post), 'different account');
  assert(posts === 0);
});
await test('Outlook enumerates the full thread before archiving received messages and preserving sent/drafts/junk', async () => {
  const state = snapshot('outlook');
  const items = ['inbox', 'sent', 'drafts', 'spam', 'trash', 'other'].map((kind, index) => ({
    id: `remote-${index}`, conversationId: "thread'id", parentFolderId: `folder-${kind}`, isDraft: kind === 'drafts',
  }));
  items.push({ id: 'uncached-sent-in-custom-folder', conversationId: "thread'id", parentFolderId: 'folder-other',
    isDraft: false, from: { emailAddress: { address: 'ME@example.com' } } });
  const urls = [], posts = [];
  const base = apiFor(state);
  const api = async url => {
    urls.push(url);
    if (url.includes('/me/messages?')) return new URL(url).searchParams.has('page')
      ? { value: items.slice(3) }
      : { value: items.slice(0, 3), '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?page=2' };
    return base(url);
  };
  const result = await changeProviderConversation(state, 'local-0', 'archive', api, async (url, body) => {
    posts.push({ url, body }); return { id: 'moved-id' };
  });
  assert(result.changed === 2 && posts.length === 2);
  assert(posts.every(call => call.body.destinationId === 'folder-archive'));
  assert(new URL(urls.find(url => url.includes('$filter'))).searchParams.get('$filter') === "conversationId eq 'thread''id'");
  assert(urls.some(url => url.includes('page=2')));
});
await test('Outlook trash uses move rather than delete and reports partial completion', async () => {
  const state = snapshot('outlook'), before = JSON.stringify(state);
  const items = state.messages.map(message => ({ id: message.remoteId, conversationId: message.threadId, parentFolderId: message.providerParentId, isDraft: false }));
  let count = 0;
  const failure = await rejects(() => changeProviderConversation(state, 'local-0', 'trash', apiFor(state, items), async (url, body) => {
    assert(url.endsWith('/move') && body.destinationId === 'folder-trash');
    if (++count === 2) throw new Error('Second move rejected');
    return { id: 'new-id' };
  }), '1 of 2');
  assert(failure.completed === 1 && failure.updates.length === 1 && failure.updates[0].folder === 'trash');
  assert(failure.updates[0].previousId === 'local-0' && JSON.stringify(state) === before);
});
await test('No-op archive avoids mutation and malformed conversation pagination fails safely', async () => {
  const state = snapshot();
  let posts = 0;
  const result = await changeProviderConversation(state, 'local-0', 'archive', apiFor(state, [{ id: 'x', labelIds: ['SENT'] }]), async () => { posts++; });
  assert(result.changed === 0 && posts === 0);
  const outlook = snapshot('outlook'), base = apiFor(outlook);
  await rejects(() => changeProviderConversation(outlook, 'local-0', 'trash', url => url.includes('/me/messages?')
    ? Promise.resolve({ value: [], '@odata.nextLink': url }) : base(url), async () => { posts++; }), 'repeated');
  assert(posts === 0);
});
await test('Google and Microsoft contact creation use correct payloads and the originating account', async () => {
  for (const provider of ['gmail', 'outlook']) {
    const state = snapshot(provider), calls = [];
    let prepared = false;
    const result = await addProviderSender(state, 'Sender@Example.com', ' Sender Name ', apiFor(state), async (url, body) => {
      assert(prepared);
      calls.push({ url, body });
      return provider === 'gmail' ? { resourceName: 'people/new' } : { id: 'new' };
    }, async () => { prepared = true; });
    assert(result.contact.accountId === state.account.id && result.contact.emails[0] === 'sender@example.com');
    assert(calls.length === 1 && result.contacts.length === 1);
    if (provider === 'gmail') assert(calls[0].url.includes('people:createContact') && calls[0].body.names[0].unstructuredName === 'Sender Name');
    else assert(calls[0].body.emailAddresses[0].address === 'sender@example.com');
  }
});
await test('Live duplicate contacts and uncertain pending contact creation cannot be duplicated', async () => {
  const state = snapshot(), base = apiFor(state);
  let posts = 0;
  const api = async url => url.includes('/connections')
    ? { connections: [{ resourceName: 'people/existing', names: [{ displayName: 'Existing' }], emailAddresses: [{ value: 'SENDER@example.com' }] }] }
    : base(url);
  const result = await addProviderSender(state, 'sender@example.com', 'Sender', api, async () => { posts++; });
  assert(result.existing && posts === 0);
  await rejects(() => addProviderSender({ ...state, pendingContact: { email: 'sender@example.com', name: 'Sender' } },
    'sender@example.com', 'Sender', base, async () => { posts++; }), 'unconfirmed');
  assert(posts === 0);
});
await test('Gmail marks the full thread read without changing Inbox or custom labels', async () => {
  const state = snapshot(), calls = [];
  state.messages[0].folderIds.push(providerFolderId(state.account.id, 'UNREAD'), providerFolderId(state.account.id, 'custom'));
  state.messages.push({ ...state.messages[1], id: 'local-send', sendState: 'unknown', remote: false });
  const before = JSON.stringify(state);
  const result = await changeProviderConversation(state, 'local-0', 'read',
    apiFor(state, [{ id: 'remote-0', labelIds: ['INBOX', 'UNREAD'] }, { id: 'older', labelIds: ['UNREAD'] }]),
    async (url, body) => { calls.push({ url, body }); return {}; });
  assert(result.changed === 2 && calls.length === 1 && calls[0].url.endsWith('/modify'));
  assert(JSON.stringify(calls[0].body) === '{"removeLabelIds":["UNREAD"]}');
  assert(result.updates.length === 1 && !result.updates[0].unread && result.updates[0].folder === 'inbox');
  assert(result.updates[0].folderIds.includes(providerFolderId(state.account.id, 'custom')));
  assert(!result.updates[0].folderIds.includes(providerFolderId(state.account.id, 'UNREAD')));
  assert(JSON.stringify(state) === before);
  const noOp = await changeProviderConversation(state, 'local-0', 'read',
    apiFor(state, [{ id: 'remote-0', labelIds: ['INBOX'] }]), async () => { throw new Error('Unexpected write'); });
  assert(noOp.changed === 0 && noOp.updates[0].unread === false);
});
await test('Outlook marks unread thread messages read across pages, skipping read messages and drafts', async () => {
  const state = snapshot('outlook'), base = apiFor(state), calls = [];
  const item = (id, isRead, isDraft = false) => ({ id, isRead, isDraft, conversationId: "thread'id", parentFolderId: 'folder-inbox' });
  const api = async url => url.includes('/me/messages?')
    ? new URL(url).searchParams.has('page') ? { value: [item('older', false), item('draft', false, true)] }
      : { value: [item('remote-0', false), item('remote-1', true)], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?page=2' }
    : base(url);
  const result = await changeProviderConversation(state, 'local-0', 'read', api, async (url, body, method) => {
    calls.push({ url, body, method });
    return { isRead: true };
  });
  assert(result.changed === 2 && calls.length === 2 && result.updates.length === 1);
  assert(calls.every(call => call.method === 'PATCH' && JSON.stringify(call.body) === '{"isRead":true}' && !call.url.endsWith('/move')));
  assert(!result.updates[0].unread && result.updates[0].folder === 'inbox');
});
await test('Read failures retain only confirmed updates and never modify the input snapshot', async () => {
  const state = snapshot('outlook'), before = JSON.stringify(state);
  const items = state.messages.map(message => ({ id: message.remoteId, conversationId: message.threadId,
    parentFolderId: message.providerParentId, isRead: false, isDraft: false }));
  let calls = 0;
  const error = await rejects(() => changeProviderConversation(state, 'local-0', 'read', apiFor(state, items), async () => {
    if (++calls === 2) throw new Error('Provider rejected read status');
    return { isRead: true };
  }), '1 of 2 messages marked read');
  assert(error.completed === 1 && error.updates.length === 1 && error.updates[0].unread === false);
  assert(JSON.stringify(state) === before);
  const invalid = await rejects(() => changeProviderConversation(state, 'local-0', 'read', apiFor(state, items), async () => ({})), 'did not confirm');
  assert(invalid.uncertain && invalid.updates.length === 0);
});
await test('PATCH transport permits only setting an Outlook message read', async () => {
  const calls = [];
  const request = createActionRequest(async () => 'token', 'outlook', async (url, options) => {
    calls.push(options);
    return new Response(null, { status: 204 });
  });
  assert(await request('https://graph.microsoft.com/v1.0/me/messages/id', { isRead: true }, 'PATCH') === null);
  assert(calls[0].method === 'PATCH' && calls[0].headers.Prefer === 'IdType="ImmutableId"');
  for (const [url, body, method] of [
    ['https://graph.microsoft.com/v1.0/me/messages/id', { isRead: false }, 'PATCH'],
    ['https://graph.microsoft.com/v1.0/me/messages/id', { isRead: true, subject: 'changed' }, 'PATCH'],
    ['https://graph.microsoft.com/v1.0/me/contacts/id', { isRead: true }, 'PATCH'],
    ['https://graph.microsoft.com/v1.0/me/messages/id', undefined, 'DELETE'],
  ]) await rejects(() => request(url, body, method), 'Unsupported');
  assert(calls.length === 1);
});
await test('Action permissions are separate from read/send permissions and require reconnect after expiry', async () => {
  const oldGoogle = window.google, oldFetch = window.fetch;
  let grants = false, account;
  window.google = { accounts: { oauth2: {
    initTokenClient: options => ({ requestAccessToken: () => options.callback({ access_token: 'test-token', expires_in: 3600 }) }),
    hasGrantedAllScopes: (_response, ...scopes) => grants || scopes.every(scope => !scope.endsWith('/gmail.modify') && !scope.endsWith('/contacts')),
  } } };
  window.fetch = async () => new Response('{"emailAddress":"me@example.com"}');
  try {
    const login = await prepareSignIn('gmail', '123-test.apps.googleusercontent.com');
    account = await login();
    assert(!canManageMail(account.id) && !canManageContacts(account.id));
    await rejects(() => mutationToken(account, 'mail'), 'Reconnect');
    grants = true; account = await login();
    assert(canManageMail(account.id) && canManageContacts(account.id));
    assert(await mutationToken(account, 'contact')() === 'test-token');
    await forgetSession(account.id);
    assert(!canManageMail(account.id));
  } finally {
    if (account) await forgetSession(account.id);
    window.google = oldGoogle; window.fetch = oldFetch;
  }
});

for (const result of results) {
  const row = document.createElement('li');
  row.className = result.passed ? 'pass' : 'fail';
  row.textContent = `${result.passed ? 'PASS' : 'FAIL'}: ${result.name}${result.error ? ` — ${result.error}` : ''}`;
  document.querySelector('#results').append(row);
}
document.querySelector('#summary').textContent = `${results.filter(result => result.passed).length}/${results.length} checks passed.`;
document.title = results.every(result => result.passed) ? 'PASS — Gather action checks' : 'FAIL — Gather action checks';
window.testResults = results;

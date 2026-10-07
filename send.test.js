import { parseRecipients, replyTarget, prepareOutgoing, gmailSendPayload, submitOutgoing, acceptedOutgoing, mergeLocalSends } from './email-send.js';
import { providerFolderId, conversationMessages } from './mail.js';
import { isValidSnapshot, openMailboxStore } from './mailbox-store.js';
import { prepareSignIn, canSend, sendingToken, forgetSession, getAccountApi } from './auth.js';

const results = [];
async function test(name, check) {
  try { await check(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
}
function assert(value, message = 'Assertion failed') { if (!value) throw new Error(message); }
async function rejects(fn, expected) {
  try { await fn(); } catch (error) { assert(!expected || error.message.includes(expected), error.message); return error; }
  throw new Error('Expected rejection');
}
function snapshot(provider = 'gmail') {
  const account = { id: `${provider}:test`, email: 'me@example.com', provider, clientId: 'public-client-id' };
  return {
    version: 1, folderFormat: 1, bodyFormat: 2, account, messages: [], contacts: [], days: 30,
    since: '2026-09-01T00:00:00Z', lastSync: new Date().toISOString(), cursors: {},
    folders: [{ id: providerFolderId(account.id, provider === 'gmail' ? 'SENT' : 'sent'), remoteId: provider === 'gmail' ? 'SENT' : 'sent',
      accountId: account.id, name: 'Sent', path: 'Sent', kind: provider === 'gmail' ? 'label' : 'sent', hidden: false, parentId: null }],
  };
}
function parentFor(state) {
  return { id: 'parent', remoteId: 'remote/parent', remote: true, accountId: state.account.id, sender: 'person@example.com',
    to: state.account.email, toRecipients: [state.account.email], replyTo: ['replies@example.com'], outgoing: false,
    subject: 'A topic', folder: 'inbox', threadId: 'provider-thread', internetMessageId: '<parent@example.com>', references: '<ancestor@example.com>' };
}
const values = { to: 'person@example.com', subject: 'A topic', body: 'Hello, café 🌿\nSecond line.' };
function decode64(value) { return new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))); }

await test('Recipients are validated, normalized, deduplicated, and protected from header injection', async () => {
  assert(parseRecipients(' ONE@example.com,one@example.com,two@example.com').join() === 'one@example.com,two@example.com');
  for (const to of ['one@example.com\r\nBcc: secret@example.com', 'Name <one@example.com>', '', 'invalid', 'one@example.com,']) {
    await rejects(() => parseRecipients(to));
  }
  await rejects(() => prepareOutgoing(snapshot(), { ...values, subject: 'Hello\r\nBcc: hidden@example.com' }));
});
await test('Reply targets honor Reply-To and sent recipients instead of sending to self', () => {
  const state = snapshot();
  const parent = parentFor(state);
  assert(replyTarget([parent], state.account.email).recipients.join() === 'replies@example.com');
  const sent = { ...parent, id: 'sent', sender: state.account.email, to: 'person@example.com', toRecipients: ['person@example.com', 'other@example.com'], outgoing: true, folder: 'sent' };
  assert(replyTarget([sent], state.account.email).recipients.join() === 'person@example.com,other@example.com');
  assert(replyTarget([{ ...sent, sendState: 'accepted' }], state.account.email) === null);
});
await test('Reply all combines Reply-To, original To and Cc, deduplicates, and excludes the sending address', () => {
  const state = snapshot(), parent = parentFor(state);
  parent.toRecipients = ['ME@example.com', 'teammate@example.com', 'replies@example.com'];
  parent.ccRecipients = ['copied@example.com', 'TEAMMATE@example.com', 'me@example.com'];
  parent.bccRecipients = ['hidden@example.com'];
  const target = replyTarget([parent], 'Me@example.com');
  assert(target.toRecipients.join() === 'replies@example.com,teammate@example.com');
  assert(target.ccRecipients.join() === 'copied@example.com');
  assert(!target.recipients.includes('person@example.com') && !target.recipients.includes('hidden@example.com'));
});
await test('Reply all recovers Cc from old cached participants, but explicit Cc metadata takes precedence', () => {
  const state = snapshot(), parent = parentFor(state);
  parent.participants = ['person@example.com', 'me@example.com', 'copied@example.com'];
  assert(replyTarget([parent], state.account.email).ccRecipients.join() === 'copied@example.com');
  parent.ccRecipients = [];
  assert(replyTarget([parent], state.account.email).ccRecipients.length === 0);
});
await test('Sent-only reply all retains original To and Cc and does not address the account itself', () => {
  const state = snapshot(), parent = { ...parentFor(state), outgoing: true, folder: 'sent',
    sender: state.account.email, toRecipients: ['person@example.com'], ccRecipients: ['copied@example.com', 'ME@example.com'] };
  const target = replyTarget([parent], state.account.email);
  assert(target.toRecipients.join() === 'person@example.com' && target.ccRecipients.join() === 'copied@example.com');
  parent.toRecipients = ['me@example.com']; parent.ccRecipients = [];
  assert(replyTarget([parent], state.account.email) === null);
});
await test('Cc validation and duplicate-send protection cover the full reply-all recipient set', async () => {
  const state = snapshot();
  const message = prepareOutgoing(state, { ...values, cc: ['copied@example.com', 'PERSON@example.com'] });
  assert(message.ccRecipients.join() === 'copied@example.com' && message.participants.includes('copied@example.com'));
  assert(isValidSnapshot({ ...state, messages: [message] }));
  await rejects(() => prepareOutgoing(state, { ...values, cc: ['bad\r\nBcc: hidden@example.com'] }));
  const previous = { ...state, messages: [{ ...message, sendState: 'unknown' }] };
  await rejects(() => prepareOutgoing(previous, { ...values, to: ['copied@example.com', 'person@example.com'] }), 'unknown outcome');
});
await test('Gmail reply-all MIME includes Cc and retains threaded reply headers', () => {
  const state = snapshot(), parent = parentFor(state);
  const message = prepareOutgoing(state, { ...values, parent, cc: ['copied@example.com', 'second@example.com'] });
  const raw = decode64(gmailSendPayload(message, parent).raw);
  assert(raw.includes('Cc: copied@example.com,\r\n second@example.com'));
  assert(raw.includes('In-Reply-To: <parent@example.com>') && !raw.includes('Bcc:'));
});
await test('Gmail reply includes provider thread ID, RFC reply headers, and correct Unicode MIME encoding', () => {
  const state = snapshot(), parent = parentFor(state);
  const message = prepareOutgoing(state, { ...values, subject: 'Meeting café 🌿', parent });
  const payload = gmailSendPayload(message, parent);
  assert(payload.threadId === 'provider-thread');
  const raw = decode64(payload.raw);
  assert(raw.includes('In-Reply-To: <parent@example.com>') && raw.includes('References: <ancestor@example.com>\r\n <parent@example.com>'));
  assert(raw.includes(`Message-ID: ${message.internetMessageId}`));
  assert(raw.includes(`X-Gather-Send-ID: ${message.clientSendId}`));
  assert(decode64(raw.split('\r\n\r\n')[1].replace(/\r\n/g, '')) === values.body.replace(/\n/g, '\r\n'));
  const subject = raw.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)[1];
  assert(decode64(subject) === 'Meeting café 🌿');
});
await test('Subject encoding folds long Unicode text without splitting UTF-8 characters', () => {
  const subject = '🌿'.repeat(120);
  const message = prepareOutgoing(snapshot(), { ...values, subject });
  const raw = decode64(gmailSendPayload(message).raw);
  const field = /Subject: ([\s\S]*?)\r\nDate:/.exec(raw)[1];
  const parts = [...field.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
  assert(parts.map(part => decode64(part[1])).join('') === subject);
  assert(parts.every(part => part[0].length <= 75));
});
await test('Gmail sends exactly once and records confirmed remote IDs', async () => {
  const state = snapshot(), message = prepareOutgoing(state, values);
  let calls = 0;
  const result = await submitOutgoing(state.account, message, null, async () => 'token', async (url, request) => {
    calls++;
    assert(url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send' && request.method === 'POST');
    assert(request.credentials === 'omit' && request.redirect === 'error');
    assert(!JSON.parse(request.body).threadId, 'A new message must not be assigned an existing thread');
    return new Response('{"id":"sent-id","threadId":"sent-thread"}');
  });
  assert(calls === 1 && result.remoteId === 'sent-id' && result.threadId === 'sent-thread');
  const sent = acceptedOutgoing(state, message, result);
  assert(sent.folder === 'sent' && sent.sendState === 'accepted' && sent.folderIds.length === 1);
  assert(isValidSnapshot({ ...state, messages: [sent] }));
});
await test('Microsoft uses replyAll with explicit To/Cc recipients and sends new messages to Sent Items', async () => {
  const state = snapshot('outlook'), parent = parentFor(state);
  for (const anchor of [parent, null]) {
    const message = prepareOutgoing(state, { ...values, parent: anchor, cc: anchor ? ['copied@example.com'] : [] });
    let captured;
    const result = await submitOutgoing(state.account, message, anchor, async () => 'token', async (url, request) => {
      captured = { url, payload: JSON.parse(request.body) };
      return new Response(null, { status: 202 });
    });
    assert(captured.url.endsWith(anchor ? '/remote%2Fparent/replyAll' : '/me/sendMail'));
    assert(captured.payload.message.body.contentType === 'Text' && !captured.payload.comment);
    assert(captured.payload.message.toRecipients[0].emailAddress.address === 'person@example.com');
    assert(captured.payload.message.ccRecipients.length === (anchor ? 1 : 0) && captured.payload.message.bccRecipients.length === 0);
    if (anchor) assert(captured.payload.message.ccRecipients[0].emailAddress.address === 'copied@example.com');
    assert(captured.payload.message.internetMessageHeaders[0].value === message.clientSendId);
    assert(anchor || captured.payload.saveToSentItems === true);
    assert(result.threadId === message.threadId);
  }
});
await test('Send rejections and uncertain network/server outcomes never retry automatically', async () => {
  const state = snapshot(), message = prepareOutgoing(state, values);
  for (const code of [400, 401, 403, 429, 500, 503]) {
    let calls = 0;
    const error = await rejects(() => submitOutgoing(state.account, message, null, async () => 'token', async () => {
      calls++; return new Response('{}', { status: code });
    }));
    assert(calls === 1 && error.uncertain === (code >= 500));
  }
  let calls = 0;
  const error = await rejects(() => submitOutgoing(state.account, message, null, async () => 'token', async () => {
    calls++; throw new Error('Disconnected');
  }));
  assert(calls === 1 && error.uncertain && error.message.includes('may already'));
});
await test('Failed authorization does not perform a send, and incomplete accepted responses are uncertain', async () => {
  const state = snapshot(), message = prepareOutgoing(state, values);
  let calls = 0;
  await rejects(() => submitOutgoing(state.account, message, null, async () => { throw new Error('Reconnect'); }, async () => { calls++; }), 'Reconnect');
  assert(calls === 0);
  const error = await rejects(() => submitOutgoing(state.account, message, null, async () => 'token', async () => new Response('{}')));
  assert(error.uncertain);
});
await test('Unknown send outcomes block identical resubmissions across reloads', async () => {
  const state = snapshot();
  const message = prepareOutgoing(state, values);
  for (const sendState of ['sending', 'unknown']) {
    const restored = JSON.parse(JSON.stringify({ ...state, messages: [{ ...message, sendState }] }));
    await rejects(() => prepareOutgoing(restored, values), 'unknown outcome');
  }
});
await test('Sync replaces local send records exactly by provider IDs, Message-ID, or client correlation header', () => {
  for (const provider of ['gmail', 'outlook']) {
    const state = snapshot(provider), parent = parentFor(state);
    const local = acceptedOutgoing(state, prepareOutgoing(state, { ...values, parent }), { remoteId: 'pending', threadId: parent.threadId });
    const previous = { ...state, messages: [local] };
    const remote = { ...local, id: 'remote-sent', remoteId: 'actual-sent', threadId: 'canonical-thread' };
    delete remote.sendState;
    const result = mergeLocalSends({ ...state, messages: [remote] }, previous);
    assert(result.messages.length === 1 && result.messages[0].id === 'remote-sent');
    assert(result.messages[0].clientSendId === local.clientSendId);
    const pending = mergeLocalSends({ ...state, messages: [] }, previous);
    assert(pending.messages.length === 1 && pending.messages[0].sendState === 'accepted');
  }
});
await test('Reply accepted locally stays in the original conversation before sync', () => {
  const state = snapshot('outlook'), parent = parentFor(state);
  const message = acceptedOutgoing(state, prepareOutgoing(state, { ...values, parent }), { remoteId: 'pending', threadId: parent.threadId });
  assert(conversationMessages({ ...state, messages: [parent, message] }, parent.id).length === 2);
});
await test('Durable sending state and accepted state survive IndexedDB reload', async () => {
  const name = `gather-send-test-${crypto.randomUUID()}`;
  const store = await openMailboxStore(name);
  try {
    const state = snapshot(), pending = prepareOutgoing(state, values);
    await store.save({ ...state, messages: [pending] });
    assert((await store.list())[0].messages[0].sendState === 'sending');
    const accepted = acceptedOutgoing(state, pending, { remoteId: 'sent', threadId: 'thread' });
    await store.save({ ...state, messages: [accepted] });
    assert((await store.list())[0].messages[0].sendState === 'accepted');
  } finally {
    store.close();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve; request.onerror = () => reject(request.error);
    });
  }
});
await test('Read-only Google consent permits sync but blocks sends until sending scope is explicitly granted', async () => {
  const oldGoogle = window.google, oldFetch = window.fetch;
  let grantSend = false, requestedScopes;
  window.google = { accounts: { oauth2: {
    hasGrantedAllScopes: (_response, ...scopes) => !scopes.includes('https://www.googleapis.com/auth/gmail.send') || grantSend,
    initTokenClient: options => {
      requestedScopes = options.scope;
      return { requestAccessToken: () => options.callback({ access_token: 'test-token', expires_in: 3600 }) };
    },
  } } };
  window.fetch = async () => new Response('{"emailAddress":"send-permissions@example.com"}');
  let account;
  try {
    const authorize = await prepareSignIn('gmail', '123-test.apps.googleusercontent.com');
    account = await authorize();
    assert(!canSend(account.id) && typeof getAccountApi(account) === 'function');
    await rejects(() => sendingToken(account), 'sending permission');
    assert(requestedScopes.includes('gmail.send') && requestedScopes.includes('gmail.modify'));
    grantSend = true;
    account = await authorize();
    assert(canSend(account.id) && await sendingToken(account)() === 'test-token');
    await forgetSession(account.id);
    assert(!canSend(account.id));
  } finally {
    if (account) await forgetSession(account.id);
    window.google = oldGoogle; window.fetch = oldFetch;
  }
});
await test('Incoming messages cannot consume a local send correlation marker', () => {
  const state = snapshot(), local = acceptedOutgoing(state, prepareOutgoing(state, values), { remoteId: 'local', threadId: 'thread' });
  const incoming = { ...local, id: 'incoming', remoteId: 'incoming', outgoing: false, folder: 'inbox' };
  delete incoming.sendState;
  const result = mergeLocalSends({ ...state, messages: [incoming] }, { ...state, messages: [local] });
  assert(result.messages.length === 2 && result.messages.some(message => message.sendState === 'accepted'));
});

for (const result of results) {
  const row = document.createElement('li');
  row.className = result.passed ? 'pass' : 'fail';
  row.textContent = `${result.passed ? 'PASS' : 'FAIL'}: ${result.name}${result.error ? ` — ${result.error}` : ''}`;
  document.querySelector('#results').append(row);
}
document.querySelector('#summary').textContent = `${results.filter(result => result.passed).length}/${results.length} checks passed.`;
document.title = results.every(result => result.passed) ? 'PASS — Gather sending checks' : 'FAIL — Gather sending checks';
window.testResults = results;

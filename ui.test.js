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
  const form = documentInFrame.querySelector('#connection-form');
  form.elements.clientId.value = 'not-a-client-id';
  click('#prepare-provider');
  await waitFor(() => documentInFrame.querySelector('#connection-feedback').classList.contains('form-error'));
  assert(documentInFrame.querySelector('#connection-feedback').textContent.includes('client ID'), 'Invalid OAuth client ID shows an error');
  let partialConsent = false, failContacts = false, denyToken = false, cancelAtMail = false;
  const requests = [];
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
    if (denyToken) return new Response('{}', { status: 401 });
    if (url.pathname.endsWith('/profile')) return new Response(JSON.stringify({ emailAddress: 'real-user@example.com', historyId: '100' }));
    if (url.pathname.endsWith('/messages')) {
      if (cancelAtMail) {
        click('#cancel-import');
        throw new DOMException('Cancelled', 'AbortError');
      }
      return new Response(JSON.stringify({ messages: [{ id: 'real-1' }, { id: 'real-2' }] }));
    }
    if (url.pathname.endsWith('/history')) return new Response(JSON.stringify({ history: [], historyId: '101' }));
    if (url.pathname.includes('/messages/')) {
      const sent = url.pathname.endsWith('/real-2');
      const body = btoa(sent ? 'An actual sent message, imported.' : 'A private imported message.');
      return new Response(JSON.stringify({
        id: sent ? 'real-2' : 'real-1', threadId: 'actual-thread',
        labelIds: sent ? ['SENT'] : ['INBOX', 'UNREAD'], internalDate: String(Date.now() - (sent ? 1000 : 2000)),
        payload: { mimeType: 'text/plain', body: { data: body }, headers: [
          { name: 'From', value: sent ? 'real-user@example.com' : 'Maya <maya@example.com>' },
          { name: 'To', value: sent ? 'maya@example.com' : 'real-user@example.com' },
          { name: 'Subject', value: sent ? 'Re: Provider thread' : 'Provider thread' },
        ] },
      }));
    }
    if (url.hostname === 'people.googleapis.com') return failContacts ? new Response('{}', { status: 403 })
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
  assert(documentInFrame.querySelectorAll('.message-card').length === 1, 'Imported inbox groups received and sent mail by provider thread');
  click('.message-card');
  assert(bubbles() === 2, 'Real conversation displays imported received and sent messages');
  assert(!documentInFrame.querySelector('#chat-reply-form'), 'Real conversation has no sending form');
  assert(!documentInFrame.querySelector('[data-action="archive"]') && !documentInFrame.querySelector('[data-action="star"]'), 'Real conversation has no mutation controls');
  assert(documentInFrame.querySelector('.outgoing').textContent.includes('Sent · Imported from provider'), 'Real sent messages are not mislabeled as demo replies');
  assert(documentInFrame.querySelector('.incoming').textContent.includes('Unread'), 'Reading real mail does not alter provider read flags');
  assert(requests.every((request) => request.method === 'GET'), 'Real-mail integration only makes read requests');
  click('[data-action="back"]');
  click('[data-folder="contacts"]');
  assert(documentInFrame.querySelectorAll('.contact-tile').length === 1, 'Imported contacts are available');
  assert(!documentInFrame.querySelector('[data-edit-contact]') && !documentInFrame.querySelector('[data-write]'), 'Real contact editing and sending remain disabled');
  failContacts = true;
  click('[data-action="sync"]');
  await waitFor(() => documentInFrame.querySelector('.real-status.storage-error'));
  assert(documentInFrame.querySelectorAll('.contact-tile').length === 1, 'Failed contact sync preserves the cached contacts');
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
} catch (error) {
  if (!results.some((result) => !result.passed)) results.push({ name: error.message, passed: false });
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

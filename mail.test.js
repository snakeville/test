import { createDemo, findContact, visibleMessages, visibleConversations, conversationMessages, conversationKey, conversationAddress, topicSubject, replyToConversation, groupMessages, addContact, updateContact, syncDemo, isValidState, isEmail } from './mail.js';
import { normalizePlainText, plainTextFromHtml, messagePlainText, messagePreview } from './email-text.js';
import { stripQuotedHtml, stripQuotedText, messageQuoteContent } from './email-quotes.js';

const results = [];
function test(name, check) {
  try {
    check();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
}
function assert(condition, message = 'Assertion failed') {
  if (!condition) throw new Error(message);
}
function throws(action) {
  let caught = false;
  try { action(); } catch { caught = true; }
  assert(caught, 'Expected an error');
}

test('Sample state validates and survives JSON serialization', () => {
  assert(isValidState(JSON.parse(JSON.stringify(createDemo()))));
});
test('Proton reply hides nested original history while preserving the latest reply and signature', () => {
  const html = '<html><body style="color:blue">My latest reply.<br><div class="protonmail_signature_block-user">My signature</div><br>Sent from my phone.<div class="protonmail_quote"><br>-------- Original Message --------<br>On Friday, Person wrote:<blockquote class="protonmail_quote">Previous message<div class="gmail_quote">Older message</div></blockquote></div></body></html>';
  const result = stripQuotedHtml(html);
  assert(result.hasQuotes && result.html.includes('My latest reply.') && result.html.includes('My signature'));
  assert(result.html.includes('Sent from my phone.') && result.html.includes('color:blue'));
  assert(!result.html.includes('Previous message') && !result.html.includes('Older message') && !result.html.includes('Original Message'));
  assert(html.includes('Previous message'));
});
test('Gmail, Yahoo, and cite quotations hide only marked content, preserving replies below them', () => {
  for (const wrapper of ['<div class="gmail_quote">', '<div class="yahoo_quoted">', '<blockquote type="cite">']) {
    const end = wrapper.startsWith('<blockquote') ? '</blockquote>' : '</div>';
    const result = stripQuotedHtml(`<p>Before</p>${wrapper}Old email${end}<p>Reply below</p>`);
    assert(result.hasQuotes && result.html.includes('Reply below') && !result.html.includes('Old email'));
  }
  const editorial = '<p>A useful quotation:</p><blockquote>Keep this quote.</blockquote><p>My explanation.</p>';
  assert(stripQuotedHtml(editorial).html === editorial && !stripQuotedHtml(editorial).hasQuotes);
});
test('Outlook reply headers hide following history but retain the latest message', () => {
  const result = stripQuotedHtml('<div>Latest reply</div><div><div id="divRplyFwdMsg">From: Someone</div><p>Prior message</p></div>');
  assert(result.hasQuotes && result.html.includes('Latest reply') && !result.html.includes('Prior message'));
});
test('Plain-text original-message separators and Outlook headers collapse previous history', () => {
  const result = stripQuotedText('New reply.\n\nSignature\n\n-------- Original Message --------\nOn Friday, Someone wrote:\n\n> Old content\n>> Older content');
  assert(result.hasQuotes && result.text === 'New reply.\n\nSignature');
  const outlook = stripQuotedText('New reply.\n\nFrom: person@example.com\nSent: Tuesday\nTo: me@example.com\nSubject: Topic\n\nOld content');
  assert(outlook.hasQuotes && outlook.text === 'New reply.');
  assert(!stripQuotedText('Notes:\nFrom: the beginning of the project\nThis is current content.').hasQuotes);
});
test('On-wrote and trailing quoted blocks preserve inline answers and fenced examples', () => {
  const result = stripQuotedText('My answer.\n\nOn Tuesday, Someone\n<person@example.com> wrote:\n> Question one\n\nMy second answer.\n\n> More old text');
  assert(result.hasQuotes && result.text === 'My answer.\n\nMy second answer.');
  const code = 'Example:\n```\nOn Tuesday, Someone wrote:\n> literal quote\n```\nThis stays.';
  assert(stripQuotedText(code).text === code);
});
test('Quote previews use the current reply and retain unmodified originals for expanded display and search', () => {
  const message = { body: 'New reply\n\n> Old text', bodyHtml: '<p>New reply</p><div class="protonmail_quote">Old text</div>' };
  const before = JSON.stringify(message);
  assert(messageQuoteContent(message).hasQuotes);
  assert(messagePlainText(message, { hideQuotes: true }) === 'New reply');
  assert(messagePlainText(message).includes('Old text'));
  assert(messagePreview(message) === 'New reply' && JSON.stringify(message) === before);
  message.bodyHtml = '<p>No quote now</p>';
  assert(!messageQuoteContent(message).hasQuotes);
});
test('Plain text trims extra spaces, blank padding, nonbreaking spaces, and Windows line endings', () => {
  const text = '\r\n  Hello   Alex,\u00a0 \r\n \t\r\n\r\n\r\nHere\u00a0\u00a0is   the update.  \r\n\r\n';
  assert(normalizePlainText(text) === 'Hello Alex,\n\nHere is the update.');
  assert(normalizePlainText('\ufeffhel\u200blo   world') === 'hello world');
  assert(normalizePlainText(' \n\t\n ') === '');
});
test('Plain text preserves line breaks, nested lists, indented code, and fenced-code spacing', () => {
  const text = 'Hello,\nA short note.\n\n- First   item\n  - Nested   item\n\n    const x = "two  spaces";   \n\taligned\tcolumns\n\n```js\nconst y = "two  spaces";\n\n\nreturn y;\n```\n\nGood   bye.';
  assert(normalizePlainText(text) === 'Hello,\nA short note.\n\n- First item\n  - Nested item\n\n    const x = "two  spaces";\n\taligned\tcolumns\n\n```js\nconst y = "two  spaces";\n\n\nreturn y;\n```\n\nGood bye.');
});
test('HTML text conversion ignores source indentation and keeps readable paragraph separation', () => {
  const html = '\n    <div>\n      <p>Hello&nbsp;   <strong>Alex</strong>,</p>\n      <div>Here is <em>the update</em>.</div>\n    </div>\n';
  assert(plainTextFromHtml(html) === 'Hello Alex,\n\nHere is the update.');
  assert(plainTextFromHtml('<p>First<br>Second</p><p>Third</p>') === 'First\nSecond\n\nThird');
  assert(plainTextFromHtml('<p>hel\u200blo</p>') === 'hello');
});
test('HTML lists, table cells, and preformatted code retain useful structure', () => {
  assert(plainTextFromHtml('<ul><li>One</li><li>Two</li></ul>') === '- One\n- Two');
  assert(plainTextFromHtml('<ol start="3"><li>Three</li><li>Four</li></ol>') === '3. Three\n4. Four');
  assert(plainTextFromHtml('<table><tr><td>Name</td><td>Value</td></tr><tr><td>A</td><td>10</td></tr></table>') === 'Name\tValue\nA\t10');
  const code = '  x  =  1;\n\n\n\treturn x;';
  assert(plainTextFromHtml(`<p>Code:</p><pre>${code}</pre><p>End.</p>`) === `Code:\n\n${code}\n\nEnd.`);
});
test('HTML text conversion omits hidden preheaders and active content without fetching images', () => {
  assert(plainTextFromHtml('<div style="display:none">Hidden</div><span hidden>Hidden</span><div style="visibility:hidden">Hidden</div><script>bad()</script><style>bad{}</style><p>Visible <img src="https://example.invalid/track">text</p>')
    === 'Visible text');
});
test('Display normalization updates cached messages without mutating their stored original bodies', () => {
  const message = { body: '  Old   text\r\n\r\n\r\n', bodyHtml: '<p>Fresh&nbsp;  HTML</p>' };
  const before = JSON.stringify(message);
  assert(messagePlainText(message) === 'Fresh HTML');
  assert(JSON.stringify(message) === before);
  message.bodyHtml = '<p>Changed   HTML</p>';
  assert(messagePlainText(message) === 'Changed HTML');
  delete message.bodyHtml;
  assert(messagePlainText(message) === 'Old text');
});
test('Previews collapse whitespace and search matches the normalized displayed phrase', () => {
  const message = { body: 'Hello   Alex\n\n    A longer line\twith columns' };
  assert(messagePreview(message) === 'Hello Alex A longer line with columns');
  const state = createDemo();
  state.messages[0].body = 'An   unusually\u00a0\u00a0spaced   phrase.';
  assert(visibleMessages(state, { query: 'unusually spaced phrase' }).length === 1);
});
test('Contact lookup normalizes case and surrounding whitespace', () => {
  assert(findContact(createDemo().contacts, '  MAYA.CHEN@EXAMPLE.COM ').id === 'maya');
});
test('Contact aliases group into the same person', () => {
  const state = createDemo();
  const groups = groupMessages(visibleMessages(state), state.contacts);
  assert(groups.length === 5);
  assert(groups.find((group) => group.key === 'maya').messages.length === 2);
});
test('A shared contact groups messages from different providers', () => {
  const state = createDemo();
  const james = groupMessages(visibleMessages(state), state.contacts).find((group) => group.key === 'james');
  assert(new Set(james.messages.map((message) => message.accountId)).size === 2);
});
test('Unknown senders never appear in the known-contact inbox', () => {
  const state = createDemo();
  assert(visibleMessages(state).length === 7);
  assert(visibleMessages(state, { folder: 'unknown' }).length === 3);
  assert(visibleMessages(state).every((message) => findContact(state.contacts, message.sender)));
});
test('Matching display names cannot impersonate known contact addresses', () => {
  const state = createDemo();
  state.messages[7].senderName = 'Maya Chen';
  assert(visibleMessages(state, { folder: 'unknown' }).some((message) => message.id === 'u1'));
});
test('Adding an unknown sender reclassifies every matching inbox message', () => {
  let state = createDemo();
  state.messages.push({ ...state.messages.find((message) => message.id === 'u2'), id: 'u2-copy' });
  state = addContact(state, 'Riley Brooks', 'RILEY@STUDIO.EXAMPLE');
  assert(visibleMessages(state, { folder: 'unknown' }).length === 2);
  assert(visibleMessages(state).filter((message) => message.sender === 'riley@studio.example').length === 2);
});
test('Invalid and duplicate contacts are rejected explicitly', () => {
  const state = createDemo();
  throws(() => addContact(state, 'Maya', 'MAYA.CHEN@EXAMPLE.COM'));
  throws(() => addContact(state, ' ', 'someone@example.com'));
  throws(() => addContact(state, 'Someone', 'not-an-email'));
});
test('Email validation uses the same full-address requirement for contacts and messages', () => {
  assert(isEmail('alex@example.com'));
  assert(!isEmail('alex@local'));
  assert(!isEmail('alex @example.com'));
  assert(!isEmail(undefined));
});
test('New contacts accept multiple addresses and normalize each address', () => {
  const original = createDemo();
  const state = addContact(original, '  Riley Brooks  ', [' RILEY@STUDIO.EXAMPLE ', 'riley.home@example.com']);
  const contact = findContact(state.contacts, 'riley@studio.example');
  assert(contact.name === 'Riley Brooks');
  assert(contact.emails.join(',') === 'riley@studio.example,riley.home@example.com');
  assert(original.contacts.length === 5 && state.contacts.length === 6);
  assert(isValidState(state));
});
test('All new contact addresses must be valid, unique, and unclaimed', () => {
  const state = createDemo();
  const before = JSON.stringify(state);
  for (const emails of [[], [''], ['valid@example.com', ''], ['invalid'], [null],
    ['riley@studio.example', ' RILEY@STUDIO.EXAMPLE '],
    ['riley@studio.example', 'MAYA.DESIGN@EXAMPLE.COM']]) {
    throws(() => addContact(state, 'Riley', emails));
  }
  assert(JSON.stringify(state) === before);
});
test('Editing preserves identity and metadata and does not mutate the original state', () => {
  const original = createDemo();
  const before = JSON.stringify(original);
  const state = updateContact(original, 'maya', '  Maya Rivera  ', [' MAYA.CHEN@EXAMPLE.COM ', 'maya.design@example.com']);
  const contact = state.contacts.find((entry) => entry.id === 'maya');
  assert(contact.name === 'Maya Rivera');
  assert(contact.source === 'gmail' && contact.note === original.contacts[0].note && contact.color === 'sage');
  assert(state.messages === original.messages);
  assert(state.contacts[1] === original.contacts[1]);
  assert(JSON.stringify(original) === before);
  assert(visibleMessages(state, { query: 'Maya Rivera' }).length === 2);
  assert(groupMessages(visibleMessages(state), state.contacts)[0].name === 'Maya Rivera');
  assert(isValidState(JSON.parse(JSON.stringify(state))));
});
test('Existing contact can gain an unknown address from another provider', () => {
  const state = updateContact(createDemo(), 'maya', 'Maya Chen',
    ['maya.chen@example.com', 'maya.design@example.com', 'riley@studio.example']);
  assert(visibleMessages(state, { folder: 'unknown' }).length === 2);
  const maya = groupMessages(visibleMessages(state), state.contacts).find((group) => group.key === 'maya');
  assert(maya.messages.length === 3 && maya.messages.some((message) => message.accountId === 'outlook'));
  assert(visibleMessages(state, { account: 'outlook', query: 'Maya Chen' }).length === 1);
});
test('Removing an alias reclassifies inbox messages without changing any message data', () => {
  const original = createDemo();
  const before = JSON.stringify(original.messages);
  const state = updateContact(original, 'maya', 'Maya Chen', ['maya.chen@example.com']);
  assert(visibleMessages(state).length === 6);
  assert(visibleMessages(state, { folder: 'unknown' }).some((message) => message.id === 'm2'));
  assert(JSON.stringify(state.messages) === before);
  const restored = updateContact(state, 'maya', 'Maya Chen', ['maya.chen@example.com', 'maya.design@example.com']);
  assert(visibleMessages(restored).length === 7);
});
test('Contact edits preserve archived messages, sent recipients, and star/read flags', () => {
  const original = createDemo();
  original.messages[0].folder = 'archive';
  original.messages.push({ ...original.messages[1], id: 'sent-maya', folder: 'sent', to: 'maya.design@example.com' });
  const before = JSON.stringify(original.messages);
  const state = updateContact(original, 'maya', 'Renamed Maya', ['maya.design@example.com']);
  assert(JSON.stringify(state.messages) === before);
  assert(visibleMessages(state, { folder: 'archive' }).some((message) => message.id === 'm1'));
  assert(visibleMessages(state, { folder: 'starred' }).some((message) => message.id === 'm1'));
  assert(visibleMessages(state, { folder: 'sent', query: 'Renamed Maya' }).length === 1);
});
test('Invalid edits fail atomically and cannot steal another contact address', () => {
  const state = createDemo();
  const before = JSON.stringify(state);
  throws(() => updateContact(state, 'missing', 'Someone', ['someone@example.com']));
  throws(() => updateContact(state, 'maya', ' ', ['maya.chen@example.com']));
  for (const emails of [[], [''], ['maya.chen@example.com', 'invalid'],
    ['maya.chen@example.com', ' MAYA.CHEN@EXAMPLE.COM '],
    ['maya.chen@example.com', 'JAMES.W@EXAMPLE.COM']]) {
    throws(() => updateContact(state, 'maya', 'New name', emails));
  }
  assert(JSON.stringify(state) === before);
});
test('A released address can move to another contact without a duplicate', () => {
  const removed = updateContact(createDemo(), 'maya', 'Maya Chen', ['maya.chen@example.com']);
  const reassigned = updateContact(removed, 'james', 'James Wilson', ['james.w@example.com', 'maya.design@example.com']);
  assert(findContact(reassigned.contacts, 'maya.design@example.com').id === 'james');
  assert(groupMessages(visibleMessages(reassigned), reassigned.contacts).find((group) => group.key === 'james').messages.length === 3);
  assert(isValidState(reassigned));
});
test('Repeated sync preserves edits to synced contact names and addresses', () => {
  const state = updateContact(syncDemo(createDemo()), 'sync-leo', 'Leonard Bennett', ['leo.new@example.com']);
  const again = syncDemo(state);
  assert(again.contacts.length === 7 && again.messages.length === 13);
  assert(findContact(again.contacts, 'leo.new@example.com').name === 'Leonard Bennett');
  assert(!findContact(again.contacts, 'leo.b@example.com'));
  assert(visibleMessages(again, { folder: 'unknown' }).some((message) => message.id === 'sync-gmail'));
  assert(isValidState(JSON.parse(JSON.stringify(again))));
});
test('Persistence validation rejects empty names and ambiguous address ownership', () => {
  const blank = createDemo();
  blank.contacts[0].name = ' ';
  assert(!isValidState(blank));
  const duplicate = createDemo();
  duplicate.contacts[0].emails.push(' MAYA.CHEN@EXAMPLE.COM ');
  assert(!isValidState(duplicate));
  const shared = createDemo();
  shared.contacts[1].emails.push(' MAYA.DESIGN@EXAMPLE.COM ');
  assert(!isValidState(shared));
});
test('Account filtering does not mix providers', () => {
  const messages = visibleMessages(createDemo(), { account: 'outlook' });
  assert(messages.length === 2 && messages.every((message) => message.accountId === 'outlook'));
});
test('Search matches contact names, aliases, subject, and body', () => {
  const state = createDemo();
  assert(visibleMessages(state, { query: 'MAYA' }).length === 2);
  assert(visibleMessages(state, { query: 'maya.design@example.com' }).length === 1);
  assert(visibleMessages(state, { query: 'GETAWAY' }).length === 1);
  assert(visibleMessages(state, { query: 'fireplace' }).length === 1);
  assert(visibleMessages(state, { query: 'not-a-match' }).length === 0);
});
test('Search cannot leak unknown messages into the main inbox', () => {
  assert(visibleMessages(createDemo(), { query: 'Paper Trail' }).length === 0);
});
test('Unread filter excludes read messages', () => {
  const messages = visibleMessages(createDemo(), { unread: true });
  assert(messages.length === 4 && messages.every((message) => message.unread));
});
test('Messages and contact groups are ordered by most recent message', () => {
  const state = createDemo();
  const messages = visibleMessages(state);
  assert(messages[0].id === 'm1');
  assert(messages.every((message, index) => !index || Date.parse(messages[index - 1].date) >= Date.parse(message.date)));
  assert(groupMessages(messages, state.contacts)[0].key === 'maya');
});
test('Archiving and restoring preserves unknown-sender classification', () => {
  const state = createDemo();
  const unknown = state.messages.find((message) => message.id === 'u1');
  unknown.folder = 'archive';
  assert(visibleMessages(state, { folder: 'unknown' }).length === 2);
  assert(visibleMessages(state, { folder: 'archive' })[0].id === 'u1');
  unknown.folder = 'inbox';
  assert(visibleMessages(state, { folder: 'unknown' }).length === 3);
  assert(!visibleMessages(state).some((message) => message.id === 'u1'));
});
test('Starred view includes starred archived messages', () => {
  const state = createDemo();
  state.messages[0].folder = 'archive';
  assert(visibleMessages(state, { folder: 'starred' }).length === 2);
});
test('Sync imports both email and contacts and keeps the state valid', () => {
  const state = syncDemo(createDemo());
  assert(state.messages.length === 13 && state.contacts.length === 7);
  assert(visibleMessages(state).length === 9 && isValidState(state));
});
test('Sync is idempotent and preserves local read and archive changes', () => {
  const state = syncDemo(createDemo());
  const message = state.messages.find((entry) => entry.id === 'sync-gmail');
  message.unread = false;
  message.folder = 'archive';
  const again = syncDemo(state);
  assert(again.messages.length === 13 && again.contacts.length === 7);
  assert(again.messages.find((entry) => entry.id === message.id).folder === 'archive');
  assert(!again.messages.find((entry) => entry.id === message.id).unread);
});
test('Provider-specific sync imports only that provider', () => {
  const state = syncDemo(createDemo(), 'outlook');
  assert(state.messages.length === 12 && state.contacts.length === 6);
  assert(!state.messages.some((message) => message.id === 'sync-gmail'));
  assert(state.contacts.some((contact) => contact.id === 'sync-nina'));
});
test('Sync avoids duplicating a locally added contact', () => {
  const state = syncDemo(addContact(createDemo(), 'My friend Leo', 'leo.b@example.com'), 'gmail');
  assert(state.contacts.filter((contact) => contact.emails.includes('leo.b@example.com')).length === 1);
});
test('Sent messages are grouped by recipient rather than account owner', () => {
  const state = createDemo();
  const sent = { ...state.messages[0], folder: 'sent', to: 'james.w@example.com' };
  assert(groupMessages([sent], state.contacts)[0].key === 'james');
});
test('Invalid persisted data is rejected before rendering', () => {
  for (const invalid of [null, {}, { version: 2 }, { ...createDemo(), contacts: [null] }, { ...createDemo(), messages: [null] }]) {
    assert(!isValidState(invalid));
  }
  const state = createDemo();
  state.messages[0].accountId = 'missing';
  assert(!isValidState(state));
});
test('Invalid dates, duplicate IDs, and missing sent recipients are rejected', () => {
  const badDate = createDemo();
  badDate.messages[0].date = 'broken';
  assert(!isValidState(badDate));
  const duplicates = createDemo();
  duplicates.messages.push(duplicates.messages[0]);
  assert(!isValidState(duplicates));
  const sent = createDemo();
  sent.messages[0].folder = 'sent';
  assert(!isValidState(sent));
});

test('A demo topic contains incoming and outgoing messages in chronological order', () => {
  const state = createDemo();
  const messages = conversationMessages(state, 'm1');
  assert(messages.length === 2);
  assert(messages[0].folder === 'inbox' && messages[1].folder === 'sent');
  assert(messages[0].id === 'm1' && messages[1].id === 'demo-reply-m1');
  assert(conversationMessages(state, 'demo-reply-m1').map((message) => message.id).join() === messages.map((message) => message.id).join());
});
test('Reply prefixes normalize without removing forwarded or unrelated subject text', () => {
  assert(topicSubject(' RE: re :  Weekend plans ') === 'Weekend plans');
  assert(topicSubject('Fwd: Weekend plans') === 'Fwd: Weekend plans');
  assert(topicSubject('Regarding: plans') === 'Regarding: plans');
  const state = createDemo();
  state.messages.find((message) => message.id === 'demo-reply-m1').subject = ' RE: Re: A FEW IDEAS FOR OUR LITTLE GETAWAY ';
  assert(conversationMessages(state, 'm1').length === 2);
});
test('Conversation cards deduplicate a topic and use its latest message', () => {
  const state = createDemo();
  state.messages.push({ ...state.messages[0], id: 'followup', date: '2026-09-29T17:00:00Z', subject: `Re: ${state.messages[0].subject}`, unread: true });
  const conversations = visibleConversations(state);
  assert(conversations.length === 7);
  const topic = conversations.find((conversation) => conversation.id === 'followup');
  assert(topic.messages.length === 3 && topic.unread && topic.latest.id === 'followup');
  assert(topic.subject === 'A few ideas for our little getaway');
});
test('Different accounts, correspondents, aliases, and topics stay separate', () => {
  const state = createDemo();
  const original = state.messages[0];
  state.messages.push(
    { ...original, id: 'other-account', accountId: 'outlook' },
    { ...original, id: 'other-person', sender: 'james.w@example.com' },
    { ...original, id: 'other-alias', sender: 'maya.design@example.com' },
    { ...original, id: 'other-topic', subject: 'A completely different topic' },
  );
  assert(conversationMessages(state, 'm1').length === 2);
  for (const id of ['other-account', 'other-person', 'other-alias', 'other-topic']) {
    assert(conversationMessages(state, id).length === 1);
  }
});
test('New threads with identical subjects stay separate and replies retain explicit thread IDs', () => {
  const state = createDemo();
  const original = state.messages[0];
  state.messages.push({ ...original, id: 'new-thread', threadId: 'new-1' });
  const updated = replyToConversation(state, 'new-thread', 'This belongs to the new thread.');
  assert(conversationMessages(updated, 'new-thread').length === 2);
  assert(conversationMessages(updated, 'm1').length === 2);
  assert(updated.messages.at(-1).threadId === 'new-1');
});
test('Explicit thread IDs still cannot cross accounts or correspondents', () => {
  const state = createDemo();
  const original = { ...state.messages[0], threadId: 'provider-id' };
  state.messages[0] = original;
  state.messages.push({ ...original, id: 'wrong-account', accountId: 'outlook' });
  state.messages.push({ ...original, id: 'wrong-recipient', sender: 'james.w@example.com' });
  assert(conversationMessages(state, 'm1').length === 1);
});
test('Folder filters expose the complete conversation without promoting sent-only topics to inbox', () => {
  const state = createDemo();
  const inbox = visibleConversations(state).find((conversation) => conversation.id === 'm1');
  const sent = visibleConversations(state, { folder: 'sent' })[0];
  assert(inbox.key === sent.key && sent.messages.length === 2);
  state.messages[0].folder = 'archive';
  assert(!visibleConversations(state).some((conversation) => conversation.key === sent.key));
  assert(visibleConversations(state, { folder: 'archive' })[0].messages.length === 2);
  assert(visibleConversations(state, { folder: 'sent' })[0].messages.length === 2);
});
test('Search finds sent text from inbox and retains the complete matching conversation', () => {
  const state = replyToConversation(createDemo(), 'm1', 'The secret word is seashell.');
  const results = visibleConversations(state, { query: 'seashell' });
  assert(results.length === 1 && results[0].messages.length === 3);
  assert(visibleConversations(state, { query: 'seashell', account: 'outlook' }).length === 0);
});
test('Unread and starred filters apply to conversations with matching messages', () => {
  const state = createDemo();
  state.messages[0].unread = true;
  const unread = visibleConversations(state, { unread: true });
  assert(unread.some((conversation) => conversation.messages.length === 2));
  assert(visibleConversations(state, { folder: 'starred' }).find((conversation) => conversation.id === 'm1').messages.length === 2);
});
test('Inline reply preserves message states, recipient, account, and the legacy conversation', () => {
  const state = createDemo();
  const before = JSON.stringify(state);
  const updated = replyToConversation(state, 'm3', '  Saturday works!  ');
  const sent = updated.messages.at(-1);
  assert(sent.body === 'Saturday works!' && sent.accountId === 'outlook');
  assert(sent.to === 'james.w@example.com' && sent.sender === 'alex.morgan@outlook.example');
  assert(sent.folder === 'sent' && !sent.unread && !sent.starred);
  assert(conversationKey(sent) === conversationKey(state.messages.find((message) => message.id === 'm3')));
  assert(JSON.stringify(state) === before);
  assert(isValidState(JSON.parse(JSON.stringify(updated))));
});
test('Replying from Sent goes to the correspondent, not the account owner', () => {
  const state = replyToConversation(createDemo(), 'demo-reply-m1', 'One more thing.');
  assert(state.messages.at(-1).to === 'maya.chen@example.com');
  assert(conversationAddress(state.messages.at(-1)) === 'maya.chen@example.com');
  assert(conversationMessages(state, 'm1').length === 3);
});
test('Unknown senders stay unknown after a reply until their address is added to contacts', () => {
  const state = replyToConversation(createDemo(), 'u2', 'Nice meeting you too.');
  assert(visibleConversations(state, { folder: 'unknown' }).find((conversation) => conversation.id === 'u2').messages.length === 2);
  assert(!visibleConversations(state).some((conversation) => conversation.id === 'u2'));
  const added = addContact(state, 'Riley', ['riley@studio.example']);
  assert(visibleConversations(added).find((conversation) => conversation.id === 'u2').messages.length === 2);
});
test('Renaming contacts and changing alias ownership never splits the underlying thread', () => {
  const state = updateContact(createDemo(), 'maya', 'Maya Rivera', ['maya.design@example.com']);
  assert(conversationMessages(state, 'm1').length === 2);
  assert(visibleConversations(state, { folder: 'unknown' }).some((conversation) => conversation.id === 'm1'));
  const renamed = updateContact(state, 'maya', 'Maya Rivera', ['maya.design@example.com', 'maya.chen@example.com']);
  assert(visibleConversations(renamed, { query: 'Maya Rivera' }).length === 2);
});
test('Whitespace replies and missing conversations fail without mutation', () => {
  const state = createDemo();
  const before = JSON.stringify(state);
  throws(() => replyToConversation(state, 'm1', ' \n '));
  throws(() => replyToConversation(state, 'missing', 'hello'));
  assert(JSON.stringify(state) === before);
});
test('Empty legacy subjects remain separate and gain a stable thread ID on reply', () => {
  const state = createDemo();
  state.messages[0].subject = '';
  state.messages.push({ ...state.messages[0], id: 'another-empty' });
  assert(conversationMessages(state, 'm1').length === 1);
  const updated = replyToConversation(state, 'm1', 'Reply without a subject.');
  assert(conversationMessages(updated, 'm1').length === 2);
  assert(conversationMessages(updated, 'another-empty').length === 1);
  assert(isValidState(updated));
});
test('Thread metadata is optional for old data but must be valid when present', () => {
  assert(isValidState(createDemo()));
  for (const threadId of [null, '', ' ', 42, {}]) {
    const state = createDemo();
    state.messages[0].threadId = threadId;
    assert(!isValidState(state));
  }
});
test('Conversations are sorted by latest activity and sync preserves local replies', () => {
  const state = replyToConversation(createDemo(), 'm7', 'Looking forward to Sunday.');
  state.messages.at(-1).date = '2026-09-30T18:00:00Z';
  const synced = syncDemo(state);
  assert(visibleConversations(synced)[0].id === 'm7');
  assert(conversationMessages(synced, 'm7').length === 2);
});

for (const result of results) {
  const item = document.createElement('li');
  item.className = result.passed ? 'pass' : 'fail';
  item.textContent = `${result.passed ? 'PASS' : 'FAIL'}: ${result.name}${result.error ? ` — ${result.error}` : ''}`;
  document.querySelector('#results').append(item);
}
const failures = results.filter((result) => !result.passed);
document.querySelector('#summary').textContent = `${results.length - failures.length}/${results.length} checks passed.`;
document.title = failures.length ? 'FAIL — Gather checks' : 'PASS — Gather checks';
window.testResults = results;

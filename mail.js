import { messagePreview } from './email-text.js';

export const ACCOUNTS = [
  { id: 'gmail', name: 'Gmail', email: 'alex.morgan@example.com', color: 'coral', letter: 'G' },
  { id: 'outlook', name: 'Outlook', email: 'alex.morgan@outlook.example', color: 'blue', letter: 'O' },
];

export const normalizeEmail = (email) => email.trim().toLowerCase();
export const isEmail = (value) => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export const findContact = (contacts, email) =>
  contacts.find((contact) => contact.emails.some((address) => normalizeEmail(address) === normalizeEmail(email)));

export const isOutgoing = (message) => message.outgoing ?? (message.folder === 'sent' || message.folder === 'drafts' || message.folder === 'outbox');
export const conversationAddress = (message) => isOutgoing(message) ? message.to : message.sender;
export const providerFolderId = (accountId, remoteId) => `provider:${JSON.stringify([accountId, remoteId])}`;
export const topicSubject = (subject) => subject.trim().replace(/^(?:re\s*:\s*)+/i, '').trim();
export const conversationKey = (message) => JSON.stringify([
  message.accountId,
  message.remote ? 'provider-thread' : normalizeEmail(conversationAddress(message)),
  message.threadId ? ['thread', message.threadId] : ['subject', topicSubject(message.subject).toLowerCase() || message.id],
  ...(message.isDraft ? ['draft', message.id] : []),
]);

function matchesSearch(message, contacts, query) {
  const contact = findContact(contacts, conversationAddress(message));
  return [message.subject, message.body, messagePreview(message), message.sender, message.senderName, contact?.name, message.to]
    .filter(Boolean).some((value) => value.toLowerCase().includes(query));
}

export function conversationMessages(state, messageId) {
  const selected = state.messages.find((message) => message.id === messageId);
  if (!selected) return [];
  const key = conversationKey(selected);
  return state.messages.filter((message) => conversationKey(message) === key)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
}

export function visibleConversations(state, options = {}) {
  const { query = '', unread = false } = options;
  const eligible = visibleMessages(state, { ...options, query: '', unread: false });
  const threads = new Map();
  for (const message of state.messages) {
    const key = conversationKey(message);
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key).push(message);
  }
  const result = new Map();
  for (const message of eligible) {
    const key = conversationKey(message);
    if (result.has(key)) continue;
    const messages = threads.get(key).slice().sort((a, b) =>
      Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
    const hasUnread = messages.some((entry) => entry.unread);
    if (unread && !hasUnread) continue;
    if (query.trim() && !messages.some((entry) => matchesSearch(entry, state.contacts, query.trim().toLowerCase()))) continue;
    const latest = messages[messages.length - 1];
    result.set(key, {
      ...message, key, messages, latest,
      subject: topicSubject(messages[0].subject) || '(No subject)',
      date: latest.date, unread: hasUnread, starred: messages.some((entry) => entry.starred),
    });
  }
  return [...result.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.key.localeCompare(b.key));
}

export function replyToConversation(state, messageId, body) {
  const messages = conversationMessages(state, messageId);
  if (!messages.length) throw new Error('This conversation no longer exists.');
  if (typeof body !== 'string' || !body.trim()) throw new Error('Write a message before saving your reply.');
  const last = messages[messages.length - 1];
  if (last.remote) throw new Error('Real accounts are read-only. Sending is not enabled.');
  const from = ACCOUNTS.find((account) => account.id === last.accountId);
  const message = {
    id: crypto.randomUUID(), accountId: from.id, sender: from.email, senderName: 'Alex Morgan',
    to: conversationAddress(last), subject: `Re: ${topicSubject(last.subject) || '(No subject)'}`,
    body: body.trim(), date: new Date().toISOString(), folder: 'sent', unread: false, starred: false,
    ...(last.threadId ? { threadId: last.threadId } : {}),
  };
  // An empty legacy subject cannot safely join unrelated messages by subject alone.
  if (!last.threadId && !topicSubject(last.subject)) {
    message.threadId = crypto.randomUUID();
    return { ...state, messages: [...state.messages.map((entry) =>
      entry.id === last.id ? { ...entry, threadId: message.threadId } : entry), message] };
  }
  return { ...state, messages: [...state.messages, message] };
}

const sampleContact = (id, name, emails, color, note, source) => ({ id, name, emails, color, note, source });
const sampleMessage = (id, sender, senderName, accountId, subject, body, hour, unread = false, starred = false, bodyHtml) => ({
  id, sender, senderName, accountId, subject, body,
  ...(bodyHtml ? { bodyHtml } : {}),
  date: `2026-09-29T${hour}:00:00Z`, unread, starred, folder: 'inbox',
});

export function createDemo() {
  return {
    version: 1,
    lastSync: null,
    contacts: [
      sampleContact('maya', 'Maya Chen', ['maya.chen@example.com', 'maya.design@example.com'], 'sage', 'Design partner & good friend', 'gmail'),
      sampleContact('james', 'James Wilson', ['james.w@example.com'], 'sand', 'Always planning the next adventure', 'outlook'),
      sampleContact('sofia', 'Sofia Martinez', ['sofia.m@example.com'], 'lavender', 'The creative corner', 'gmail'),
      sampleContact('daniel', 'Daniel Park', ['daniel.p@example.com'], 'blue', 'Product team', 'outlook'),
      sampleContact('emma', 'Emma Thompson', ['emma.t@example.com'], 'rose', 'Family & favorite recipes', 'gmail'),
    ],
    messages: [
      sampleMessage('m1', 'maya.chen@example.com', 'Maya Chen', 'gmail', 'A few ideas for our little getaway',
        "Hey Alex,\n\nI've been thinking about our long-overdue weekend away and found the loveliest little cabin by the coast. Big windows, a fireplace, and absolutely no plans required.\n\nImagine slow mornings, coffee on the deck, and finally getting through that stack of books we keep talking about.\n\nAre you free the second weekend in October? I can put together a few options if you're in.\n\nTalk soon,\nMaya", '16', false, true),
      sampleMessage('m2', 'maya.design@example.com', 'Maya Chen', 'gmail', 'The new direction is looking really good',
        "Hi Alex,\n\nI spent a little more time with the color palette this morning. The softer greens feel like exactly the right direction.\n\nLet's catch up tomorrow and look at it together.\n\nMaya", '14', true),
      sampleMessage('m3', 'james.w@example.com', 'James Wilson', 'outlook', 'Saturday coffee?',
        "Hey!\n\nOur favorite spot just opened their outdoor patio. Coffee and a catch-up this Saturday?\n\n10-ish works for me. First flat white is on me.\n\nJames", '13', true),
      sampleMessage('m4', 'james.w@example.com', 'James Wilson', 'gmail', 'Found that playlist I promised you',
        "Alex,\n\nRemember the record playing at dinner last week? I finally found the artist. I'll bring the album over next time.\n\nHope your week is treating you well!\nJames", '12'),
      sampleMessage('m5', 'sofia.m@example.com', 'Sofia Martinez', 'gmail', 'Something beautiful for your afternoon',
        "Hi Alex,\n\nI walked past the new gallery today and thought of you. Their autumn exhibition is full of the landscape photography you love.\n\nWant to go next Thursday evening?\n\nSofia", '11', true, true,
        '<div style="color:#45643b"><h2>Something beautiful for your afternoon</h2><p>Hi Alex,</p><p>I walked past the <strong>new gallery</strong> today and thought of you. Their autumn exhibition is full of the <em>landscape photography</em> you love.</p><blockquote>Want to go next <strong>Thursday evening</strong>?</blockquote><p>Sofia</p></div>'),
      sampleMessage('m6', 'daniel.p@example.com', 'Daniel Park', 'outlook', 'A quick recap from this morning',
        "Hi Alex,\n\nThanks for the thoughtful conversation today. We agreed to keep the first release focused on the people who matter, rather than adding more notifications.\n\nI'll share the updated notes tomorrow. No action needed from you today.\n\nCheers,\nDaniel", '10'),
      sampleMessage('m7', 'emma.t@example.com', 'Emma Thompson', 'gmail', 'Sunday at ours',
        "Hi Alex!\n\nWe're making the big Sunday lunch again. Come around one if you can, and bring an appetite.\n\nI'm trying the apple cake recipe you sent. Fingers crossed!\n\nLove,\nEmma", '09', true),
      sampleMessage('u1', 'hello@papertrail.example', 'Paper Trail', 'gmail', 'Your next chapter starts here',
        "Hello Alex,\n\nOur October reading list is here. Discover five new stories for quieter evenings.\n\nThe Paper Trail team", '15', true),
      sampleMessage('u2', 'riley@studio.example', 'Riley Brooks', 'outlook', 'Nice meeting you at the studio',
        "Hi Alex,\n\nIt was lovely meeting you yesterday. Maya mentioned we might have a few projects in common.\n\nI'd love to continue the conversation sometime.\n\nBest,\nRiley", '12', true),
      sampleMessage('u3', 'updates@weekender.example', 'The Weekender', 'gmail', 'A guide to getting a little lost',
        "Your weekend, reimagined.\n\nA handful of small towns, quiet trails, and places worth taking the long way to.\n\nSee you out there,\nThe Weekender", '08'),
      {
        id: 'demo-reply-m1', sender: ACCOUNTS[0].email, senderName: 'Alex Morgan', accountId: 'gmail',
        to: 'maya.chen@example.com', subject: 'Re: A few ideas for our little getaway',
        body: "That sounds like exactly what we need. Count me in for the second weekend!\n\nSend over the cabin options when you have a moment. I'll take care of the coffee and the book pile.",
        date: '2026-09-29T16:30:00Z', unread: false, starred: false, folder: 'sent',
      },
    ],
  };
}

export function visibleMessages(state, { folder = 'inbox', account = 'all', query = '', unread = false } = {}) {
  const search = query.trim().toLowerCase();
  return state.messages.filter((message) => {
    const contact = findContact(state.contacts, message.sender);
    const matchesFolder = folder === 'inbox'
      ? message.folder === 'inbox' && Boolean(contact)
      : folder === 'unknown'
        ? message.folder === 'inbox' && !contact
        : folder === 'starred' ? message.starred && !['spam', 'trash', 'drafts'].includes(message.folder)
          : folder.startsWith('provider:') ? message.folderIds?.includes(folder) : message.folder === folder;
    return matchesFolder && (account === 'all' || message.accountId === account)
      && (!unread || message.unread)
      && (!search || matchesSearch(message, state.contacts, search));
  }).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

export function groupMessages(messages, contacts) {
  const groups = new Map();
  for (const message of messages) {
    const email = conversationAddress(message);
    const contact = findContact(contacts, email);
    const key = contact?.id || normalizeEmail(email);
    if (!groups.has(key)) groups.set(key, {
      key, contact, name: contact?.name || (isOutgoing(message) ? message.to : message.senderName),
      email, messages: [],
    });
    groups.get(key).messages.push(message);
  }
  return [...groups.values()];
}

function contactDetails(state, name, emails, editingId = null) {
  const addresses = Array.isArray(emails) ? emails : [emails];
  if (typeof name !== 'string' || !name.trim()) throw new Error('Enter a contact name.');
  if (!addresses.length || addresses.some((email) => typeof email !== 'string' || !isEmail(email.trim()))) {
    throw new Error('Enter at least one valid email address. Remove any empty address rows.');
  }
  const normalized = addresses.map(normalizeEmail);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Each email address should appear only once on this contact.');
  }
  for (const email of normalized) {
    const owner = state.contacts.find((contact) => contact.id !== editingId
      && contact.emails.some((address) => normalizeEmail(address) === email));
    if (owner) throw new Error(`${email} already belongs to ${owner.name}. Remove it from that contact first.`);
  }
  return { name: name.trim(), emails: normalized };
}

export function addContact(state, name, emails) {
  const details = contactDetails(state, name, emails);
  return { ...state, contacts: [...state.contacts, sampleContact(
    `local-${crypto.randomUUID()}`, details.name, details.emails, 'sage', 'Added by you', 'local',
  )] };
}

export function updateContact(state, id, name, emails) {
  if (!state.contacts.some((contact) => contact.id === id)) throw new Error('This contact no longer exists.');
  const details = contactDetails(state, name, emails, id);
  return {
    ...state,
    contacts: state.contacts.map((contact) => contact.id === id ? { ...contact, ...details } : contact),
  };
}

export function syncDemo(state, account = 'all') {
  const contacts = [
    sampleContact('sync-leo', 'Leo Bennett', ['leo.b@example.com'], 'sand', 'A new connection, synced from Gmail', 'gmail'),
    sampleContact('sync-nina', 'Nina Patel', ['nina.p@example.com'], 'lavender', 'A new connection, synced from Outlook', 'outlook'),
  ].filter((contact) => account === 'all' || contact.source === account);
  const messages = [
    sampleMessage('sync-gmail', 'leo.b@example.com', 'Leo Bennett', 'gmail', 'Hello from the other side of town',
      "Hey Alex,\n\nI finally made the move! Once the boxes are unpacked, come over for a coffee.\n\nSee you soon,\nLeo", '18', true),
    sampleMessage('sync-outlook', 'nina.p@example.com', 'Nina Patel', 'outlook', 'A small idea for next week',
      "Hi Alex,\n\nWould you be up for a lunchtime walk next week? It would be lovely to catch up away from a screen.\n\nNina", '17', true),
  ].filter((message) => account === 'all' || message.accountId === account);
  return {
    ...state,
    contacts: [...state.contacts, ...contacts.filter((contact) =>
      !state.contacts.some((existing) => existing.id === contact.id) && !findContact(state.contacts, contact.emails[0]))],
    messages: [...state.messages, ...messages.filter((message) => !state.messages.some((existing) => existing.id === message.id))],
    lastSync: new Date().toISOString(),
  };
}

export function isValidState(state) {
  const text = (value) => typeof value === 'string';
  const uniqueIds = (items) => new Set(items.map((item) => item.id)).size === items.length;
  return Boolean(state && state.version === 1
    && (state.lastSync === null || (text(state.lastSync) && Number.isFinite(Date.parse(state.lastSync))))
    && Array.isArray(state.contacts) && Array.isArray(state.messages)
    && state.contacts.every((contact) => contact && text(contact.id) && text(contact.name) && contact.name.trim()
      && text(contact.note) && ['sage', 'sand', 'lavender', 'blue', 'rose'].includes(contact.color)
      && ['gmail', 'outlook', 'local'].includes(contact.source)
      && Array.isArray(contact.emails) && contact.emails.length > 0 && contact.emails.every(isEmail))
    && state.messages.every((message) => message
      && ['id', 'senderName', 'subject', 'body'].every((field) => text(message[field]))
      && (message.bodyHtml === undefined || text(message.bodyHtml))
      && isEmail(message.sender) && ACCOUNTS.some((account) => account.id === message.accountId)
      && ['inbox', 'archive', 'sent'].includes(message.folder)
      && (message.folder !== 'sent' || isEmail(message.to))
      && (message.threadId === undefined || (text(message.threadId) && Boolean(message.threadId.trim())))
      && text(message.date) && Number.isFinite(Date.parse(message.date))
      && typeof message.unread === 'boolean' && typeof message.starred === 'boolean')
    && uniqueIds(state.contacts) && uniqueIds(state.messages)
    && new Set(state.contacts.flatMap((contact) => contact.emails.map(normalizeEmail))).size
      === state.contacts.reduce((total, contact) => total + contact.emails.length, 0));
}

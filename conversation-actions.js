import { conversationMessages, findContact, isEmail, isOutgoing, normalizeEmail, providerFolderId } from './mail.js';
import { identifyAccount, importedContact, importContacts } from './provider-mail.js';

export class ConversationActionError extends Error {
  constructor(message, { uncertain = false, completed = 0 } = {}) {
    super(message);
    this.name = 'ConversationActionError';
    this.uncertain = uncertain;
    this.completed = completed;
  }
}

export function unknownSenders(state, messageId) {
  const messages = conversationMessages(state, messageId);
  const seen = new Set();
  return [...messages].reverse().filter((message) => {
    const email = normalizeEmail(message.sender);
    if (isOutgoing(message) || seen.has(email) || findContact(state.contacts, email)) return false;
    seen.add(email);
    return true;
  }).map((message) => ({ email: normalizeEmail(message.sender), name: message.senderName }));
}

export function updateDemoConversation(state, messageId, action) {
  if (!['archive', 'trash'].includes(action)) throw new Error('Unsupported conversation action.');
  const messages = conversationMessages(state, messageId);
  if (!messages.length || messages.some((message) => message.remote)) throw new Error('This is not a demo conversation.');
  const ids = new Set(messages.map((message) => message.id));
  return { ...state, messages: state.messages.map((message) => {
    if (!ids.has(message.id)) return message;
    if (action === 'archive' && (isOutgoing(message) || ['trash', 'spam', 'drafts'].includes(message.folder))) return message;
    return { ...message, outgoing: isOutgoing(message), folder: action === 'trash' ? 'trash' : 'archive' };
  }) };
}

export function createActionRequest(getToken, provider, fetcher = fetch) {
  return async (url, body, method = 'POST') => {
    const target = new URL(url);
    const allowed = provider === 'gmail'
      ? target.origin === 'https://gmail.googleapis.com' && /^\/gmail\/v1\/users\/me\/threads\/[^/]+\/(?:modify|trash)$/.test(target.pathname)
        || target.origin === 'https://people.googleapis.com' && target.pathname === '/v1/people:createContact'
      : provider === 'outlook' && target.origin === 'https://graph.microsoft.com'
        && (/^\/v1\.0\/me\/messages\/[^/]+\/move$/.test(target.pathname) || target.pathname === '/v1.0/me/contacts');
    const readPatch = method === 'PATCH' && provider === 'outlook' && target.origin === 'https://graph.microsoft.com'
      && /^\/v1\.0\/me\/messages\/[^/]+$/.test(target.pathname)
      && body?.isRead === true && Object.keys(body).length === 1;
    if (!(method === 'POST' && allowed || readPatch) || target.username || target.password) throw new Error('Unsupported provider mutation endpoint.');
    const token = await getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      let response;
      try {
        response = await fetcher(target.href, {
          method, body: body === undefined ? undefined : JSON.stringify(body),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(provider === 'outlook' ? { Prefer: 'IdType="ImmutableId"' } : {}) },
          credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
        });
      } catch {
        throw new ConversationActionError('The provider result could not be confirmed. Some changes may already have been applied. Check the provider and sync before retrying.', { uncertain: true });
      }
      if (!response.ok) {
        const uncertain = response.status >= 500 || response.status === 408;
        const advice = uncertain ? 'The result is uncertain; check the provider and sync before retrying.'
          : [401, 403].includes(response.status) ? 'Reconnect and grant mail modification or contacts editing permission. Account policy may also restrict access.'
            : response.status === 429 ? 'The provider is rate-limiting changes. Wait before retrying.'
              : 'Refresh the mailbox and try again.';
        throw new ConversationActionError(`Provider action failed (HTTP ${response.status}). ${advice}`, { uncertain });
      }
      if (response.status === 204) return null;
      try { return await response.json(); }
      catch { throw new ConversationActionError('The provider accepted the action but returned an unreadable result. Sync before retrying.', { uncertain: true }); }
    } finally { clearTimeout(timer); }
  };
}

export async function changeProviderConversation(snapshot, messageId, action, api, request, progress = () => {}) {
  if (!['archive', 'trash', 'read'].includes(action)) throw new Error('Unsupported conversation action.');
  const reading = action === 'read';
  const cached = conversationMessages({ messages: snapshot.messages }, messageId)
    .filter(message => !reading || message.remote && !message.sendState && !message.isDraft);
  if (!cached.length || cached.some((message) => !message.remote || message.accountId !== snapshot.account.id || message.sendState || message.isDraft)) {
    throw new Error('Sync or resolve local send attempts before changing this conversation. Provider drafts are not managed here.');
  }
  const { account } = snapshot;
  const verified = await identifyAccount(account.provider, api, account.clientId);
  if (verified.id !== account.id) throw new Error('A different account is authorized. Reconnect the original account.');
  const threadId = cached[0].threadId;
  if (account.provider === 'gmail') {
    const base = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`;
    const thread = await api(`${base}?format=minimal`);
    if (!Array.isArray(thread.messages)) throw new Error('Gmail returned incomplete conversation information.');
    if (reading) {
      const candidates = thread.messages.filter(message => message.labelIds?.includes('UNREAD'));
      if (candidates.length) {
        progress('Marking Gmail conversation as read...');
        await request(`${base}/modify`, { removeLabelIds: ['UNREAD'] });
      }
      return { changed: candidates.length, updates: cached.filter(message => message.unread).map(message => ({
        ...message, unread: false,
        folderIds: message.folderIds.filter(id => id !== providerFolderId(account.id, 'UNREAD')),
      })) };
    }
    const candidates = thread.messages.filter((message) => action === 'archive' ? message.labelIds?.includes('INBOX') : !message.labelIds?.includes('TRASH'));
    if (!candidates.length) return { changed: 0, updates: [] };
    progress(action === 'trash' ? 'Moving the Gmail conversation to Trash...' : 'Archiving the Gmail conversation...');
    await request(`${base}/${action === 'trash' ? 'trash' : 'modify'}`, action === 'archive' ? { removeLabelIds: ['INBOX'] } : undefined);
    const updates = cached.filter((message) => action === 'trash' || message.folderIds?.includes(providerFolderId(account.id, 'INBOX')))
      .map((message) => ({
        ...message,
        folder: action === 'trash' ? 'trash' : message.folder === 'inbox' ? 'archive' : message.folder,
        folderIds: action === 'trash'
          ? [...new Set([...(message.folderIds || []).filter((id) => id !== providerFolderId(account.id, 'INBOX')), providerFolderId(account.id, 'TRASH')])]
          : message.folderIds.filter((id) => id !== providerFolderId(account.id, 'INBOX')),
      }));
    return { changed: candidates.length, updates, destination: action === 'trash' ? {
      id: providerFolderId(account.id, 'TRASH'), remoteId: 'TRASH', accountId: account.id,
      name: 'Trash', path: 'Trash', kind: 'label', parentId: null, hidden: false,
    } : null };
  }
  const destination = reading ? null : await api(`https://graph.microsoft.com/v1.0/me/mailFolders/${action === 'archive' ? 'archive' : 'deleteditems'}?$select=id`);
  if (!reading && !destination?.id) throw new Error('The destination folder is not available. Open Outlook to create or enable it, then sync.');
  const byId = new Map((snapshot.folders || []).map((folder) => [folder.remoteId, folder]));
  let url = `https://graph.microsoft.com/v1.0/me/messages?$filter=${encodeURIComponent(`conversationId eq '${threadId.replace(/'/g, "''")}'`)}&$select=id,conversationId,parentFolderId,isDraft,isRead,from,sender&$top=100`;
  const seenPages = new Set(), messages = new Map();
  while (url) {
    if (seenPages.has(url)) throw new Error('Outlook repeated a conversation page. No changes were made.');
    seenPages.add(url);
    const page = await api(url, { Prefer: 'IdType="ImmutableId"' });
    if (!Array.isArray(page.value)) throw new Error('Outlook returned incomplete conversation information. No changes were made.');
    for (const message of page.value) {
      if (!message.id || message.conversationId !== threadId || !message.parentFolderId) throw new Error('Outlook returned an unexpected conversation message. No changes were made.');
      if (reading && typeof message.isRead !== 'boolean') throw new Error('Outlook returned incomplete read status. No changes were made.');
      messages.set(message.id, message);
    }
    url = page['@odata.nextLink'] || null;
  }
  const candidates = [...messages.values()].filter((message) => {
    if (reading) return !message.isDraft && !message.isRead;
    if (message.parentFolderId === destination.id) return false;
    if (action === 'trash') return true;
    const kind = byId.get(message.parentFolderId)?.kind;
    if (!kind) throw new Error('A conversation folder has changed. Sync the mailbox before archiving.');
    const sender = message.from?.emailAddress?.address || message.sender?.emailAddress?.address;
    return !message.isDraft && !(isEmail(sender) && normalizeEmail(sender) === account.email)
      && !['sent', 'outbox', 'spam', 'trash', 'drafts'].includes(kind);
  });
  const updates = reading ? cached.filter(message => message.unread && messages.get(message.remoteId)?.isRead)
    .map(message => ({ ...message, unread: false })) : [];
  const destinationFolder = reading ? null : {
    id: providerFolderId(account.id, destination.id), remoteId: destination.id, accountId: account.id,
    name: action === 'archive' ? 'Archive' : 'Deleted Items', path: action === 'archive' ? 'Archive' : 'Deleted Items',
    kind: action === 'archive' ? 'archive' : 'trash', parentId: null, hidden: false,
  };
  let changed = 0;
  for (const message of candidates) {
    progress(`${reading ? 'Marking read: Outlook' : 'Moving Outlook'} conversation message ${changed + 1} of ${candidates.length}...`);
    try {
      if (reading) {
        const result = await request(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(message.id)}`, { isRead: true }, 'PATCH');
        if (result !== null && result?.isRead !== true) throw new ConversationActionError('Outlook did not confirm the read status. Sync before retrying.', { uncertain: true });
        changed++;
        const local = cached.find(entry => entry.remoteId === message.id);
        if (local) updates.push({ ...local, unread: false });
        continue;
      }
      const result = await request(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(message.id)}/move`, { destinationId: destination.id });
      if (!result?.id) throw new ConversationActionError('Outlook accepted a move without a usable message ID. Sync to confirm its location.', { uncertain: true });
      changed++;
      const local = cached.find((entry) => entry.remoteId === message.id);
      if (local) updates.push({ ...local, id: `${account.id}:${result.id}`, remoteId: result.id,
        providerParentId: destination.id, folder: action === 'archive' ? 'archive' : 'trash',
        folderIds: [providerFolderId(account.id, destination.id)],
        previousId: local.id });
    } catch (error) {
      const failure = new ConversationActionError(`${changed} of ${candidates.length} messages ${reading ? 'marked read' : 'moved'} before the operation stopped. ${error.message}`, {
        completed: changed, uncertain: Boolean(error.uncertain),
      });
      failure.updates = updates;
      failure.destination = destinationFolder;
      throw failure;
    }
  }
  return { changed, updates, destination: destinationFolder };
}

export async function addProviderSender(snapshot, sender, name, api, post, beforeCreate = async () => {}) {
  if (typeof sender !== 'string' || typeof name !== 'string') throw new Error('Enter a contact name and valid sender address.');
  const email = normalizeEmail(sender);
  if (!isEmail(email) || !name.trim() || name.length > 100) throw new Error('Enter a contact name and valid sender address.');
  const current = await identifyAccount(snapshot.account.provider, api, snapshot.account.clientId);
  if (current.id !== snapshot.account.id) throw new Error('A different account is authorized. Reconnect the original account.');
  const contacts = await importContacts(snapshot.account, api);
  const existing = findContact(contacts, email);
  if (existing) return { contact: existing, contacts, existing: true };
  if (snapshot.pendingContact) {
    throw new Error('An earlier contact creation has an unconfirmed result. Check contacts at the provider and sync before trying again; it may already exist.');
  }
  await beforeCreate(email);
  const google = snapshot.account.provider === 'gmail';
  const result = await post(google ? 'https://people.googleapis.com/v1/people:createContact?personFields=names,emailAddresses'
    : 'https://graph.microsoft.com/v1.0/me/contacts', google
    ? { names: [{ unstructuredName: name.trim() }], emailAddresses: [{ value: email }] }
    : { givenName: name.trim(), emailAddresses: [{ address: email, name: name.trim() }] });
  const id = google ? result?.resourceName : result?.id;
  if (!id) throw new ConversationActionError('The contact may have been created, but the provider returned no contact ID. Check contacts and sync before retrying.', { uncertain: true });
  const contact = importedContact(id, name.trim(), [email], snapshot.account);
  return { contact, contacts: [...contacts, contact], existing: false };
}

import { isEmail, normalizeEmail, providerFolderId } from './mail.js';
import { plainTextFromHtml } from './email-text.js';
export { plainTextFromHtml } from './email-text.js';

export const PROVIDERS = {
  gmail: { name: 'Gmail', color: 'coral', letter: 'G' },
  outlook: { name: 'Outlook', color: 'blue', letter: 'O' },
};
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PEOPLE = 'https://people.googleapis.com/v1/people/me/connections';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const DAY = 86400000;
const BODY_FORMAT = 3;
const FOLDER_FORMAT = 1;
const GRAPH_SYSTEM_FOLDERS = {
  inbox: 'inbox', sentitems: 'sent', archive: 'archive', drafts: 'drafts',
  junkemail: 'spam', deleteditems: 'trash', outbox: 'outbox',
};
const GMAIL_SYSTEM_NAMES = {
  INBOX: 'Inbox', SENT: 'Sent', DRAFT: 'Drafts', SPAM: 'Spam', TRASH: 'Trash',
  STARRED: 'Starred', IMPORTANT: 'Important', UNREAD: 'Unread', CHAT: 'Chats',
  CATEGORY_PERSONAL: 'Personal', CATEGORY_SOCIAL: 'Social', CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_UPDATES: 'Updates', CATEGORY_FORUMS: 'Forums',
};

export class ProviderError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

let gmailRequestQueue = Promise.resolve();
let nextGmailRequestAt = 0;

async function paceGmailRequest(signal) {
  const previous = gmailRequestQueue;
  let release;
  gmailRequestQueue = new Promise((resolve) => { release = resolve; });
  try {
    await previous;
    signal?.throwIfAborted();
    const delay = Math.max(0, nextGmailRequestAt - Date.now());
    if (delay) await pause(delay, signal);
    nextGmailRequestAt = Date.now() + 200;
  } finally { release(); }
}

function apiContext(target) {
  if (target.hostname === 'people.googleapis.com') return 'Google People API (contacts sync)';
  if (target.hostname === 'gmail.googleapis.com') {
    const operation = target.pathname.endsWith('/profile') ? 'account lookup'
      : target.pathname.endsWith('/labels') ? 'folder/label discovery'
        : target.pathname.endsWith('/history') ? 'incremental mail sync'
          : target.pathname.includes('/attachments/') ? 'embedded image download' : 'mail import';
    return `Gmail API (${operation})`;
  }
  return 'Microsoft Graph';
}

async function errorReasons(response, signal) {
  let body;
  try { body = await response.json(); }
  catch (error) {
    signal?.throwIfAborted();
    // Some proxies return HTML or an empty body. Keep the HTTP failure actionable.
    if (error instanceof SyntaxError || error instanceof TypeError) return [];
    throw error;
  }
  const error = body?.error;
  return [
    ...(Array.isArray(error?.details) ? error.details.map((detail) => detail?.reason) : []),
    ...(Array.isArray(error?.errors) ? error.errors.map((detail) => detail?.reason) : []),
    error?.status, error?.code,
  ].filter((reason) => typeof reason === 'string');
}

function googleForbidden(target, reasons) {
  const has = (...codes) => codes.some((code) => reasons.includes(code));
  const people = target.hostname === 'people.googleapis.com';
  const service = people ? 'People API' : 'Gmail API';
  if (has('SERVICE_DISABLED', 'accessNotConfigured', 'serviceDisabled')) {
    return `${service} is disabled or has not been enabled in the Google Cloud project that owns your OAuth client ID. Open Google Cloud Console > APIs & Services > Library, select that project, and enable ${service}. Wait a few minutes, then retry Sync. [SERVICE_DISABLED]`;
  }
  if (has('ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientPermissions')) {
    const scope = people ? 'https://www.googleapis.com/auth/contacts.readonly' : 'https://www.googleapis.com/auth/gmail.readonly';
    return `The access token lacks the required permission (${scope}). In Accounts, Reconnect Google and grant both mail and contacts permissions. If consent is not offered, remove Gather's access in your Google account settings and reconnect. [ACCESS_TOKEN_SCOPE_INSUFFICIENT]`;
  }
  if (has('domainPolicy', 'ORG_RESTRICTION_VIOLATION', 'ORG_POLICY_VIOLATION')) {
    return 'Your Google Workspace organization blocks this app or API. Ask your administrator to allow the OAuth app and Gmail/contacts access. Reconnecting alone will not change this policy. [domainPolicy]';
  }
  if (has('dailyLimitExceeded', 'dailyLimitExceededUnreg', 'quotaExceeded', 'QUOTA_EXCEEDED')) {
    return `${service} quota has been exhausted. Check APIs & Services > ${service} > Quotas in the project that owns the OAuth client ID, or wait for the quota to reset. Changing permissions will not fix a quota error. [QUOTA_EXCEEDED]`;
  }
  return `Access was denied (HTTP 403). ${service} did not provide a recognized reason. Check that ${service} is enabled in the project owning your OAuth client ID, then Reconnect and grant both read-only mail and contacts permissions. A Workspace administrator may also restrict access.`;
}

export function createApi(getToken, provider, signal, fetcher = fetch, { onWait = () => {}, wait = pause } = {}) {
  const origins = provider === 'gmail'
    ? ['https://gmail.googleapis.com', 'https://people.googleapis.com']
    : ['https://graph.microsoft.com'];
  return async (url, headers = {}) => {
    const target = new URL(url);
    if (!origins.includes(target.origin) || target.username || target.password) {
      throw new ProviderError('The provider returned an unsafe pagination URL. Sync stopped.');
    }
    const context = apiContext(target);
    for (let attempt = 0; attempt < 5; attempt++) {
      signal?.throwIfAborted();
      if (target.hostname === 'gmail.googleapis.com') await paceGmailRequest(signal);
      const token = await getToken();
      let response;
      try {
        response = await fetcher(target.href, {
          method: 'GET', headers: { ...headers, Authorization: `Bearer ${token}` },
          credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new ProviderError('Cannot reach the email provider. Check your connection, browser policy, and try Sync again.');
      }
      const reasons = !response.ok ? await errorReasons(response, signal) : [];
      const googleRateLimit = provider === 'gmail' && response.status === 403
        && reasons.some((reason) => ['rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED'].includes(reason))
        && !reasons.some((reason) => ['dailyLimitExceeded', 'quotaExceeded', 'QUOTA_EXCEEDED', 'SERVICE_DISABLED', 'accessNotConfigured', 'insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'domainPolicy'].includes(reason));
      const retryable = [429, 503].includes(response.status) || googleRateLimit;
      const retryLimit = provider === 'gmail' ? 4 : 2;
      if (retryable && attempt < retryLimit) {
        const retry = response.headers.get('Retry-After');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000;
        const maxWait = provider === 'gmail' ? 120000 : 30000;
        if (seconds * 1000 > maxWait) throw new ProviderError(`${context}: the provider requested a ${Math.ceil(seconds)} second pause. Try Sync again later.`, response.status);
        const delay = Math.min(maxWait, Math.max((provider === 'gmail' ? 5000 : 1000) * 2 ** attempt, Number.isFinite(seconds) ? seconds * 1000 : 0));
        onWait(`${context}: ${googleRateLimit || response.status === 429 ? 'rate-limited' : 'temporarily unavailable'}. Waiting ${Math.ceil(delay / 1000)} seconds before retry ${attempt + 1} of ${retryLimit}. You can cancel sync.`);
        await wait(delay, signal);
        continue;
      }
      if (!response.ok) {
        const reason = response.status === 401 ? 'Authorization expired. Reconnect this account.'
          : googleRateLimit ? 'Google is rate-limiting requests. Retried with backoff but the limit persists. Wait and try Sync again; changing permissions will not fix this. [RATE_LIMIT_EXCEEDED]'
            : response.status === 403 ? provider === 'gmail' ? googleForbidden(target, reasons)
              : 'Access was denied. Check that mail and contacts permissions are granted and the APIs are enabled.'
            : [429, 503].includes(response.status) ? 'The provider is busy or rate-limiting requests. Try Sync again later.'
              : `The provider returned HTTP ${response.status}. The previous cache has been preserved.`;
        throw new ProviderError(`${context}: ${reason}`, response.status);
      }
      return response.json();
    }
  };
}

function decodeBody(data, mime = '') {
  const bytes = Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
  const charset = /charset=["']?([^;"'\s]+)/i.exec(mime)?.[1] || 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    throw new ProviderError(`This message uses an unsupported character encoding (${charset}). Import stopped; your previous cache is unchanged.`);
  }
}

function header(payload, name) {
  return payload?.headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function addresses(value) {
  return [...value.matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
    .map((match) => normalizeEmail(match[0]));
}

export function gmailMessage(raw, account, since) {
  const labels = raw.labelIds || [];
  const milliseconds = Number(raw.internalDate);
  if (milliseconds < Date.parse(since)) return null;
  if (!raw.id || !raw.threadId || !Number.isFinite(milliseconds)) throw new ProviderError('Gmail returned incomplete message metadata.');
  const senderHeader = header(raw.payload, 'From');
  const isDraft = labels.includes('DRAFT');
  const sender = addresses(senderHeader)[0] || (isDraft ? account.email : null);
  if (!sender) throw new ProviderError('A Gmail message has no usable sender address. Import stopped without replacing the cache.');
  const toAddresses = addresses(header(raw.payload, 'To'));
  const sent = labels.includes('SENT');
  const to = toAddresses.find((email) => email !== account.email) || toAddresses[0] || account.email;
  const plain = [], html = [];
  let omitted = false;
  function visit(part) {
    if (!part || part.filename || part.mimeType === 'message/rfc822') return;
    if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
      if (part.body?.data) {
        const text = decodeBody(part.body.data, header(part, 'Content-Type'));
        (part.mimeType === 'text/plain' ? plain : html).push(text);
      } else if (part.body?.attachmentId) omitted = true;
    }
    (part.parts || []).forEach(visit);
  }
  visit(raw.payload);
  const body = plain.length ? plain.join('\n\n') : html.length ? html.map(plainTextFromHtml).join('\n\n')
    : omitted ? '[The provider stored this body as an attachment. Open the message in Gmail to read it.]'
      : '[No displayable text body. Attachments are not downloaded.]';
  return {
    id: `${account.id}:${raw.id}`, remoteId: raw.id, remote: true, accountId: account.id, threadId: raw.threadId,
    sender, senderName: senderHeader.replace(/<[^>]*>/g, '').replace(/^"|"$/g, '').trim() || sender,
    outgoing: sent || isDraft || sender === account.email, isDraft,
    folderIds: labels.map((id) => providerFolderId(account.id, id)),
    recipientMissing: isDraft && !toAddresses.length,
    to, participants: [...new Set([sender, ...toAddresses, ...addresses(header(raw.payload, 'Cc'))])],
    toRecipients: toAddresses, ccRecipients: addresses(header(raw.payload, 'Cc')), replyTo: addresses(header(raw.payload, 'Reply-To')),
    clientSendId: header(raw.payload, 'X-Gather-Send-ID'), references: header(raw.payload, 'References'),
    subject: header(raw.payload, 'Subject'), body, ...(html.length ? { bodyHtml: html.join('\n\n') } : {}),
    date: new Date(milliseconds).toISOString(),
    folder: labels.includes('TRASH') ? 'trash' : labels.includes('SPAM') ? 'spam' : isDraft ? 'drafts'
      : sent ? 'sent' : labels.includes('INBOX') ? 'inbox' : 'archive',
    unread: labels.includes('UNREAD'), starred: labels.includes('STARRED'),
    internetMessageId: header(raw.payload, 'Message-ID'), inReplyTo: header(raw.payload, 'In-Reply-To'),
  };
}

export function graphMessage(raw, account, folder, since, folderId = raw.parentFolderId) {
  const isDraft = Boolean(raw.isDraft);
  const date = isDraft || folder === 'outbox' ? raw.lastModifiedDateTime || raw.createdDateTime || raw.receivedDateTime
    : raw.receivedDateTime || raw.sentDateTime || raw.createdDateTime;
  if (Date.parse(date) < Date.parse(since)) return null;
  const sender = raw.from?.emailAddress?.address || raw.sender?.emailAddress?.address || (isDraft ? account.email : null);
  if (!raw.id || (!raw.conversationId && !isDraft) || !isEmail(sender) || !Number.isFinite(Date.parse(date))) {
    throw new ProviderError('Outlook returned incomplete message metadata. Import stopped without replacing the cache.');
  }
  const recipients = (raw.toRecipients || []).map((entry) => entry.emailAddress?.address).filter(isEmail).map(normalizeEmail);
  const to = recipients.find((email) => email !== account.email) || recipients[0] || account.email;
  return {
    id: `${account.id}:${raw.id}`, remoteId: raw.id, remote: true, accountId: account.id, threadId: raw.conversationId || `draft:${raw.id}`,
    folderIds: folderId ? [providerFolderId(account.id, folderId)] : [],
    providerParentId: raw.parentFolderId || folderId || '',
    outgoing: isDraft || folder === 'sent' || folder === 'outbox' || normalizeEmail(sender) === account.email,
    isDraft, recipientMissing: isDraft && !recipients.length,
    sender: normalizeEmail(sender), senderName: raw.from?.emailAddress?.name || sender, to,
    toRecipients: recipients,
    ccRecipients: (raw.ccRecipients || []).map((entry) => entry.emailAddress?.address).filter(isEmail).map(normalizeEmail),
    replyTo: (raw.replyTo || []).map((entry) => entry.emailAddress?.address).filter(isEmail).map(normalizeEmail),
    clientSendId: raw.internetMessageHeaders?.find((entry) => entry.name.toLowerCase() === 'x-gather-send-id')?.value || '',
    participants: [...new Set([normalizeEmail(sender), ...recipients,
      ...(raw.ccRecipients || []).map((entry) => entry.emailAddress?.address).filter(isEmail).map(normalizeEmail)])],
    subject: raw.subject || '', body: raw.body?.contentType?.toLowerCase() === 'html'
      ? plainTextFromHtml(raw.body.content || '') : raw.body?.content || '[No displayable text body.]',
    ...(raw.body?.contentType?.toLowerCase() === 'html' && raw.body.content ? { bodyHtml: raw.body.content } : {}),
    date: new Date(date).toISOString(), folder: isDraft && !['spam', 'trash'].includes(folder) ? 'drafts' : folder,
    unread: !raw.isRead, starred: raw.flag?.flagStatus === 'flagged',
    internetMessageId: raw.internetMessageId || '',
  };
}

function importedContact(id, name, emails, account) {
  const normalized = [...new Set(emails.filter(isEmail).map(normalizeEmail))];
  if (!normalized.length) return null;
  return { id: `${account.id}:${id}`, name: name || normalized[0], emails: normalized,
    source: account.provider, accountId: account.id, color: account.provider === 'gmail' ? 'sage' : 'blue',
    note: `Imported from ${PROVIDERS[account.provider].name}. Read-only.` };
}

export function combineSnapshots(snapshots) {
  const contacts = [];
  for (const snapshot of snapshots) {
    for (const contact of snapshot.contacts) {
      // Provider contact books may contain duplicates; combine overlapping address sets.
      const overlaps = contacts.filter((existing) => existing.emails.some((email) => contact.emails.includes(email)));
      if (!overlaps.length) {
        contacts.push({ ...contact, accountIds: [snapshot.account.id] });
      } else {
        const target = overlaps[0];
        target.emails = [...new Set([...contact.emails, ...overlaps.flatMap((entry) => entry.emails)])];
        target.accountIds = [...new Set([snapshot.account.id, ...overlaps.flatMap((entry) => entry.accountIds)])];
        overlaps.slice(1).forEach((entry) => contacts.splice(contacts.indexOf(entry), 1));
      }
    }
  }
  return {
    version: 1, contacts, messages: snapshots.flatMap((snapshot) => snapshot.messages),
    folders: snapshots.flatMap((snapshot) => snapshot.folders || []),
    accounts: snapshots.map((snapshot) => ({ ...PROVIDERS[snapshot.account.provider], ...snapshot.account })),
    lastSync: snapshots.length ? snapshots.map((snapshot) => snapshot.lastSync).sort()[0] : null,
  };
}

async function pages(api, initialUrl, field, onPage, signal, headers = {}) {
  let url = initialUrl;
  const seen = new Set();
  while (url) {
    signal?.throwIfAborted();
    if (seen.has(url)) throw new ProviderError('The provider repeated a pagination link. Sync stopped.');
    seen.add(url);
    const page = await api(url, headers);
    if (!Array.isArray(page[field])) throw new ProviderError('The provider returned an invalid collection. Sync stopped without replacing the cache.');
    await onPage(page[field], page);
    url = page['@odata.nextLink'] || null;
  }
}

export async function discoverFolders(account, api, signal) {
  if (account.provider === 'gmail') {
    const response = await api(`${GMAIL}/labels`);
    if (!Array.isArray(response.labels)) throw new ProviderError('Gmail returned an invalid label catalog.');
    const folders = response.labels.map((label) => {
      if (typeof label.id !== 'string' || !label.id || typeof label.name !== 'string') throw new ProviderError('Gmail returned incomplete label metadata.');
      return { id: providerFolderId(account.id, label.id), remoteId: label.id, accountId: account.id,
        name: label.type === 'system' ? GMAIL_SYSTEM_NAMES[label.id] || label.name : label.name,
        parentId: null, kind: 'label', hidden: label.labelListVisibility === 'labelHide',
        path: label.type === 'system' ? GMAIL_SYSTEM_NAMES[label.id] || label.name : label.name };
    });
    if (new Set(folders.map((folder) => folder.id)).size !== folders.length) throw new ProviderError('Gmail repeated a label in its catalog. Sync stopped.');
    for (const folder of folders) {
      const parent = folder.path.includes('/') ? folders.find((entry) => entry.path === folder.path.slice(0, folder.path.lastIndexOf('/'))) : null;
      if (parent && parent !== folder) { folder.parentId = parent.id; folder.name = folder.path.slice(parent.path.length + 1); }
    }
    return folders;
  }
  const fields = 'id,displayName,parentFolderId,childFolderCount,isHidden';
  const folders = [];
  const ids = new Set();
  const queue = [{ url: `${GRAPH}/me/mailFolders?includeHiddenFolders=true&$select=${fields}&$top=100`, parent: null }];
  for (let index = 0; index < queue.length; index++) {
    const { url, parent } = queue[index];
    await pages(api, url, 'value', (items) => {
      for (const item of items) {
        if (typeof item.id !== 'string' || !item.id || typeof item.displayName !== 'string' || !Number.isInteger(item.childFolderCount)
          || item.childFolderCount < 0) throw new ProviderError('Outlook returned incomplete folder metadata.');
        if (ids.has(item.id)) throw new ProviderError('Outlook repeated a folder in its hierarchy. Sync stopped.');
        ids.add(item.id);
        const folder = {
          id: providerFolderId(account.id, item.id), remoteId: item.id, accountId: account.id,
          name: item.displayName, path: parent ? `${parent.path}/${item.displayName}` : item.displayName,
          parentId: parent?.id || null, kind: 'other', hidden: Boolean(item.isHidden),
          search: item['@odata.type'] === '#microsoft.graph.mailSearchFolder',
        };
        folders.push(folder);
        if (item.childFolderCount) queue.push({
          url: `${GRAPH}/me/mailFolders/${encodeURIComponent(item.id)}/childFolders?includeHiddenFolders=true&$select=${fields}&$top=100`,
          parent: folder,
        });
      }
    }, signal);
  }
  for (const [wellKnown, kind] of Object.entries(GRAPH_SYSTEM_FOLDERS)) {
    signal?.throwIfAborted();
    try {
      const item = await api(`${GRAPH}/me/mailFolders/${wellKnown}?$select=id`);
      const folder = folders.find((entry) => entry.remoteId === item.id);
      if (folder) folder.kind = kind;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  // Descendants of Junk/Deleted stay out of normal aggregated views.
  for (const folder of folders) {
    const parent = folders.find((entry) => entry.id === folder.parentId);
    if (parent && ['spam', 'trash'].includes(parent.kind)) folder.kind = parent.kind;
  }
  return folders;
}

export async function identifyAccount(provider, api, clientId) {
  if (provider === 'gmail') {
    const profile = await api(`${GMAIL}/profile`);
    if (!isEmail(profile.emailAddress)) throw new ProviderError('Gmail did not return a valid account address.');
    const email = normalizeEmail(profile.emailAddress);
    return { id: `gmail:${email}`, provider, email, clientId };
  }
  const profile = await api(`${GRAPH}/me?$select=id,mail,userPrincipalName`);
  const email = profile.mail || profile.userPrincipalName;
  if (!profile.id || !isEmail(email)) throw new ProviderError('This Microsoft account does not have an accessible Outlook mailbox.');
  return { id: `outlook:${profile.id}`, provider, email: normalizeEmail(email), clientId };
}

export async function importMailbox({ account, api, previous = null, days = 30, signal, progress = () => {} }) {
  if (![7, 30, 90, 365].includes(days)) throw new ProviderError('Choose a supported initial mail date range.');
  const since = previous?.days === days ? previous.since : new Date(Date.now() - days * DAY).toISOString();
  const current = await identifyAccount(account.provider, api, account.clientId);
  if (current.id !== account.id) throw new ProviderError('A different account was authorized. Reconnect the correct account; the cache has not changed.');
  const contacts = [];
  progress('Discovering all provider folders and labels...');
  const folders = await discoverFolders(account, api, signal);
  let messages;
  let cursors = Object.create(null);
  const full = !previous || previous.days !== days || previous.bodyFormat !== BODY_FORMAT || previous.folderFormat !== FOLDER_FORMAT;
  if (previous && previous.bodyFormat !== BODY_FORMAT) progress('Refreshing cached mail to include original HTML and reply metadata...');
  if (previous && previous.folderFormat !== FOLDER_FORMAT) progress('Expanding the cache to all folders, including drafts, spam, and deleted mail...');
  if (account.provider === 'gmail') {
    const profile = await api(`${GMAIL}/profile`);
    messages = new Map(full ? [] : previous.messages.filter((message) => !message.sendState).map((message) => [message.remoteId, { ...message }]));
    let historyId = full ? null : previous.cursors?.historyId;
    const changed = new Set();
    if (historyId) {
      progress('Checking Gmail changes...');
      try {
        let pageToken = '';
        const seen = new Set();
        do {
          if (seen.has(pageToken)) throw new ProviderError('Gmail repeated a history page. Sync stopped.');
          seen.add(pageToken);
          const page = await api(`${GMAIL}/history?startHistoryId=${encodeURIComponent(historyId)}&maxResults=500${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
          for (const record of page.history || []) {
            for (const message of record.messages || []) changed.add(message.id);
            for (const field of ['messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved']) {
              for (const entry of record[field] || []) changed.add(entry.message.id);
            }
          }
          pageToken = page.nextPageToken || '';
          cursors.historyId = page.historyId;
        } while (pageToken);
      } catch (error) {
        if (error.status !== 404) throw error;
        progress('Gmail history expired. Rebuilding the selected mail range...');
        historyId = null;
        changed.clear();
      }
    }
    if (!historyId) {
      messages = new Map();
      let pageToken = '';
      const seen = new Set();
      const q = `after:${Math.floor(Date.parse(since) / 1000)}`;
      do {
        if (seen.has(pageToken)) throw new ProviderError('Gmail repeated a mail page. Sync stopped.');
        seen.add(pageToken);
        const page = await api(`${GMAIL}/messages?maxResults=100&includeSpamTrash=true&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
        (page.messages || []).forEach((message) => changed.add(message.id));
        pageToken = page.nextPageToken || '';
        progress(`Found ${changed.size} Gmail messages...`);
      } while (pageToken);
      cursors.historyId = profile.historyId;
    }
    let count = 0;
    for (const id of changed) {
      signal?.throwIfAborted();
      let normalized;
      try { normalized = gmailMessage(await api(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`), account, since); }
      catch (error) { if (error.status !== 404) throw error; }
      if (normalized) messages.set(id, normalized); else messages.delete(id);
      progress(`Gmail: read ${++count} of ${changed.size} changed messages`);
    }
    const folderIds = new Set(folders.map((folder) => folder.id));
    for (const message of messages.values()) message.folderIds = message.folderIds.filter((id) => folderIds.has(id));
    let pageToken = '';
    const seen = new Set();
    do {
      if (seen.has(pageToken)) throw new ProviderError('Google repeated a contacts page. Sync stopped.');
      seen.add(pageToken);
      const page = await api(`${PEOPLE}?personFields=names,emailAddresses&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      for (const person of page.connections || []) {
        const contact = importedContact(person.resourceName, person.names?.[0]?.displayName,
          (person.emailAddresses || []).map((entry) => entry.value), account);
        if (contact) contacts.push(contact);
      }
      pageToken = page.nextPageToken || '';
      progress(`Gmail: imported ${contacts.length} contacts`);
    } while (pageToken);
  } else {
    messages = new Map();
    const fields = 'id,parentFolderId,conversationId,subject,body,from,sender,toRecipients,ccRecipients,replyTo,internetMessageHeaders,receivedDateTime,sentDateTime,createdDateTime,lastModifiedDateTime,isRead,isDraft,flag,internetMessageId';
    const headers = { Prefer: 'outlook.body-content-type="html", IdType="ImmutableId"' };
    const folderByRemoteId = new Map(folders.map((folder) => [folder.remoteId, folder]));
    for (const currentFolder of folders) {
      signal?.throwIfAborted();
      const remoteFolder = currentFolder.remoteId;
      const folder = currentFolder.kind;
      const folderUrl = `${GRAPH}/me/mailFolders/${encodeURIComponent(remoteFolder)}/messages`;
      const unfiltered = ['drafts', 'outbox'].includes(folder);
      const initial = `${folderUrl}/delta?$select=${fields}&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}&$top=100`;
      const previousCursor = !full && previous.cursors?.[remoteFolder];
      const fullRefresh = previousCursor === 'full' || unfiltered || currentFolder.search;
      const saved = !fullRefresh && previousCursor;
      let entries = new Map(saved ? previous.messages.filter((message) => !message.sendState && message.folderIds.includes(currentFolder.id))
        .map((message) => {
          const currentKind = folderByRemoteId.get(message.providerParentId)?.kind || folder;
          return [message.remoteId, { ...message,
            folder: message.isDraft && !['spam', 'trash'].includes(currentKind) ? 'drafts' : currentKind,
            folderIds: [currentFolder.id],
          }];
        }) : []);
      let deltaCount = 0;
      const normalize = (item) => graphMessage(item, account,
        folderByRemoteId.get(item.parentFolderId)?.kind || folder, since, remoteFolder);
      const consume = async (url) => pages(api, url, 'value', async (items, page) => {
        deltaCount += items.length;
        for (const item of items) {
          if (item['@removed']) { entries.delete(item.id); continue; }
          let complete = item;
          if (!item.conversationId || !item.from || !item.body || item.isRead === undefined || !item.receivedDateTime) {
            try { complete = await api(`${GRAPH}/me/messages/${encodeURIComponent(item.id)}?$select=${fields}`, headers); }
            catch (error) {
              if (error.status !== 404) throw error;
              entries.delete(item.id);
              continue;
            }
          }
          const message = normalize(complete);
          if (message) entries.set(item.id, message); else entries.delete(item.id);
        }
        if (page['@odata.deltaLink']) cursors[remoteFolder] = page['@odata.deltaLink'];
        if (!page['@odata.deltaLink'] && !page['@odata.nextLink']) {
          throw new ProviderError('Outlook returned no continuation or sync cursor. The previous cache was preserved.');
        }
        progress(`Outlook ${currentFolder.path}: ${entries.size} messages`);
      }, signal, headers);
      const refreshFolder = async () => {
        progress(`Outlook ${currentFolder.path}: refreshing folder contents with full pagination...`);
        entries = new Map();
        const listUrl = unfiltered ? `${folderUrl}?$select=${fields}&$top=100` : initial.replace('/messages/delta?', '/messages?');
        await pages(api, listUrl, 'value', (items) => {
          for (const item of items) {
            const message = normalize(item);
            if (message) entries.set(item.id, message);
          }
          progress(`Outlook ${currentFolder.path}: refreshed ${entries.size} messages`);
        }, signal, headers);
        cursors[remoteFolder] = 'full';
      };
      try {
        if (fullRefresh) await refreshFolder();
        else await consume(saved || initial);
      }
      catch (error) {
        if (saved && [404, 410].includes(error.status)) {
          progress(`Outlook ${currentFolder.path} sync cursor expired. Rebuilding that folder...`);
          entries = new Map();
          deltaCount = 0;
          await consume(initial);
        } else throw error;
      }
      if (!fullRefresh && (entries.size >= 5000 || deltaCount >= 5000)) await refreshFolder();
      for (const [id, message] of entries) {
        const existing = messages.get(id);
        const latest = existing && existing.date > message.date ? existing : message;
        messages.set(id, { ...latest, folderIds: [...new Set([...(existing?.folderIds || []), currentFolder.id])] });
      }
    }
    await pages(api, `${GRAPH}/me/contacts?$select=id,displayName,emailAddresses&$top=100`, 'value', (items) => {
      for (const item of items) {
        const contact = importedContact(item.id, item.displayName, (item.emailAddresses || []).map((entry) => entry.address), account);
        if (contact) contacts.push(contact);
      }
      progress(`Outlook: imported ${contacts.length} contacts`);
    }, signal);
  }
  signal?.throwIfAborted();
  return { account, messages: [...messages.values()], contacts, folders, cursors, days, since,
    lastSync: new Date().toISOString(), version: 1, bodyFormat: BODY_FORMAT, folderFormat: FOLDER_FORMAT };
}

import { isEmail, normalizeEmail } from './mail.js';

export const PROVIDERS = {
  gmail: { name: 'Gmail', color: 'coral', letter: 'G' },
  outlook: { name: 'Outlook', color: 'blue', letter: 'O' },
};
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PEOPLE = 'https://people.googleapis.com/v1/people/me/connections';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const DAY = 86400000;

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

export function createApi(getToken, provider, signal, fetcher = fetch) {
  const origins = provider === 'gmail'
    ? ['https://gmail.googleapis.com', 'https://people.googleapis.com']
    : ['https://graph.microsoft.com'];
  return async (url, headers = {}) => {
    const target = new URL(url);
    if (!origins.includes(target.origin) || target.username || target.password) {
      throw new ProviderError('The provider returned an unsafe pagination URL. Sync stopped.');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
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
      if ([429, 503].includes(response.status) && attempt < 2) {
        const retry = response.headers.get('Retry-After');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000;
        if (seconds > 30) throw new ProviderError(`The provider requested a ${Math.ceil(seconds)} second pause. Try Sync again later.`, response.status);
        await pause(Math.min(30000, Math.max(1000 * 2 ** attempt, Number.isFinite(seconds) ? seconds * 1000 : 0)), signal);
        continue;
      }
      if (!response.ok) {
        const reason = response.status === 401 ? 'Authorization expired. Reconnect this account.'
          : response.status === 403 ? 'Access was denied. Check that mail and contacts permissions are granted and the APIs are enabled.'
            : [429, 503].includes(response.status) ? 'The provider is busy or rate-limiting requests. Try Sync again later.'
              : `The provider returned HTTP ${response.status}. The previous cache has been preserved.`;
        throw new ProviderError(reason, response.status);
      }
      return response.json();
    }
  };
}

export function plainTextFromHtml(html) {
  const template = document.createElement('template');
  // Template contents stay inert: images, scripts, frames, and links are never loaded.
  template.innerHTML = html;
  template.content.querySelectorAll('script,style,iframe,object,embed,svg,math,head,link,meta,form').forEach((node) => node.remove());
  template.content.querySelectorAll('br').forEach((node) => node.replaceWith('\n'));
  template.content.querySelectorAll('p,div,li,tr,h1,h2,h3,blockquote').forEach((node) => node.append('\n'));
  return template.content.textContent.replace(/\n{3,}/g, '\n\n').trim();
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
  if (labels.some((label) => ['TRASH', 'SPAM', 'DRAFT'].includes(label)) || milliseconds < Date.parse(since)) return null;
  if (!raw.id || !raw.threadId || !Number.isFinite(milliseconds)) throw new ProviderError('Gmail returned incomplete message metadata.');
  const senderHeader = header(raw.payload, 'From');
  const sender = addresses(senderHeader)[0];
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
    to, participants: [...new Set([sender, ...toAddresses, ...addresses(header(raw.payload, 'Cc'))])],
    subject: header(raw.payload, 'Subject'), body, date: new Date(milliseconds).toISOString(),
    folder: sent ? 'sent' : labels.includes('INBOX') ? 'inbox' : 'archive',
    unread: labels.includes('UNREAD'), starred: labels.includes('STARRED'),
    internetMessageId: header(raw.payload, 'Message-ID'), inReplyTo: header(raw.payload, 'In-Reply-To'),
  };
}

export function graphMessage(raw, account, folder, since) {
  if (raw.isDraft) return null;
  const date = raw.receivedDateTime || raw.sentDateTime;
  if (Date.parse(date) < Date.parse(since)) return null;
  const sender = raw.from?.emailAddress?.address || raw.sender?.emailAddress?.address;
  if (!raw.id || !raw.conversationId || !isEmail(sender) || !Number.isFinite(Date.parse(date))) {
    throw new ProviderError('Outlook returned incomplete message metadata. Import stopped without replacing the cache.');
  }
  const recipients = (raw.toRecipients || []).map((entry) => entry.emailAddress?.address).filter(isEmail).map(normalizeEmail);
  const to = recipients.find((email) => email !== account.email) || recipients[0] || account.email;
  return {
    id: `${account.id}:${raw.id}`, remoteId: raw.id, remote: true, accountId: account.id, threadId: raw.conversationId,
    sender: normalizeEmail(sender), senderName: raw.from?.emailAddress?.name || sender, to,
    participants: [...new Set([normalizeEmail(sender), ...recipients,
      ...(raw.ccRecipients || []).map((entry) => entry.emailAddress?.address).filter(isEmail).map(normalizeEmail)])],
    subject: raw.subject || '', body: raw.body?.contentType?.toLowerCase() === 'html'
      ? plainTextFromHtml(raw.body.content || '') : raw.body?.content || '[No displayable text body.]',
    date: new Date(date).toISOString(), folder, unread: !raw.isRead, starred: raw.flag?.flagStatus === 'flagged',
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
  let messages;
  let cursors = {};
  const full = !previous || previous.days !== days;
  if (account.provider === 'gmail') {
    const profile = await api(`${GMAIL}/profile`);
    messages = new Map(full ? [] : previous.messages.map((message) => [message.remoteId, message]));
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
      const q = `after:${Math.floor(Date.parse(since) / 1000)} -in:trash -in:spam -in:drafts`;
      do {
        if (seen.has(pageToken)) throw new ProviderError('Gmail repeated a mail page. Sync stopped.');
        seen.add(pageToken);
        const page = await api(`${GMAIL}/messages?maxResults=100&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
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
    const fields = 'id,conversationId,subject,body,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,isDraft,flag,internetMessageId';
    const headers = { Prefer: 'outlook.body-content-type="text", IdType="ImmutableId"' };
    for (const [remoteFolder, folder] of [['inbox', 'inbox'], ['sentitems', 'sent'], ['archive', 'archive']]) {
      const initial = `${GRAPH}/me/mailFolders/${remoteFolder}/messages/delta?$select=${fields}&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}&$top=100`;
      const previousCursor = !full && previous.cursors?.[remoteFolder];
      const fullRefresh = previousCursor === 'full';
      const saved = !fullRefresh && previousCursor;
      let entries = new Map(saved ? previous.messages.filter((message) => message.folder === folder).map((message) => [message.remoteId, message]) : []);
      let deltaCount = 0;
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
          const message = graphMessage(complete, account, folder, since);
          if (message) entries.set(item.id, message); else entries.delete(item.id);
        }
        if (page['@odata.deltaLink']) cursors[remoteFolder] = page['@odata.deltaLink'];
        if (!page['@odata.deltaLink'] && !page['@odata.nextLink']) {
          throw new ProviderError('Outlook returned no continuation or sync cursor. The previous cache was preserved.');
        }
        progress(`Outlook ${remoteFolder}: ${entries.size} messages`);
      }, signal, headers);
      const refreshFolder = async () => {
        progress(`Outlook ${remoteFolder}: using full pagination to avoid the 5,000-message filtered delta limit...`);
        entries = new Map();
        await pages(api, initial.replace('/messages/delta?', '/messages?'), 'value', (items) => {
          for (const item of items) {
            const message = graphMessage(item, account, folder, since);
            if (message) entries.set(item.id, message);
          }
          progress(`Outlook ${remoteFolder}: refreshed ${entries.size} messages`);
        }, signal, headers);
        cursors[remoteFolder] = 'full';
      };
      try {
        if (fullRefresh) await refreshFolder();
        else await consume(saved || initial);
      }
      catch (error) {
        if (saved && [404, 410].includes(error.status)) {
          progress(`Outlook ${remoteFolder} sync cursor expired. Rebuilding that folder...`);
          entries = new Map();
          await consume(initial);
        } else if (remoteFolder === 'archive' && error.status === 404 && !saved) {
          progress('This Outlook mailbox has no Archive folder.');
        } else throw error;
      }
      if (!fullRefresh && (entries.size >= 5000 || deltaCount >= 5000)) await refreshFolder();
      for (const [id, message] of entries) messages.set(id, message);
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
  return { account, messages: [...messages.values()], contacts, cursors, days, since, lastSync: new Date().toISOString(), version: 1 };
}

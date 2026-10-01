import { isEmail, isOutgoing, normalizeEmail } from './mail.js';

export class SendError extends Error {
  constructor(message, uncertain = false) {
    super(message);
    this.name = 'SendError';
    this.uncertain = uncertain;
  }
}

export function parseRecipients(value) {
  const addresses = (Array.isArray(value) ? value : String(value).split(',')).map((address) => address.trim());
  if (!addresses.length || addresses.some((address) => address.length > 254 || !isEmail(address) || /[\r\n<>,;"]/.test(address) || !/^[\x21-\x7e]+$/.test(address))) {
    throw new Error('Enter complete email addresses separated by commas, without display names.');
  }
  if (addresses.length > 50) throw new Error('Send to no more than 50 recipients at once.');
  return [...new Set(addresses.map(normalizeEmail))];
}

export function replyTarget(messages, ownAddress) {
  if (!isEmail(ownAddress)) return null;
  const own = normalizeEmail(ownAddress);
  const confirmed = messages.filter((message) => !message.isDraft && message.folder !== 'outbox' && !message.sendState
    && Array.isArray(message.replyTo) && Array.isArray(message.toRecipients));
  const parent = [...confirmed].reverse().find((message) => !isOutgoing(message)) || confirmed.at(-1);
  if (!parent) return null;
  const originalTo = parent.toRecipients.length ? parent.toRecipients : [parent.to];
  const primary = isOutgoing(parent) ? originalTo
    : [...(parent.replyTo.length ? parent.replyTo : [parent.sender]), ...originalTo];
  // Older caches saved To and all visible participants, but not a separate Cc array.
  const originalCc = parent.ccRecipients ?? (parent.participants || []).filter((address) =>
    normalizeEmail(address) !== normalizeEmail(parent.sender)
    && !originalTo.some((to) => normalizeEmail(to) === normalizeEmail(address)));
  const withoutSelf = (addresses) => [...new Set(addresses.map(normalizeEmail))].filter((address) => address !== own);
  const toRecipients = withoutSelf(primary);
  const ccRecipients = withoutSelf(originalCc).filter((address) => !toRecipients.includes(address));
  if (!toRecipients.length && ccRecipients.length) toRecipients.push(ccRecipients.shift());
  if (!toRecipients.length) return null;
  const recipients = parseRecipients([...toRecipients, ...ccRecipients]);
  return { parent, recipients, toRecipients, ccRecipients };
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

function encodedSubject(value) {
  // Encoded words are bounded to fit RFC 2047, including multibyte Unicode.
  const chunks = [];
  let chunk = '';
  for (const character of value) {
    if (new TextEncoder().encode(chunk + character).length > 42) { chunks.push(chunk); chunk = ''; }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part) => `=?UTF-8?B?${base64Utf8(part)}?=`).join('\r\n ');
}

export function prepareOutgoing(snapshot, { to, cc = [], subject, body, parent = null }) {
  const { account } = snapshot;
  parseRecipients([account.email]);
  const recipients = parseRecipients(to);
  const ccRecipients = Array.isArray(cc) && !cc.length ? [] : parseRecipients(cc).filter((address) => !recipients.includes(address));
  const allRecipients = parseRecipients([...recipients, ...ccRecipients]);
  if (!subject?.trim() || /[\r\n\u0000]/.test(subject) || subject.length > 998) throw new Error('Enter a subject without line breaks (up to 998 characters).');
  if (typeof body !== 'string' || !body.trim()) throw new Error('Write a message before sending.');
  if (new TextEncoder().encode(body).length > 1024 * 1024) throw new Error('This version supports plain-text messages up to 1 MB.');
  if (parent && (parent.accountId !== account.id || !parent.remote || parent.sendState || parent.isDraft)) throw new Error('Sync this conversation before replying.');
  if (parent && account.provider === 'gmail' && (!/^<[^<>\s]+>$/.test(parent.internetMessageId || '')
    || /[\u0000-\u0020\u007f]/.test(parent.internetMessageId))) {
    throw new Error('This message has no valid reply header. Sync the account, or compose a new message instead.');
  }
  const normalizedBody = body.trim().replace(/\r\n?/g, '\n');
  const duplicate = snapshot.messages.find((message) => ['sending', 'unknown'].includes(message.sendState)
    && message.subject === subject.trim() && message.body === normalizedBody
    && JSON.stringify([...(message.toRecipients || []), ...(message.ccRecipients || [])].sort()) === JSON.stringify([...allRecipients].sort()));
  if (duplicate) throw new Error('An identical send has an unknown outcome. Check Sent at the provider and sync before sending it again; it may already have been sent.');
  const clientSendId = crypto.randomUUID();
  return {
    id: `local-send:${clientSendId}`, remoteId: `local-send:${clientSendId}`, remote: true,
    clientSendId, sendState: 'sending', accountId: account.id,
    threadId: parent?.threadId || `local-thread:${clientSendId}`,
    sender: account.email, senderName: account.email, to: recipients[0], toRecipients: recipients, ccRecipients, replyTo: [],
    participants: [...new Set([account.email, ...allRecipients])], outgoing: true, isDraft: false, recipientMissing: false,
    subject: subject.trim(), body: normalizedBody, date: new Date().toISOString(),
    folder: 'outbox', folderIds: (snapshot.folders || []).filter((folder) => folder.kind === 'outbox').map((folder) => folder.id),
    unread: false, starred: false, internetMessageId: `<${clientSendId}@gather.invalid>`,
    inReplyTo: parent?.internetMessageId || '', replyToRemoteId: parent?.remoteId || '',
  };
}

export function gmailSendPayload(message, parent) {
  const headers = [
    `From: ${message.sender}`, `To: ${message.toRecipients.join(',\r\n ')}`,
    `Subject: ${encodedSubject(message.subject)}`, `Date: ${new Date(message.date).toUTCString()}`,
    `Message-ID: ${message.internetMessageId}`, `X-Gather-Send-ID: ${message.clientSendId}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
  ];
  if (message.ccRecipients?.length) headers.push(`Cc: ${message.ccRecipients.join(',\r\n ')}`);
  if (parent) {
    headers.push(`In-Reply-To: ${parent.internetMessageId}`);
    const references = [...new Set([...((parent.references || '').match(/<[^<>\s\u0000-\u001f\u007f]+>/g) || []), parent.internetMessageId])];
    headers.push(`References: ${references.slice(-20).join('\r\n ')}`);
  }
  const body = base64Utf8(message.body.replace(/\n/g, '\r\n')).match(/.{1,76}/g).join('\r\n');
  return {
    raw: base64Utf8(`${headers.join('\r\n')}\r\n\r\n${body}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    ...(parent ? { threadId: parent.threadId } : {}),
  };
}

export async function submitOutgoing(account, message, parent, getToken, fetcher = fetch) {
  const token = await getToken();
  const google = account.provider === 'gmail';
  const url = google ? 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
    : parent ? `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(parent.remoteId)}/replyAll`
      : 'https://graph.microsoft.com/v1.0/me/sendMail';
  const graphMessage = {
    subject: message.subject, body: { contentType: 'Text', content: message.body },
    toRecipients: message.toRecipients.map((address) => ({ emailAddress: { address } })),
    ccRecipients: (message.ccRecipients || []).map((address) => ({ emailAddress: { address } })), bccRecipients: [],
    internetMessageHeaders: [{ name: 'x-gather-send-id', value: message.clientSendId }],
  };
  const payload = google ? gmailSendPayload(message, parent)
    : { message: graphMessage, ...(!parent ? { saveToSentItems: true } : {}) };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    let response;
    try {
      response = await fetcher(url, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(google ? {} : { Prefer: 'IdType="ImmutableId"' }) },
        body: JSON.stringify(payload), credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      });
    } catch {
      throw new SendError('The connection ended before the send result was confirmed. Check Sent at the provider before trying again; this message may already have been sent.', true);
    }
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408) throw new SendError(`The provider returned HTTP ${response.status}; the send outcome is uncertain. Check Sent and sync before retrying.`, true);
      const reason = response.status === 401 ? 'Reconnect this account and grant sending permission.'
        : response.status === 403 ? 'Check sending permission, account policy, and provider send quotas. Reconnect if sending permission has not been granted.'
        : response.status === 429 ? 'The provider is rate-limiting sending. Wait before trying again.'
          : response.status === 404 ? 'The original message is no longer available. Sync before replying.'
            : 'Check the recipients and message, then try again.';
      throw new SendError(`Send was rejected (HTTP ${response.status}). ${reason}`);
    }
    if (google) {
      let result;
      try { result = await response.json(); } catch { throw new SendError('Gmail accepted the request but its result could not be read. Check Sent and sync before retrying.', true); }
      if (typeof result.id !== 'string' || typeof result.threadId !== 'string') throw new SendError('Gmail returned an incomplete send result. Check Sent and sync before retrying.', true);
      return { remoteId: result.id, threadId: result.threadId };
    }
    return { remoteId: message.remoteId, threadId: message.threadId };
  } finally { clearTimeout(timeout); }
}

export function acceptedOutgoing(snapshot, message, result) {
  return { ...message, ...result, sendState: 'accepted', folder: 'sent',
    folderIds: (snapshot.folders || []).filter((folder) => folder.kind === 'sent'
      || folder.remoteId === 'SENT' && snapshot.account.provider === 'gmail').map((folder) => folder.id),
  };
}

export function mergeLocalSends(imported, previous) {
  const locals = (previous?.messages || []).filter((message) => message.sendState);
  const remote = imported.messages.filter((message) => !message.sendState);
  for (const local of locals) {
    const match = remote.find((message) => isOutgoing(message) && !message.isDraft && (message.remoteId === local.remoteId
      || message.clientSendId === local.clientSendId
      || message.internetMessageId && message.internetMessageId === local.internetMessageId));
    if (match) {
      match.clientSendId = local.clientSendId;
    } else {
      const validIds = new Set(imported.folders.map((folder) => folder.id));
      imported.messages.push({ ...local, folderIds: local.folderIds.filter((id) => validIds.has(id)) });
    }
  }
  return imported;
}

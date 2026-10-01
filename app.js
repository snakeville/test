import { ACCOUNTS as DEMO_ACCOUNTS, createDemo, findContact, visibleConversations, conversationMessages, conversationKey, conversationAddress, isOutgoing, topicSubject, replyToConversation, groupMessages, addContact, updateContact, syncDemo, isValidState, isEmail } from './mail.js';
import { createAccountsPanel } from './accounts-panel.js';
import { mountHtmlMessages } from './email-html.js';
import { inlineImageReferences, loadInlineImages } from './email-images.js';
import { getAccountApi, canSend } from './auth.js';
import { parseRecipients, replyTarget } from './email-send.js';
import { messagePlainText, messagePreview } from './email-text.js';
import { messageQuoteContent } from './email-quotes.js';

const STORAGE_KEY = 'gather-demo-v1';
const app = document.querySelector('#app');
const composeDialog = document.querySelector('#compose-dialog');
const contactDialog = document.querySelector('#contact-dialog');
const contactForm = document.querySelector('#contact-form');
const emailRows = document.querySelector('#contact-email-rows');
let editingContactId = null;
let senderToAdd = null;
let state = createDemo();
let storageError = '';
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved !== null) {
    const parsed = JSON.parse(saved);
    if (!isValidState(parsed)) throw new Error('Saved data has an unsupported or damaged format.');
    state = parsed;
  }
} catch (error) {
  storageError = `Unable to load saved data. Sample data is shown instead. ${error.message} Changes will not be saved until you use Reset demo.`;
}

let folder = 'inbox';
let account = 'all';
let query = '';
let unreadOnly = false;
let selected = 'm1';
let syncing = false;
const collapsed = new Set();
const replyDrafts = new Map();
const htmlConversations = new Set();
const expandedQuotes = new Set();
const imagePermissions = new Map();
let disposeHtmlMessages = () => {};
let noticeTimer;
let realMode = false;
let accounts = DEMO_ACCOUNTS;
let demoState = state;
let realState = { version: 1, accounts: [], contacts: [], messages: [], folders: [], lastSync: null };
let providerFoldersOpen = true;
const expandedFolderAccounts = new Set();
const expandedFolderBranches = new Set();
let realStatus = '';
let realError = false;
let realBusy = false;
let sending = false;
const replyErrors = new Map();
const connections = createAccountsPanel({
  onChange: (updated) => {
    const previousSelection = state.messages.find((message) => message.id === selected);
    if (realMode && previousSelection?.clientSendId) {
      const replacement = updated.messages.find((message) => message.clientSendId === previousSelection.clientSendId);
      if (replacement && htmlConversations.has(conversationKey(previousSelection))) {
        htmlConversations.add(conversationKey(replacement));
      }
      selected = replacement?.id || selected;
    }
    for (const id of expandedFolderAccounts) {
      if (!updated.accounts.some((entry) => entry.id === id)) expandedFolderAccounts.delete(id);
    }
    for (const id of expandedFolderBranches) {
      if (!updated.folders.some((entry) => entry.id === id)) expandedFolderBranches.delete(id);
    }
    for (const [id, permission] of imagePermissions) {
      if (permission.remote && !updated.messages.some((message) => message.id === id && message.bodyHtml === permission.bodyHtml)) {
        permission.controller.abort();
        imagePermissions.delete(id);
      }
    }
    realState = updated;
    if (realMode) { state = updated; accounts = updated.accounts; render(); }
  },
  onStatus: (message, error, busy) => {
    realStatus = message; realError = error; realBusy = busy;
    if (realMode) render();
  },
});

const escape = (value = '') => String(value).replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const icons = {
  inbox: '<path d="M4 4h16l2 11v5H2v-5L4 4Z"/><path d="M2 15h6l2 3h4l2-3h6"/>',
  unknown: '<path d="M3 7h7l2 2h9v11H3Z"/><path d="M3 7V4h7l2 3"/><path d="M12 12v3m0 2v.1"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
  sent: '<path d="m21 3-7 18-4-7-7-4 18-7Z"/><path d="m10 14 6-6"/>',
  archive: '<path d="M4 8v13h16V8M3 3h18v5H3Z"/><path d="M9 12h6"/>',
  people: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m2-18a3 3 0 0 1 0 6m2 5a6 6 0 0 1 3 4v3"/>',
  search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/>',
  sync: '<path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6m-4 9a9 9 0 0 0 15 2l3-3m0 6v-6h-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  reply: '<path d="m9 4-6 6 6 6M3 10h11a7 7 0 0 1 7 7v3"/>',
  leaf: '<path d="M20 3C8 2 3 7 4 14c1 7 13 9 16-11Z"/><path d="M3 22 15 9"/>',
};
const icon = (name, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.mail}</svg>`;
const initials = (name) => name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
const avatar = (name, color = 'sage', size = '') => `<span class="avatar ${color} ${size}" aria-hidden="true">${escape(initials(name))}</span>`;
const provider = (id) => {
  const item = accounts.find((entry) => entry.id === id);
  return `<span class="provider ${item.color}" title="${item.name}" aria-label="${item.name}">${item.letter}</span>`;
};
const time = (date) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(date));
const dateLabel = (date) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(date));
const labels = { inbox: 'Inbox', unknown: 'Unknown senders', starred: 'Starred', sent: 'Sent', archive: 'Archive', contacts: 'Contacts', outbox: 'Outbox' };

function notify(message) {
  const notice = document.querySelector('#notice');
  notice.textContent = message;
  notice.classList.add('visible');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.remove('visible'), 4500);
}

function blockConversationImages(messages) {
  for (const message of messages) {
    imagePermissions.get(message.id)?.controller.abort();
    imagePermissions.delete(message.id);
  }
}

function confirmImages(scope) {
  return confirm(`Load images for ${scope}?\n\nRemote image hosts may learn your IP address and that you opened this email. Your browser may also send their cookies. Embedded images may be fetched from your email provider.\n\nThis choice lasts only in this tab and is not saved.`);
}

async function enableImages(messages) {
  const pending = [];
  for (const message of messages) {
    if (!message.bodyHtml || imagePermissions.has(message.id)) continue;
    const references = inlineImageReferences(message.bodyHtml);
    const permission = {
      bodyHtml: message.bodyHtml, remote: Boolean(message.remote), images: new Map(),
      controller: new AbortController(), status: references.size ? 'Loading embedded images...' : '', error: false,
    };
    imagePermissions.set(message.id, permission);
    if (references.size) pending.push({ message, permission, references, from: accounts.find((entry) => entry.id === message.accountId) });
  }
  render();
  for (const { message, permission, references, from } of pending) {
    if (imagePermissions.get(message.id) !== permission || permission.controller.signal.aborted) continue;
    try {
      if (!message.remote) throw new Error('Embedded attachment images are not available in demo data.');
      permission.images = await loadInlineImages(message, from, getAccountApi(from, permission.controller.signal), permission.controller.signal);
      const missing = references.size - permission.images.size;
      permission.status = missing ? `${missing} embedded image(s) unavailable, unsupported, or larger than 10 MB. Open the message at your provider to view them.` : '';
      permission.error = missing > 0;
    } catch (error) {
      if (!permission.controller.signal.aborted) {
        permission.status = `Embedded images could not load: ${error.message}`;
        permission.error = true;
      }
    }
    if (imagePermissions.get(message.id) === permission) render();
  }
}

function persist() {
  if (realMode) throw new Error('Real mailbox changes must use the IndexedDB import transaction.');
  if (storageError) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    storageError = `Your changes are only in memory and will be lost on reload. Browser storage failed: ${error.message}`;
  }
}

function count(view) {
  return visibleConversations(state, { folder: view, account }).length;
}

function navItem(id, glyph, nested = false) {
  const amount = id === 'contacts' ? state.contacts.length : count(id);
  return `<button class="nav-item ${folder === id ? 'active' : ''} ${nested ? 'nested' : ''}" data-folder="${id}" ${folder === id ? 'aria-current="page"' : ''}>
    ${icon(glyph)}<span>${labels[id]}</span>${amount ? `<span class="nav-count">${amount}</span>` : ''}
  </button>`;
}

function currentFolder() {
  return state.folders?.find((entry) => entry.id === folder);
}

function folderLabel() {
  return currentFolder()?.path || labels[folder] || 'Folder';
}

function providerFolders() {
  if (!realMode) return '';
  const folders = state.folders || [];
  const counts = new Map();
  for (const message of state.messages) {
    for (const id of message.folderIds || []) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const visibleAccounts = accounts.filter((entry) => account === 'all' || entry.id === account);
  const byId = new Map(folders.map((entry) => [entry.id, entry]));
  const children = new Map();
  const childIds = new Map(folders.map((entry, index) => [entry.id, `provider-folder-children-${index}`]));
  for (const item of folders) {
    const parent = byId.get(item.parentId)?.accountId === item.accountId ? item.parentId : item.accountId;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(item);
  }
  for (const items of children.values()) items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  function folderTree(parent, level = 0) {
    return (children.get(parent) || []).map((item) => {
      const nested = children.has(item.id);
      const expanded = expandedFolderBranches.has(item.id);
      return `<div class="provider-folder-node">
        <div class="provider-folder-row" style="--folder-depth:${Math.min(level, 5)}">
          ${nested ? `<button class="folder-tree-toggle" data-toggle-provider-folder="${escape(item.id)}"
            aria-expanded="${expanded}" aria-controls="${childIds.get(item.id)}" aria-label="${expanded ? 'Collapse' : 'Expand'} ${escape(item.name)}">${icon('arrow', expanded ? 'expanded' : '')}</button>` : '<span class="folder-tree-spacer" aria-hidden="true"></span>'}
          <button class="provider-folder-item ${folder === item.id ? 'active' : ''}" data-provider-folder="${escape(item.id)}"
            ${folder === item.id ? 'aria-current="page"' : ''} title="${escape(item.path)}${item.hidden ? ' (hidden provider folder)' : ''}">
            ${icon('unknown')}<span>${escape(item.name)}${item.hidden ? '<small>Hidden</small>' : ''}${item.search ? '<small>Search folder</small>' : ''}</span>
            <span class="provider-folder-count" aria-label="${counts.get(item.id) || 0} cached messages">${counts.get(item.id) || 0}</span>
          </button>
        </div>
        ${nested ? `<div id="${childIds.get(item.id)}" class="provider-folder-children" ${expanded ? '' : 'hidden'}>${folderTree(item.id, level + 1)}</div>` : ''}
      </div>`;
    }).join('');
  }
  return `<details class="provider-folders" ${providerFoldersOpen ? 'open' : ''}><summary>Provider folders &amp; labels</summary>
    <p class="folder-scope-note">Counts are cached messages in your imported date range. Sync mail refreshes all folders for the selected account(s).</p>
    ${visibleAccounts.map((entry, index) => {
      const expanded = expandedFolderAccounts.has(entry.id);
      return `<section class="provider-folder-account" aria-label="${escape(entry.email)} folders">
        <button class="provider-account-toggle" data-toggle-folder-account="${escape(entry.id)}"
          aria-expanded="${expanded}" aria-controls="provider-account-folders-${index}" aria-label="${expanded ? 'Collapse' : 'Expand'} folders for ${escape(entry.email)}">
          ${icon('arrow', expanded ? 'expanded' : '')}${provider(entry.id)}<span>${escape(entry.email)}</span>
        </button>
        <div id="provider-account-folders-${index}" class="provider-folder-list" ${expanded ? '' : 'hidden'}>
          ${children.has(entry.id) ? folderTree(entry.id) : '<p class="folder-scope-note">Sync this account to discover all folders and labels.</p>'}
        </div>
      </section>`;
    }).join('') || '<p class="folder-scope-note">Connect an account to see its folders.</p>'}
  </details>`;
}

function sidebar() {
  return `<aside class="sidebar">
    <a class="brand" href="./" aria-label="Gather home"><span class="brand-symbol">${icon('leaf')}</span>gather<span class="brand-dot">.</span></a>
    <button class="compose-button" data-action="compose">${icon('plus')} New message <span class="compose-hint">↗</span></button>
    ${realMode ? '<button class="text-button connect-entry" data-action="connections">Manage accounts</button>' : ''}
    <div class="mode-switch" aria-label="Mailbox mode"><button data-action="demo-mode" aria-pressed="${!realMode}">Demo</button><button data-action="real-mode" aria-pressed="${realMode}">Real mail</button></div>
    ${!realMode ? '<button class="text-button connect-entry" data-action="connections">Connect Gmail or Outlook</button>' : ''}
    <div class="section-label">YOUR SPACE</div>
    <nav aria-label="Mail folders">
      ${navItem('inbox', 'inbox')}
      ${navItem('unknown', 'unknown', true)}
      ${navItem('starred', 'star')}
      ${navItem('sent', 'sent')}
      ${realMode ? navItem('outbox', 'sent') : ''}
      ${navItem('archive', 'archive')}
    </nav>
    ${providerFolders()}
    <nav class="contacts-nav" aria-label="Contacts">
      <div class="nav-divider"></div>
      ${navItem('contacts', 'people')}
    </nav>
    <div class="accounts-section">
      <div class="section-label">${realMode ? 'REAL ACCOUNTS' : 'DEMO ACCOUNTS'} <span>${accounts.length}</span></div>
      <button class="account-item ${account === 'all' ? 'chosen' : ''}" data-account="all" aria-pressed="${account === 'all'}"><span class="all-accounts">${icon('inbox')}</span><span>All accounts<small>A little more connected</small></span>${account === 'all' ? '<span class="account-dot"></span>' : ''}</button>
      ${accounts.map((item) => `<button class="account-item ${account === item.id ? 'chosen' : ''}" data-account="${escape(item.id)}" aria-pressed="${account === item.id}">${provider(item.id)}<span>${item.name}<small>${escape(item.email)}</small></span>${account === item.id ? '<span class="account-dot"></span>' : ''}</button>`).join('')}
    </div>
    <div class="sidebar-bottom"><div class="quiet-note">${icon('leaf')} Less noise.<br><span>More connection.</span></div>
      <button class="profile" data-action="about">${avatar(realMode ? 'Real Mail' : 'Alex Morgan', 'sand')}<span>${realMode ? 'Your local mailbox' : 'Alex Morgan'}<small>${realMode ? 'Connected mail · This device' : 'Your personal space'}</small></span><span class="profile-more">···</span></button>
    </div>
  </aside>`;
}

function messageList(messages) {
  const groups = groupMessages(messages, state.contacts);
  if (realMode && !accounts.length) {
    return `<section class="message-list" aria-label="Connect real email"><div class="empty-state">${icon('mail')}<h3>Your mailbox starts here.</h3><p>Connect Gmail or Outlook to import your email and contacts. Demo messages never appear in this space.</p><button class="primary" data-action="connections">Connect an account</button></div></section>`;
  }
  const selectedMessage = state.messages.find((message) => message.id === selected);
  const selectedKey = selectedMessage ? conversationKey(selectedMessage) : null;
  return `<section class="message-list" aria-label="${escape(folderLabel())} conversations">
    <div class="list-toolbar"><span>${messages.length} conversation${messages.length === 1 ? '' : 's'} <span class="subtle">/ ${groups.length} people</span></span>
      <button class="filter-button ${unreadOnly ? 'enabled' : ''}" data-action="unread-filter" aria-pressed="${unreadOnly}"><span class="tiny-dot"></span> Unread</button>
    </div>
    ${currentFolder() ? `<div class="folder-note"><strong>${escape(folderLabel())}</strong><br>Read-only provider folder. Showing cached mail in your imported date range.</div>` : ''}
    ${folder === 'unknown' ? `<div class="folder-note">${realMode ? 'These senders are not in the imported contacts. Add them in Google Contacts or Outlook People, then sync again.' : 'A quieter inbox starts here. Add someone to contacts to bring their messages into your inbox.'}</div>` : ''}
    <div class="group-list">${groups.length ? groups.map((group) => `<section class="contact-group">
      <button class="group-heading" data-group="${escape(group.key)}" aria-expanded="${!collapsed.has(group.key)}">
        ${avatar(group.name, group.contact?.color || 'sand')}
        <span class="group-name">${escape(group.name)}<small>${group.messages.length} topic${group.messages.length === 1 ? '' : 's'}${group.messages.some((message) => message.unread) ? ' <span class="unread-label"> · new</span>' : ''}</small></span>
        ${icon('arrow', collapsed.has(group.key) ? '' : 'expanded')}
      </button>
      ${collapsed.has(group.key) ? '' : `<div class="group-messages">${group.messages.map((message) => `<button class="message-card ${selectedKey === message.key ? 'selected' : ''} ${message.unread ? 'unread' : ''}" data-message="${escape(message.id)}" aria-pressed="${selectedKey === message.key}">
        <span class="message-topline">${provider(message.accountId)}<span>${dateLabel(message.date)} <span class="message-time">· ${time(message.date)}</span></span>${message.starred ? icon('star', 'filled-star') : ''}${message.unread ? '<span class="unread-dot" aria-label="Unread"></span>' : ''}</span>
        <span class="message-subject">${escape(message.subject)} <span class="thread-count" aria-label="${message.messages.length} messages">${message.messages.length}</span></span>
        <span class="message-preview">${message.latest.isDraft ? 'Draft: ' : isOutgoing(message.latest) ? 'You: ' : ''}${escape(messagePreview(message.latest))}</span>
      </button>`).join('')}</div>`}
    </section>`).join('') : `<div class="empty-state">${icon(query ? 'search' : 'leaf')}<h3>${query ? 'No matching messages' : 'A lovely bit of quiet.'}</h3><p>${query || unreadOnly ? 'Try another search or turn off the unread filter.' : folder === 'sent' ? realMode ? 'Imported sent conversations will appear here.' : 'Your demo conversations will appear here.' : 'There are no messages in this view.'}</p></div>`}</div>
    <div class="list-footer">${icon('check')} A place for people, not noise.</div>
  </section>`;
}

function chatMessage(message) {
  const sent = isOutgoing(message);
  const delivery = message.sendState === 'accepted' ? 'Accepted by provider · Sent copy pending sync'
    : message.sendState === 'sending' ? sending ? 'Sending...' : 'Send status unconfirmed · Check provider Sent'
      : message.sendState === 'unknown' ? 'Send status unknown · Check provider Sent before retrying'
        : message.sendState === 'failed' ? 'Send rejected · Not sent'
          : message.isDraft ? 'Draft · Not sent' : message.folder === 'outbox' ? 'Outbox · Pending at provider'
    : sent ? realMode ? 'Sent · Imported from provider' : 'Saved locally · Not delivered'
      : message.folder === 'archive' ? 'Received · Archived' : 'Received';
  const locationNote = realMode && ['trash', 'spam'].includes(message.folder) ? ` · ${message.folder === 'trash' ? 'Deleted / Trash' : 'Junk / Spam'}` : '';
  const contact = findContact(state.contacts, message.sender);
  const formatted = Boolean(message.bodyHtml) && htmlConversations.has(conversationKey(message));
  const quoteContent = messageQuoteContent(message);
  const showQuotes = expandedQuotes.has(message.id);
  const text = messagePlainText(message, { hideQuotes: !showQuotes });
  const images = imagePermissions.get(message.id);
  const containsImages = /<img\b/i.test(message.bodyHtml || '');
  return `<li class="chat-message ${sent ? 'outgoing' : 'incoming'} ${formatted ? 'has-html' : ''}" data-chat-message="${escape(message.id)}">
    <div class="chat-meta"><strong>${sent ? 'You' : escape(contact?.name || message.senderName)}</strong><time datetime="${message.date}" title="${escape(new Date(message.date).toLocaleString())}">${time(message.date)}</time></div>
    ${formatted && containsImages ? `<div class="html-controls"><span>${images ? 'Images enabled for this message' : 'Images blocked'}</span><button class="text-button" data-action="${images ? 'hide-images' : 'load-images'}" data-item="${escape(message.id)}">${images ? 'Hide images' : 'Load images'}</button></div>` : ''}
    ${formatted && images?.status ? `<p class="image-status ${images.error ? 'form-error' : ''}" role="${images.error ? 'alert' : 'status'}">${escape(images.status)}</p>` : ''}
    <div class="chat-bubble">${formatted ? `<iframe class="html-message" data-html-message="${escape(message.id)}" title="Formatted email from ${escape(message.senderName)}" sandbox="allow-same-origin" referrerpolicy="no-referrer"></iframe><div class="html-fallback" hidden><p role="status"></p><div class="message-body">${escape(text || (quoteContent.hasQuotes ? 'Quoted previous messages hidden.' : ''))}</div></div>` : `<div class="message-body">${escape(text || (quoteContent.hasQuotes ? 'Quoted previous messages hidden.' : ''))}</div>`}</div>
    ${quoteContent.hasQuotes ? `<button class="text-button quote-toggle" data-action="toggle-quotes" data-item="${escape(message.id)}" aria-expanded="${showQuotes}">${showQuotes ? 'Hide quoted text' : 'Show quoted text'}</button>` : ''}
    <div class="chat-message-footer"><span>${delivery}${locationNote}${message.unread ? ' · Unread' : ''}</span>
      ${realMode ? '' : `<div class="reader-actions">
        ${!sent ? `<button class="icon-button" data-action="archive" data-item="${escape(message.id)}" aria-label="${message.folder === 'archive' ? 'Move message to inbox' : 'Archive message'}" title="${message.folder === 'archive' ? 'Move to inbox' : 'Archive message'}">${icon(message.folder === 'archive' ? 'inbox' : 'archive')}</button>
        <button class="icon-button" data-action="read" data-item="${escape(message.id)}" aria-label="Mark message as ${message.unread ? 'read' : 'unread'}" title="Mark as ${message.unread ? 'read' : 'unread'}">${icon('mail')}</button>` : ''}
        <button class="icon-button ${message.starred ? 'is-starred' : ''}" data-action="star" data-item="${escape(message.id)}" aria-label="${message.starred ? 'Unstar message' : 'Star message'}" aria-pressed="${message.starred}" title="${message.starred ? 'Unstar message' : 'Star message'}">${icon('star')}</button>
      </div>`}
    </div>
    ${message.sendError ? `<p class="form-error">${escape(message.sendError)}</p>` : ''}
    ${realMode && !sending && ['sending', 'unknown', 'failed'].includes(message.sendState)
      ? `<button class="text-button" data-action="remove-send-attempt" data-item="${escape(message.id)}" ${realBusy ? 'disabled' : ''}>Remove local attempt</button>` : ''}
  </li>`;
}

function reader() {
  const messages = conversationMessages(state, selected);
  if (!messages.length) return `<section class="reader empty-reader"><div class="empty-state"><div class="empty-illustration">${icon('leaf')}</div><h2>A little space to connect.</h2><p>Choose a topic and settle into the conversation.</p><span class="eyebrow">LESS SCROLLING. MORE MEANING.</span></div></section>`;
  const first = messages[0];
  const address = conversationAddress(first);
  const contact = findContact(state.contacts, address);
  const received = messages.find((message) => !isOutgoing(message));
  const name = first.recipientMissing ? 'Draft without recipient' : contact?.name || received?.senderName || address;
  const from = accounts.find((entry) => entry.id === first.accountId);
  const participants = realMode ? [...new Set(messages.flatMap((message) => message.participants || []))].filter((email) => email !== from.email) : [];
  const key = conversationKey(first);
  const target = realMode ? replyTarget(messages, from.email) : null;
  const replyDisabled = realMode && (!target || !canSend(from.id) || realBusy || sending);
  const draftOnly = realMode && first.isDraft;
  let previousDay = '';
  const bubbles = messages.map((message) => {
    const day = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(message.date));
    const divider = day !== previousDay ? `<li class="chat-day"><span>${escape(day)}</span></li>` : '';
    previousDay = day;
    return divider + chatMessage(message);
  }).join('');
  return `<article class="reader open chat-reader" aria-label="Conversation with ${escape(name)}">
    <div class="reader-toolbar">
      <button class="icon-button mobile-back" data-action="back" aria-label="Back to message list">${icon('back')}</button>
      <span class="reader-context">${icon('people')} ${contact ? 'One of your people' : 'A new connection'}</span>
      <span class="chat-total">${messages.length} message${messages.length === 1 ? '' : 's'} · ${realMode ? 'Imported history' : 'Full conversation'}</span>
    </div>
    <header class="chat-heading">
      <div class="chat-person">
        ${avatar(name, contact?.color || 'sand', 'large')}<div><strong>${escape(name)}</strong><span class="sender-address">${escape(address)}</span></div>${provider(from.id)}
        <div class="conversation-format" role="group" aria-label="Conversation display format">
          <button data-action="conversation-format" data-format="html" aria-pressed="${htmlConversations.has(key)}">HTML</button>
          <button data-action="conversation-format" data-format="plain" aria-pressed="${!htmlConversations.has(key)}">Plain text</button>
        </div>
      </div>
      <h2 class="subject-heading" title="${escape(topicSubject(first.subject) || '(No subject)')}">${escape(topicSubject(first.subject) || '(No subject)')}</h2>
      ${participants.length > 1 ? `<p class="chat-addresses">Participants: ${participants.map(escape).join(', ')}</p>` : ''}
      ${!contact && received && !realMode ? `<div class="unknown-callout"><span>This sender isn't in your contacts yet.</span><button data-action="add-sender">${icon('plus')} Add contact</button></div>` : ''}
    </header>
    <div class="chat-timeline" tabindex="0" aria-label="Conversation history, oldest first">
      <ol class="chat-messages">${bubbles}</ol>
    </div>
    ${draftOnly ? '<div class="read-only-note">Provider drafts are read-only. Compose a new message to send from Gather.</div>' : `<form id="chat-reply-form" class="chat-reply-form">
      <label for="chat-reply">${realMode ? 'Reply to all' : 'Reply to'} ${escape(realMode && target ? target.toRecipients.join(', ') : name)}${realMode && target?.ccRecipients.length ? `<br>Cc: ${escape(target.ccRecipients.join(', '))}` : ''}</label>
      <textarea id="chat-reply" name="body" rows="2" placeholder="Keep the conversation going..." aria-describedby="chat-send-note" required>${escape(replyDrafts.get(key) || '')}</textarea>
      <p class="form-error" role="alert">${escape(replyErrors.get(key) || '')}</p>
      <div class="chat-reply-bottom"><span id="chat-send-note">From ${escape(from.email)}<br>${realMode ? !target ? 'Sync to retrieve reply recipients. Replies need someone other than your sending address.' : !canSend(from.id) ? 'Reconnect in Accounts to enable sending.' : 'Real email · Reply all to the To/Cc addresses shown.' : 'Demo only · No email is delivered'}</span><button class="primary" type="submit" ${replyDisabled ? 'disabled' : ''}>${icon('sent')} ${realMode ? sending ? 'Sending...' : 'Send reply' : 'Save reply'}</button></div>
    </form>`}
  </article>`;
}

function contactsPage() {
  const search = query.trim().toLowerCase();
  const contacts = state.contacts.filter((contact) =>
    (!search || [contact.name, ...contact.emails].some((text) => text.toLowerCase().includes(search)))
    && (account === 'all' || (realMode ? contact.accountIds.includes(account) : contact.source === account || contact.source === 'local')));
  return `<section class="contacts-page"><div class="contacts-toolbar"><p>${contacts.length} familiar faces <span class="subtle">· ${realMode ? 'Imported · Read-only' : 'Synced & added contacts'}</span></p>${realMode ? '' : `<button class="primary" data-action="new-contact">${icon('plus')} Add contact</button>`}</div>
    <div class="contact-grid">${contacts.map((contact) => `<article class="contact-tile">${avatar(contact.name, contact.color, 'large')}<h3>${escape(contact.name)}</h3><p>${escape(contact.note)}</p><div class="contact-emails">${contact.emails.map((email) => `<button data-write="${escape(email)}" aria-label="Write to ${escape(contact.name)} at ${escape(email)}">${escape(email)}${icon('mail')}</button>`).join('')}</div><div class="contact-tile-bottom"><span>${contact.source === 'local' ? 'Added by you' : `${contact.source === 'gmail' ? 'Google' : 'Outlook'} contact`}</span>${realMode ? '' : `<button class="text-button" data-edit-contact="${escape(contact.id)}" aria-label="Edit ${escape(contact.name)}">Edit contact</button>`}</div></article>`).join('') || '<div class="empty-state"><h3>No contacts found</h3><p>Try a different search, or add a new connection.</p></div>'}</div>
    <p class="contacts-explainer">${icon('people')} Contacts are shared across your inbox. All of a contact's email addresses stay together.</p>
  </section>`;
}

function render() {
  const existingFolderTree = document.querySelector('.provider-folders');
  if (existingFolderTree) providerFoldersOpen = existingFolderTree.open;
  disposeHtmlMessages();
  const activeSearch = document.activeElement?.id === 'search';
  const cursor = activeSearch ? document.activeElement.selectionStart : null;
  const replyFocused = document.activeElement?.id === 'chat-reply';
  const replySelection = replyFocused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  if (folder.startsWith('provider:') && !currentFolder()) {
    folder = 'inbox'; selected = null; query = ''; unreadOnly = false;
    notify('That folder is no longer in the synced account. Returned to Inbox.');
  }
  if (realMode && account !== 'all' && !accounts.some((entry) => entry.id === account)) account = 'all';
  const selectedMessage = state.messages.find((message) => message.id === selected);
  const selectedKey = selectedMessage ? conversationKey(selectedMessage) : null;
  const eligible = visibleConversations(state, { folder, account, query });
  selected = eligible.find((conversation) => conversation.key === selectedKey)?.id || null;
  const messages = unreadOnly ? eligible.filter((conversation) => conversation.unread) : eligible;
  app.innerHTML = `${sidebar()}<main class="main">
    <header class="topbar"><div class="breadcrumb" title="${escape(folderLabel())}">${realMode ? 'Real mail' : 'Your space'} <span>/</span> <strong>${escape(folderLabel())}</strong></div><div class="search-wrap">${icon('search')}<input id="search" type="search" placeholder="${folder === 'contacts' ? 'Find your people...' : 'Search your conversations...'}" value="${escape(query)}" aria-label="${folder === 'contacts' ? 'Search contacts' : 'Search messages'}"><span class="search-key">/</span></div>
      <div class="sync-area"><button class="sync-button" data-action="sync" ${syncing || realBusy ? 'disabled' : ''}>${icon('sync', syncing || realBusy ? 'spinning' : '')} ${realMode ? sending ? 'Sending...' : realBusy ? 'Syncing...' : 'Sync mail' : syncing ? 'Syncing demo...' : 'Sync demo'}</button><span>${state.lastSync ? `Last ${realMode ? 'sync' : 'demo sync'} ${dateLabel(state.lastSync)} ${time(state.lastSync)}` : realMode ? 'Connect your accounts' : 'Sample mail & contacts'}</span></div>
    </header>
    ${storageError && !realMode ? `<div class="storage-error" role="alert">${escape(storageError)}</div>` : ''}
    ${realMode ? `<div class="real-status ${realError ? 'storage-error' : ''}" role="${realError ? 'alert' : 'status'}">${escape(realStatus || (accounts.length ? 'Cached mail is available offline. Reconnect to sync or send.' : 'No real accounts connected yet. Use Manage accounts to connect Gmail or Outlook.'))} <button class="text-button" data-action="connections">Accounts</button>${realBusy && !sending ? '<button class="text-button" data-action="cancel-real-sync">Cancel</button>' : ''}</div>` : ''}
    ${folder === 'contacts' ? contactsPage() : `<div class="mail-workspace ${selected ? 'has-selection' : ''}">${messageList(messages)}${reader()}</div>`}
    <footer class="app-footer"><span><span class="status-dot"></span> Your inbox, a little more human.</span><span>${realMode ? 'Real mail · Local cache · Sending enabled with consent' : 'Sample data only. No email is sent. <button data-action="reset">Reset demo</button>'}</span></footer>
  </main>`;
  document.querySelector('.provider-folders')?.addEventListener('toggle', (event) => {
    if (event.target.isConnected) providerFoldersOpen = event.target.open;
  });
  disposeHtmlMessages = mountHtmlMessages(app, state.messages, (href) => {
    if (confirm(`Open this link outside Gather?\n\n${href}\n\nOnly continue if you trust this destination.`)) {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  }, (message) => {
    const permission = imagePermissions.get(message.id);
    return permission?.bodyHtml === message.bodyHtml ? { loadImages: true, inlineImages: permission.images } : {};
  }, (message) => expandedQuotes.has(message.id) ? message.bodyHtml : messageQuoteContent(message).bodyHtml);
  if (activeSearch) {
    const input = document.querySelector('#search');
    input.focus();
    input.setSelectionRange(cursor, cursor);
  }
  if (replyFocused && document.querySelector('#chat-reply')) {
    const input = document.querySelector('#chat-reply');
    input.focus({ preventScroll: true });
    input.setSelectionRange(...replySelection);
  }
}

function openComposer(to = '', subject = '', accountId = account === 'all' ? accounts[0]?.id : account) {
  if (sending) { notify('Wait for the current send to finish.'); return; }
  if (realMode && !accounts.length) { connections.show(); return; }
  const form = document.querySelector('#compose-form');
  form.reset();
  form.querySelector('.form-error').textContent = '';
  form.elements.account.innerHTML = accounts.map((item) => `<option value="${escape(item.id)}">${item.name} · ${escape(item.email)}</option>`).join('');
  form.elements.account.value = accountId;
  form.elements.to.value = to;
  form.elements.subject.value = subject;
  form.elements.to.multiple = realMode;
  form.querySelector('.muted').textContent = realMode ? 'This sends real email using the selected account. Sending permission is required.' : 'Demo only. Messages are saved locally, never delivered.';
  form.querySelector('[type="submit"]').textContent = realMode ? 'Send email' : 'Save to demo Sent';
  composeDialog.showModal();
  form.elements[to ? 'body' : 'to'].focus();
}

function refreshEmailLabels() {
  const rows = [...emailRows.children];
  rows.forEach((row, index) => {
    row.querySelector('label span').textContent = `Email ${index + 1}`;
    const remove = row.querySelector('button');
    remove.setAttribute('aria-label', `Remove email ${index + 1}`);
    remove.disabled = rows.length === 1;
  });
}

function appendEmailRow(email = '') {
  const row = document.createElement('div');
  row.className = 'contact-email-row';
  row.innerHTML = `<label><span></span><input name="email" type="email" autocomplete="email" required value="${escape(email)}" placeholder="someone@example.com"></label><button class="text-button" type="button" data-remove-email>Remove</button>`;
  emailRows.append(row);
  refreshEmailLabels();
  return row.querySelector('input');
}

function populateContactForm(contact, name = '', emails = ['']) {
  editingContactId = contact?.id || null;
  contactForm.querySelector('.form-error').textContent = '';
  contactForm.elements.name.value = contact?.name || name;
  emailRows.replaceChildren();
  emails.forEach(appendEmailRow);
  document.querySelector('#contact-title').textContent = contact ? 'Edit connection' : 'Make a connection';
  contactForm.querySelector('[type="submit"]').textContent = contact ? 'Save changes' : 'Add contact';
}

function openContact(name = '', email = '', id = null) {
  if (realMode) { notify('Real contacts are read-only. Edit them at the provider, then sync.'); return; }
  const contact = id ? state.contacts.find((entry) => entry.id === id) : null;
  if (id && !contact) { notify('This contact no longer exists.'); return; }
  contactForm.reset();
  senderToAdd = email ? { name, email } : null;
  const target = document.querySelector('#contact-target');
  target.parentElement.hidden = !senderToAdd;
  target.innerHTML = `<option value="">New contact</option>${state.contacts.map((entry) =>
    `<option value="${escape(entry.id)}">${escape(entry.name)} (${escape(entry.emails[0])})</option>`).join('')}`;
  populateContactForm(contact, name, contact?.emails || [email]);
  contactDialog.showModal();
}

document.querySelector('#contact-target').addEventListener('change', (event) => {
  const contact = state.contacts.find((entry) => entry.id === event.target.value);
  if (event.target.value && !contact) {
    contactForm.querySelector('.form-error').textContent = 'This contact no longer exists. Close and reopen the form.';
    return;
  }
  populateContactForm(contact, senderToAdd.name,
    contact ? [...contact.emails, senderToAdd.email] : [senderToAdd.email]);
});

document.querySelector('#add-contact-email').addEventListener('click', () => appendEmailRow().focus());
emailRows.addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-email]');
  if (!remove || emailRows.children.length === 1) return;
  const row = remove.closest('.contact-email-row');
  const next = row.nextElementSibling || row.previousElementSibling;
  row.remove();
  refreshEmailLabels();
  next.querySelector('input').focus();
});

app.addEventListener('input', (event) => {
  if (event.target.id === 'search') {
    query = event.target.value;
    render();
  }
  if (event.target.id === 'chat-reply') {
    const message = state.messages.find((entry) => entry.id === selected);
    if (message) replyDrafts.set(conversationKey(message), event.target.value);
  }
});

app.addEventListener('submit', async (event) => {
  if (event.target.id !== 'chat-reply-form') return;
  event.preventDefault();
  const message = state.messages.find((entry) => entry.id === selected);
  if (realMode) {
    if (sending) return;
    const key = conversationKey(message);
    const from = accounts.find(entry => entry.id === message.accountId);
    const target = replyTarget(conversationMessages(state, selected), from?.email);
    if (!target) { replyErrors.set(key, 'Sync this conversation before replying.'); render(); return; }
    const body = new FormData(event.target).get('body');
    if (!body.trim()) { replyErrors.set(key, 'Write a message before sending.'); render(); return; }
    if (!confirm(`Reply to all from ${from.email}?\n\nTo: ${target.toRecipients.join(', ')}${target.ccRecipients.length ? `\nCc: ${target.ccRecipients.join(', ')}` : ''}`)) return;
    const originalDraft = replyDrafts.get(key);
    sending = true; replyErrors.delete(key); render();
    try {
      const result = await connections.send(message.accountId, {
        to: target.toRecipients, cc: target.ccRecipients, subject: target.parent.subject || '(No subject)', body, replyToId: target.parent.id,
      });
      if (replyDrafts.get(key) === originalDraft) replyDrafts.delete(key);
      notify(result.warning || 'Email accepted by the provider and added to the conversation.');
    } catch (error) { replyErrors.set(key, error.message); }
    finally { sending = false; render(); }
    document.querySelector('.chat-message:last-child')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  try {
    const updated = replyToConversation(state, selected, new FormData(event.target).get('body'));
    replyDrafts.delete(conversationKey(message));
    state = updated;
  } catch (error) {
    event.target.querySelector('.form-error').textContent = error.message;
    return;
  }
  persist();
  render();
  document.querySelector('.chat-message:last-child')?.scrollIntoView({ block: 'nearest' });
  document.querySelector('#chat-reply')?.focus({ preventScroll: true });
  notify('Demo reply saved. No email was delivered.');
});

app.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-folder], button[data-provider-folder], button[data-toggle-folder-account], button[data-toggle-provider-folder], button[data-account], button[data-group], button[data-message], button[data-write], button[data-edit-contact], button[data-action]');
  if (!button) return;
  if (button.dataset.toggleFolderAccount || button.dataset.toggleProviderFolder) {
    const attribute = button.dataset.toggleFolderAccount ? 'toggleFolderAccount' : 'toggleProviderFolder';
    const id = button.dataset[attribute];
    const expanded = attribute === 'toggleFolderAccount' ? expandedFolderAccounts : expandedFolderBranches;
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    render();
    [...app.querySelectorAll('button[data-toggle-folder-account], button[data-toggle-provider-folder]')]
      .find((entry) => entry.dataset[attribute] === id)?.focus({ preventScroll: true });
    return;
  }
  if (realMode && ['star', 'read', 'archive', 'reset'].includes(button.dataset.action)) {
    notify('Real accounts are read-only. No changes were made.');
    return;
  }
  if (button.dataset.providerFolder) {
    const target = state.folders?.find((entry) => entry.id === button.dataset.providerFolder);
    if (!target) { notify('This folder is no longer available. Sync to refresh the folder list.'); return; }
    folder = target.id; account = target.accountId; selected = null; query = ''; unreadOnly = false;
  } else if (button.dataset.folder) {
    folder = button.dataset.folder;
    selected = null;
    query = '';
    unreadOnly = false;
  } else if (button.dataset.account) {
    account = button.dataset.account;
    if (folder.startsWith('provider:')) { folder = 'inbox'; query = ''; unreadOnly = false; }
    selected = null;
  } else if (button.dataset.group) {
    const key = button.dataset.group;
    if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
  } else if (button.dataset.message) {
    selected = button.dataset.message;
    if (!realMode) {
      conversationMessages(state, selected).forEach((message) => { message.unread = false; });
      persist();
    }
  } else if (button.dataset.write) {
    openComposer(button.dataset.write);
    return;
  } else if (button.dataset.editContact) {
    openContact('', '', button.dataset.editContact);
    return;
  } else {
    const message = state.messages.find((entry) => entry.id === (button.dataset.item || selected));
    switch (button.dataset.action) {
      case 'connections': await connections.show(); return;
      case 'cancel-real-sync': connections.cancel(); return;
      case 'real-mode':
      case 'demo-mode': {
        if (syncing || sending) { notify('Wait for the current sync or send to finish before switching mailboxes.'); return; }
        if (!realMode) demoState = state;
        realMode = button.dataset.action === 'real-mode';
        state = realMode ? realState : demoState;
        accounts = realMode ? realState.accounts : DEMO_ACCOUNTS;
        for (const permission of imagePermissions.values()) permission.controller.abort();
        imagePermissions.clear();
        folder = 'inbox'; account = 'all'; selected = null; query = ''; unreadOnly = false;
        render();
        if (realMode) {
          try { await connections.initialize(); }
          catch (error) { realStatus = error.message; realError = true; render(); }
        }
        return;
      }
      case 'compose': openComposer(); return;
      case 'remove-send-attempt':
        if (!confirm('Remove this local send attempt?\n\nFirst check Sent at your email provider. The message may already have been sent. Removing this record does not recall it and allows another identical send, which could create a duplicate.')) return;
        try {
          await connections.removeSendAttempt(message.accountId, message.id);
          replyErrors.delete(conversationKey(message));
          render();
        } catch (error) { notify(error.message); }
        return;
      case 'new-contact': openContact(); return;
      case 'add-sender': {
        const received = conversationMessages(state, selected).find((entry) => entry.folder !== 'sent');
        openContact(received.senderName, received.sender);
        return;
      }
      case 'about': notify(realMode ? 'Mail is cached on this device. Sending requires your explicit permission; existing mail and contacts are not edited. No Gather backend is used.' : 'Demo accounts are fictional samples. Use Real mail to connect your own accounts.'); return;
      case 'conversation-format': {
        if (!message) return;
        const key = conversationKey(message);
        const messages = conversationMessages(state, message.id);
        if (button.dataset.format === 'plain') {
          htmlConversations.delete(key);
          blockConversationImages(messages);
        } else if (!htmlConversations.has(key)) {
          htmlConversations.add(key);
          blockConversationImages(messages);
          const withImages = messages.filter((entry) => /<img\b/i.test(entry.bodyHtml || ''));
          if (withImages.length && confirmImages('the messages in this conversation')) {
            const loading = enableImages(withImages);
            document.querySelector('.conversation-format [data-format="html"]')?.focus({ preventScroll: true });
            await loading;
            return;
          }
        }
        render();
        document.querySelector(`.conversation-format [data-format="${button.dataset.format === 'plain' ? 'plain' : 'html'}"]`)?.focus({ preventScroll: true });
        return;
      }
      case 'toggle-quotes':
        if (expandedQuotes.has(message.id)) expandedQuotes.delete(message.id);
        else expandedQuotes.add(message.id);
        break;
      case 'load-images': {
        if (!message?.bodyHtml || imagePermissions.has(message.id)) return;
        if (!confirmImages('this message')) return;
        await enableImages([message]);
        return;
      }
      case 'hide-images':
        imagePermissions.get(message.id)?.controller.abort();
        imagePermissions.delete(message.id);
        notify('Images hidden. Requests already made cannot be undone.');
        break;
      case 'back': selected = null; break;
      case 'unread-filter': unreadOnly = !unreadOnly; selected = null; break;
      case 'star': message.starred = !message.starred; persist(); break;
      case 'read': message.unread = !message.unread; persist(); break;
      case 'archive':
        message.folder = message.folder === 'archive' ? 'inbox' : 'archive';
        notify(message.folder === 'archive' ? 'Message archived.' : 'Message restored to its inbox folder.');
        persist();
        break;
      case 'sync': {
        if (realMode) {
          try { await connections.sync(account); }
          catch (error) { realStatus = error.message; realError = true; render(); }
          return;
        }
        if (syncing) return;
        syncing = true;
        const syncAccount = account;
        render();
        await new Promise((resolve) => setTimeout(resolve, 850));
        const before = state.messages.length;
        state = syncDemo(state, syncAccount);
        syncing = false;
        persist();
        notify(state.messages.length > before ? `Demo sync complete. ${state.messages.length - before} new messages and their contacts imported.` : 'Demo is up to date. No new sample messages.');
        break;
      }
      case 'reset':
        if (syncing) { notify('Wait for the demo sync to finish before resetting.'); return; }
        if (!confirm('Reset all messages, contacts, and local demo changes?')) return;
        try {
          localStorage.removeItem(STORAGE_KEY);
          storageError = '';
        } catch (error) {
          storageError = `Unable to reset browser storage: ${error.message}`;
          render();
          return;
        }
        state = createDemo();
        folder = 'inbox'; account = 'all'; selected = 'm1'; query = ''; unreadOnly = false;
        collapsed.clear();
        replyDrafts.clear();
        htmlConversations.clear();
        expandedQuotes.clear();
        for (const permission of imagePermissions.values()) permission.controller.abort();
        imagePermissions.clear();
        persist();
        notify('A fresh start. Demo data restored.');
        break;
    }
  }
  render();
  if (button.dataset.providerFolder) document.querySelector('.message-list')?.scrollIntoView({ block: 'start' });
  if (button.dataset.message) document.querySelector('.chat-reader')?.scrollIntoView({ block: 'start' });
  if (button.dataset.action === 'back') document.querySelector('.message-list')?.scrollIntoView({ block: 'start' });
});

document.querySelectorAll('[data-close]').forEach((button) =>
  button.addEventListener('click', () => button.closest('dialog').close()));

contactForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (realMode) { notify('Real contacts are read-only.'); return; }
  const values = new FormData(event.target);
  try {
    state = editingContactId
      ? updateContact(state, editingContactId, values.get('name'), values.getAll('email'))
      : addContact(state, values.get('name'), values.getAll('email'));
  } catch (error) {
    event.target.querySelector('.form-error').textContent = error.message;
    return;
  }
  persist();
  contactDialog.close();
  notify(editingContactId ? 'Contact updated. Inbox groups now reflect their email addresses.' : 'Contact added. Their inbox messages are now grouped with your people.');
  render();
});

document.querySelector('#compose-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = new FormData(event.target);
  const from = accounts.find((entry) => entry.id === values.get('account'));
  if (realMode) {
    if (sending) return;
    const form = event.target;
    try {
      const recipients = parseRecipients(values.get('to'));
      if (!from || !canSend(from.id)) throw new Error('Reconnect the selected account and grant sending permission.');
      if (!values.get('subject').trim() || !values.get('body').trim()) throw new Error('Please add a subject and message.');
      if (!confirm(`Send this real email from ${from.email} to ${recipients.join(', ')}?`)) return;
      sending = true;
      [...form.elements].forEach(element => { element.disabled = true; });
      form.querySelector('.form-error').textContent = '';
      const result = await connections.send(from.id, { to: recipients, subject: values.get('subject'), body: values.get('body') });
      folder = 'sent'; account = from.id; selected = result.message.id; query = ''; unreadOnly = false;
      composeDialog.close();
      notify(result.warning || 'Email accepted by the provider. Its Sent copy will be confirmed on sync.');
    } catch (error) { form.querySelector('.form-error').textContent = error.message; }
    finally {
      sending = false;
      [...form.elements].forEach(element => { element.disabled = false; });
      render();
    }
    return;
  }
  if (!isEmail(values.get('to').trim())) {
    event.target.querySelector('.form-error').textContent = 'Enter a full email address, such as someone@example.com.';
    return;
  }
  if (!values.get('subject').trim() || !values.get('body').trim()) {
    event.target.querySelector('.form-error').textContent = 'Please add a subject and message.';
    return;
  }
  const message = {
    id: crypto.randomUUID(), sender: from.email, senderName: 'Alex Morgan', accountId: from.id,
    threadId: crypto.randomUUID(),
    to: values.get('to').trim().toLowerCase(), subject: values.get('subject').trim(),
    body: values.get('body').trim(), date: new Date().toISOString(), folder: 'sent', unread: false, starred: false,
  };
  state.messages.push(message);
  folder = 'sent'; account = from.id; selected = message.id; query = ''; unreadOnly = false;
  persist();
  composeDialog.close();
  notify('Saved to demo Sent. No email was delivered.');
  render();
});

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey
    && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
    && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    document.querySelector('#search').focus();
  }
});

async function refreshRealMail() {
  if (!realMode || document.hidden || sending) return;
  try { await connections.syncWhenDue(); }
  catch (error) { realStatus = error.message; realError = true; render(); }
}
document.addEventListener('visibilitychange', refreshRealMail);
setInterval(refreshRealMail, 5 * 60000);
render();

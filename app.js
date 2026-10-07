import { ACCOUNTS as DEMO_ACCOUNTS, createDemo, findContact, visibleConversations, conversationMessages, conversationKey, conversationAddress, isOutgoing, topicSubject, replyToConversation, groupMessages, addContact, updateContact, syncDemo, isValidState, isEmail } from './mail.js';
import { createAccountsPanel } from './accounts-panel.js';
import { mountHtmlMessages } from './email-html.js';
import { inlineImageReferences, loadInlineImages } from './email-images.js';
import { getAccountApi, canSend, canManageMail, canManageContacts } from './auth.js';
import { unknownSenders, updateDemoConversation } from './conversation-actions.js';
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
let account = DEMO_ACCOUNTS[0].id;
let query = '';
let unreadOnly = false;
let selected = null;
let audience = 'contacts';
let folderChosen = false;
let syncing = false;
const expandedGroups = new Set();
const replyDrafts = new Map();
const htmlConversations = new Set();
const conversationSearches = new Map();
const mobileLayout = window.matchMedia('(max-width: 900px)');
const expandedQuotes = new Set();
const imagePermissions = new Map();
let disposeHtmlMessages = () => {};
let noticeTimer;
let realMode = false;
let homeVisible = true;
let accounts = DEMO_ACCOUNTS;
let demoState = state;
let realState = { version: 1, accounts: [], contacts: [], messages: [], folders: [], lastSync: null };
let providerFoldersOpen = true;
const expandedFolderBranches = new Set();
let realStatus = '';
let realError = false;
let realBusy = false;
let sending = false;
let conversationActionBusy = false;
const pendingReads = new Map();
let senderContext = null;
const senderDialog = document.querySelector('#sender-dialog');
const senderForm = document.querySelector('#sender-form');
const replyErrors = new Map();
const connections = createAccountsPanel({
  onChange: (updated) => {
    const previousSelection = state.messages.find((message) => message.id === selected);
    if (realMode && previousSelection?.clientSendId) {
      const replacement = updated.messages.find((message) => message.clientSendId === previousSelection.clientSendId);
      if (replacement && htmlConversations.has(conversationKey(previousSelection))) {
        htmlConversations.add(conversationKey(replacement));
      }
      if (replacement && conversationSearches.has(conversationKey(previousSelection))) {
        conversationSearches.set(conversationKey(replacement), conversationSearches.get(conversationKey(previousSelection)));
      }
      selected = replacement?.id || selected;
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

async function markOpenedConversationsRead() {
  if (!realMode || homeVisible) { pendingReads.clear(); return; }
  if (realBusy || sending || conversationActionBusy || !pendingReads.size) return;
  const [key, opened] = pendingReads.entries().next().value;
  pendingReads.delete(key);
  const messages = conversationMessages(realState, opened.messageId);
  if (!messages.some(message => message.remote && !message.sendState && !message.isDraft && message.unread)) {
    queueMicrotask(markOpenedConversationsRead);
    return;
  }
  conversationActionBusy = true;
  try {
    const result = await connections.actOnConversation(opened.accountId, opened.messageId, 'read');
    if (result.warning) notify(result.warning);
  } catch (error) {
    realStatus = `Could not mark the conversation as read. ${error.message}`;
    realError = true;
    notify(realStatus);
  } finally {
    conversationActionBusy = false;
    render();
  }
}

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
const labels = { inbox: 'Inbox', unknown: 'Unknown senders', starred: 'Starred', sent: 'Sent', archive: 'Archive', contacts: 'Contacts', outbox: 'Outbox', trash: 'Trash' };

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

function currentFolder() {
  return state.folders?.find((entry) => entry.id === folder);
}

function folderLabel() {
  return currentFolder()?.path || labels[folder] || 'Folder';
}

function groupExpansionKey(key) {
  return JSON.stringify([realMode, account, folder, audience, key]);
}

function selectFolder(id) {
  folder = id; folderChosen = true; selected = null; query = ''; unreadOnly = false;
}

function resetAccountView() {
  folder = state.folders?.find((entry) => entry.accountId === account && (entry.kind === 'inbox' || entry.remoteId === 'INBOX'))?.id || 'inbox';
  folderChosen = false; selected = null; query = ''; unreadOnly = false; audience = 'contacts';
}

async function switchMode(nextRealMode) {
  if (syncing || sending || conversationActionBusy) {
    notify('Wait for the current sync, send, or conversation action to finish before switching mailboxes.');
    render();
    return;
  }
  if (!realMode) demoState = state;
  homeVisible = false;
  realMode = nextRealMode;
  state = realMode ? realState : demoState;
  accounts = realMode ? realState.accounts : DEMO_ACCOUNTS;
  account = accounts[0]?.id || '';
  for (const permission of imagePermissions.values()) permission.controller.abort();
  imagePermissions.clear();
  resetAccountView();
  render();
  if (realMode) {
    try { await connections.initialize(); }
    catch (error) { realStatus = error.message; realError = true; render(); }
  }
}

function showHome() {
  if (syncing || sending || conversationActionBusy) {
    notify('Wait for the current sync, send, or conversation action to finish before returning home.');
    return;
  }
  if (!realMode) demoState = state;
  homeVisible = true;
  for (const permission of imagePermissions.values()) permission.controller.abort();
  imagePermissions.clear();
  render();
  window.scrollTo({ top: 0 });
  document.querySelector('#welcome-title')?.focus({ preventScroll: true });
}

function homeScreen() {
  return `<main class="welcome-screen" aria-labelledby="welcome-title">
    <a class="brand welcome-brand" href="./" data-home aria-label="Gather home"><span class="brand-symbol">${icon('leaf')}</span>gather<span class="brand-dot">.</span></a>
    <h1 id="welcome-title" tabindex="-1">Welcome to Gather</h1>
    <p class="welcome-description">Choose how you want to explore your inbox.</p>
    <div class="welcome-choices">
      <button class="welcome-choice" data-action="enter-demo" aria-labelledby="demo-choice-title" aria-describedby="demo-choice-description">
        <span class="welcome-choice-icon">${icon('leaf')}</span>
        <span class="welcome-choice-title" id="demo-choice-title">Demo</span>
        <span class="welcome-choice-description" id="demo-choice-description">Explore sample conversations and contacts. No sign-in needed, and no email is sent.</span>
        <span class="welcome-choice-action">Try the demo ${icon('arrow')}</span>
      </button>
      <button class="welcome-choice" data-action="enter-real" aria-labelledby="real-choice-title" aria-describedby="real-choice-description">
        <span class="welcome-choice-icon">${icon('mail')}</span>
        <span class="welcome-choice-title" id="real-choice-title">Real mail</span>
        <span class="welcome-choice-description" id="real-choice-description">Connect Gmail or Outlook to read and send your email. Your mailbox stays on this device.</span>
        <span class="welcome-choice-action">Open real mail ${icon('arrow')}</span>
      </button>
    </div>
  </main>`;
}

function providerFolders() {
  const folders = (state.folders || []).filter((entry) => entry.accountId === account);
  const counts = new Map();
  for (const message of state.messages) {
    for (const id of message.folderIds || []) counts.set(id, (counts.get(id) || 0) + 1);
  }
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
  const virtualFolders = realMode ? (folders.length ? accounts.find((entry) => entry.id === account)?.provider === 'gmail' ? ['archive', 'outbox'] : ['outbox'] : ['inbox', 'sent', 'archive', 'outbox'])
    : ['inbox', 'sent', 'starred', 'archive', 'trash'];
  return `<details class="provider-folders" ${providerFoldersOpen ? 'open' : ''}><summary>Folders${realMode ? ' &amp; labels' : ''}</summary>
    ${account ? `<div class="provider-folder-list">
      ${realMode ? folderTree(account) : ''}
      ${virtualFolders.map((id) => `<button class="provider-folder-item ${folder === id ? 'active' : ''}" data-folder="${id}"
        ${folder === id ? 'aria-current="page"' : ''} title="${labels[id]}">
        ${icon(id === 'starred' ? 'star' : id === 'archive' ? 'archive' : id === 'inbox' ? 'inbox' : 'sent')}
        <span>${labels[id]}${realMode && id === 'outbox' ? '<small>Local send attempts</small>' : ''}</span>
        <span class="provider-folder-count">${visibleConversations(state, { folder: id, account, audience: 'all' }).length}</span>
      </button>`).join('')}</div>` : '<p class="folder-scope-note">Connect an account to see its folders.</p>'}
    ${realMode && account ? `<p class="folder-scope-note">${folders.length ? 'Counts show cached messages. Sync refreshes this account.' : 'Sync this account to discover its folders.'}</p>` : ''}
  </details>`;
}

function brandRow() {
  return `<header class="brand-row"><a class="brand" href="./" data-home aria-label="Gather home"><span class="brand-symbol">${icon('leaf')}</span>gather<span class="brand-dot">.</span></a>
    <button class="compose-button mobile-compose" data-action="compose">${icon('plus')} New message</button></header>`;
}

function sidebar() {
  return `<aside class="sidebar" aria-label="Mailbox navigation">
    <label class="sidebar-select" for="account-select">Account<select id="account-select" ${accounts.length ? '' : 'disabled'}>
      ${accounts.length ? accounts.map((entry) => `<option value="${escape(entry.id)}" ${entry.id === account ? 'selected' : ''}>${escape(entry.email)} · ${entry.name}</option>`).join('') : '<option value="">No connected accounts</option>'}
    </select></label>
    ${providerFolders()}
    <nav class="contacts-nav" aria-label="Contacts">
      <div class="nav-divider"></div>
      <button class="nav-item ${folder === 'contacts' ? 'active' : ''}" data-folder="contacts" ${folder === 'contacts' ? 'aria-current="page"' : ''}>${icon('people')}<span>Contacts</span></button>
    </nav>
  </aside>`;
}

function senderTabs() {
  return `<div class="conversation-navigation">
    <button class="text-button folders-back" data-action="show-folders">${icon('back')} Folders</button>
    <span class="current-folder-label" title="${escape(folderLabel())}">${escape(folderLabel())}</span>
    <div class="sender-tabs" role="tablist" aria-label="Conversation senders">
      ${[['contacts', 'Contacts'], ['unknown', 'Unknown senders']].map(([id, label]) => `<button id="sender-tab-${id}" role="tab"
        aria-selected="${audience === id}" aria-controls="conversation-results" tabindex="${audience === id ? 0 : -1}" data-audience="${id}">${label}</button>`).join('')}
    </div></div>`;
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
    <div class="group-list">${groups.length ? groups.map((group, index) => `<section class="contact-group">
      <button class="group-heading" data-group="${escape(group.key)}" aria-expanded="${expandedGroups.has(groupExpansionKey(group.key))}" aria-controls="group-messages-${index}">
        ${avatar(group.name, group.contact?.color || 'sand')}
        <span class="group-name">${escape(group.name)}<small>${group.messages.length} topic${group.messages.length === 1 ? '' : 's'}${group.messages.some((message) => message.unread) ? ' <span class="unread-label"> · new</span>' : ''}</small></span>
        ${icon('arrow', expandedGroups.has(groupExpansionKey(group.key)) ? 'expanded' : '')}
      </button>
      <div class="group-messages" id="group-messages-${index}" ${expandedGroups.has(groupExpansionKey(group.key)) ? '' : 'hidden'}>${group.messages.map((message) => `<button class="message-card ${selectedKey === message.key ? 'selected' : ''} ${message.unread ? 'unread' : ''}" data-message="${escape(message.id)}" aria-pressed="${selectedKey === message.key}">
        <span class="message-topline">${provider(message.accountId)}<span>${dateLabel(message.date)} <span class="message-time">· ${time(message.date)}</span></span>${message.starred ? icon('star', 'filled-star') : ''}${message.unread ? '<span class="unread-dot" aria-label="Unread"></span>' : ''}</span>
        <span class="message-subject">${escape(message.subject)} <span class="thread-count" aria-label="${message.messages.length} messages">${message.messages.length}</span></span>
        <span class="message-preview">${message.latest.isDraft ? 'Draft: ' : isOutgoing(message.latest) ? 'You: ' : ''}${escape(messagePreview(message.latest))}</span>
      </button>`).join('')}</div>
    </section>`).join('') : `<div class="empty-state">${icon(query ? 'search' : 'leaf')}<h3>${query ? 'No matching messages' : 'A lovely bit of quiet.'}</h3><p>${query || unreadOnly ? 'Try another search or turn off the unread filter.' : folder === 'sent' ? realMode ? 'Imported sent conversations will appear here.' : 'Your demo conversations will appear here.' : 'There are no messages in this view.'}</p></div>`}</div>
    <div class="list-footer">${icon('check')} A place for people, not noise.</div>
  </section>`;
}

const compactSearchText = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase();

function conversationSearchTerm(message) {
  return compactSearchText(conversationSearches.get(conversationKey(message)) || '');
}

function revealQuotesForSearch(message) {
  const term = conversationSearchTerm(message);
  return Boolean(term && !compactSearchText(messagePlainText(message, { hideQuotes: true })).includes(term)
    && compactSearchText(messagePlainText(message)).includes(term));
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
  const searchQuotes = revealQuotesForSearch(message);
  const showQuotes = expandedQuotes.has(message.id) || searchQuotes;
  const text = messagePlainText(message, { hideQuotes: !showQuotes });
  const images = imagePermissions.get(message.id);
  const containsImages = /<img\b/i.test(message.bodyHtml || '');
  return `<li class="chat-message ${sent ? 'outgoing' : 'incoming'} ${formatted ? 'has-html' : ''}" data-chat-message="${escape(message.id)}">
    <div class="chat-meta"><strong>${sent ? 'You' : escape(contact?.name || message.senderName)}</strong><time datetime="${message.date}" title="${escape(new Date(message.date).toLocaleString())}">${time(message.date)}</time></div>
    ${formatted && containsImages ? `<div class="html-controls"><span>${images ? 'Images enabled for this message' : 'Images blocked'}</span><button class="text-button" data-action="${images ? 'hide-images' : 'load-images'}" data-item="${escape(message.id)}">${images ? 'Hide images' : 'Load images'}</button></div>` : ''}
    ${formatted && images?.status ? `<p class="image-status ${images.error ? 'form-error' : ''}" role="${images.error ? 'alert' : 'status'}">${escape(images.status)}</p>` : ''}
    <div class="chat-bubble">${formatted ? `<iframe class="html-message" data-html-message="${escape(message.id)}" title="Formatted email from ${escape(message.senderName)}" sandbox="allow-same-origin" referrerpolicy="no-referrer"></iframe><div class="html-fallback" hidden><p role="status"></p><div class="message-body">${escape(text || (quoteContent.hasQuotes ? 'Quoted previous messages hidden.' : ''))}</div></div>` : `<div class="message-body">${escape(text || (quoteContent.hasQuotes ? 'Quoted previous messages hidden.' : ''))}</div>`}</div>
    ${quoteContent.hasQuotes ? searchQuotes ? '<p class="quote-search-note">Quoted text shown for this search match.</p>' : `<button class="text-button quote-toggle" data-action="toggle-quotes" data-item="${escape(message.id)}" aria-expanded="${showQuotes}">${showQuotes ? 'Hide quoted text' : 'Show quoted text'}</button>` : ''}
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
  const localQuery = conversationSearches.get(key) || '';
  const term = conversationSearchTerm(first);
  const matchingMessages = term ? messages.filter((message) => [
    message.senderName, message.sender, message.to, message.subject,
    findContact(state.contacts, conversationAddress(message))?.name, messagePlainText(message),
  ].filter(Boolean).some((text) => compactSearchText(text).includes(term))) : messages;
  const target = realMode ? replyTarget(messages, from.email) : null;
  const replyDisabled = realMode && (!target || !canSend(from.id) || realBusy || sending);
  const draftOnly = realMode && first.isDraft;
  const senders = unknownSenders(state, first.id);
  const canChangeConversation = !realMode || canManageMail(from.id);
  const canAddSender = !realMode || canManageContacts(from.id);
  const busy = realBusy || sending || syncing || conversationActionBusy;
  const unconfirmed = messages.some((message) => message.sendState || message.isDraft);
  let previousDay = '';
  const bubbles = matchingMessages.map((message) => {
    const day = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(message.date));
    const divider = day !== previousDay ? `<li class="chat-day"><span>${escape(day)}</span></li>` : '';
    previousDay = day;
    return divider + chatMessage(message);
  }).join('');
  return `<article class="reader open chat-reader" aria-label="Conversation with ${escape(name)}">
    <div class="reader-toolbar">
      <button class="icon-button mobile-back" data-action="back" aria-label="Back to message list">${icon('back')}</button>
      <div class="conversation-search">
        <div class="conversation-search-input">${icon('search')}<input id="conversation-search" type="search" value="${escape(localQuery)}" placeholder="Search within conversation" aria-label="Search within conversation" aria-describedby="conversation-search-count">
        ${localQuery ? '<button class="text-button" data-action="clear-conversation-search">Clear</button>' : ''}</div>
        <span id="conversation-search-count" role="status" aria-live="polite">${term ? `${matchingMessages.length} of ${messages.length} messages match` : 'Search only this conversation'}</span>
      </div>
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
      <div class="conversation-actions" role="group" aria-label="Conversation actions">
        ${senders.length ? `<button class="text-button" data-action="add-conversation-sender" ${busy || !canAddSender ? 'disabled' : ''}>${icon('people')} Add sender to contacts</button>` : ''}
        <button class="text-button" data-action="archive-conversation" ${busy || !canChangeConversation || realMode && unconfirmed ? 'disabled' : ''}>${icon('archive')} Archive</button>
        <button class="text-button trash-action" data-action="trash-conversation" ${busy || !canChangeConversation || realMode && unconfirmed ? 'disabled' : ''}>${icon('unknown')} Move to Trash</button>
      </div>
      ${realMode && (!canChangeConversation || senders.length && !canAddSender)
        ? '<p class="action-help">Reconnect in <button class="text-button" data-action="connections">Accounts</button> to allow mail actions and adding contacts.</p>' : ''}
      ${realMode && unconfirmed ? '<p class="action-help">Sync or resolve local send attempts before moving the conversation. Provider drafts are not managed here.</p>' : ''}
    </header>
    <div class="chat-timeline" tabindex="0" aria-label="Conversation history, oldest first">
      ${matchingMessages.length ? `<ol class="chat-messages">${bubbles}</ol>` : '<div class="empty-state conversation-no-results"><h3>No matching messages</h3><p>Try another search or clear it to see the full conversation.</p></div>'}
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

function renderMailbox(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup;
  const previous = [...app.children];
  const next = [...template.content.children];
  next.forEach((region, index) => {
    const current = previous[index];
    if (region.matches('.sidebar') && current?.matches('.sidebar')) {
      [...region.children].forEach((child, childIndex) => {
        const existing = current.children[childIndex];
        // Replacing or detaching a select closes its native account picker.
        if (child.matches('.sidebar-select') && existing.isEqualNode(child)) return;
        existing.replaceWith(child);
      });
    } else if (current) current.replaceWith(region);
    else app.append(region);
  });
  previous.slice(next.length).forEach(region => region.remove());
}

function render() {
  const existingFolderTree = document.querySelector('.provider-folders');
  if (existingFolderTree) providerFoldersOpen = existingFolderTree.open;
  disposeHtmlMessages();
  if (homeVisible) {
    pendingReads.clear();
    app.dataset.stage = 'home';
    app.innerHTML = homeScreen();
    return;
  }
  const activeSearch = document.activeElement?.id === 'search';
  const cursor = activeSearch ? document.activeElement.selectionStart : null;
  const scopedSearchFocused = document.activeElement?.id === 'conversation-search';
  const scopedCursor = scopedSearchFocused ? document.activeElement.selectionStart : null;
  const replyFocused = document.activeElement?.id === 'chat-reply';
  const replySelection = replyFocused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  if (folder.startsWith('provider:') && !currentFolder()) {
    resetAccountView();
    notify('That folder is no longer in the synced account. Returned to Inbox.');
  }
  if (!accounts.some((entry) => entry.id === account)) {
    account = accounts[0]?.id || '';
    resetAccountView();
  }
  if (realMode && folder === 'inbox') {
    folder = state.folders?.find((entry) => entry.accountId === account && (entry.kind === 'inbox' || entry.remoteId === 'INBOX'))?.id || folder;
  }
  const selectedMessage = state.messages.find((message) => message.id === selected);
  const selectedKey = selectedMessage ? conversationKey(selectedMessage) : null;
  const eligible = visibleConversations(state, { folder, account, query, audience });
  selected = eligible.find((conversation) => conversation.key === selectedKey)?.id || null;
  const messages = unreadOnly ? eligible.filter((conversation) => conversation.unread) : eligible;
  app.dataset.stage = folder === 'contacts' ? 'contacts' : selected ? 'reader' : folderChosen ? 'list' : 'folders';
  renderMailbox(`${brandRow()}
    <header class="topbar"><button class="compose-button desktop-compose" data-action="compose">${icon('plus')} New message</button><div class="search-wrap">${icon('search')}<input id="search" type="search" placeholder="${folder === 'contacts' ? 'Find your people...' : 'Search your conversations...'}" value="${escape(query)}" aria-label="${folder === 'contacts' ? 'Search contacts' : 'Search messages'}"><span class="search-key">/</span></div>
      <div class="sync-area"><button class="sync-button" data-action="sync" ${syncing || realBusy ? 'disabled' : ''}>${icon('sync', syncing || realBusy ? 'spinning' : '')} ${realMode ? conversationActionBusy ? 'Updating...' : sending ? 'Sending...' : realBusy ? 'Syncing...' : 'Sync mail' : syncing ? 'Syncing demo...' : 'Sync demo'}</button><span>${state.lastSync ? `Last ${realMode ? 'sync' : 'demo sync'} ${dateLabel(state.lastSync)} ${time(state.lastSync)}` : realMode ? 'Connect your accounts' : 'Sample mail & contacts'}</span></div>
    </header>
    ${sidebar()}<main class="main">
    ${storageError && !realMode ? `<div class="storage-error" role="alert">${escape(storageError)}</div>` : ''}
    <div class="real-status ${realMode && realError ? 'storage-error' : ''} ${realMode && realBusy ? 'sync-active' : ''}" role="${realMode && realError ? 'alert' : 'status'}">${escape(realMode ? realStatus || (accounts.length ? 'Cached mail is available offline. Reconnect to sync or send.' : 'No real accounts connected yet. Use Accounts to connect Gmail or Outlook.') : 'Sample mail and contacts. Connect your accounts to use real email.')} <button class="text-button" data-action="connections">Accounts</button>${realMode && realBusy && !sending && !conversationActionBusy ? '<button class="text-button" data-action="cancel-real-sync">Cancel</button>' : ''}</div>
    ${folder === 'contacts' ? `<button class="text-button folders-back" data-action="show-folders">${icon('back')} Folders</button>${contactsPage()}` : `${senderTabs()}<div id="conversation-results" role="tabpanel" aria-labelledby="sender-tab-${audience}" class="mail-workspace ${selected ? 'has-selection' : ''}">${messageList(messages)}${reader()}</div>`}
    <footer class="app-footer"><span><span class="status-dot"></span> Your inbox, a little more human.</span><span>${realMode ? 'Real mail · Local cache · Sending enabled with consent' : 'Sample data only. No email is sent. <button data-action="reset">Reset demo</button>'}</span></footer>
  </main>`);
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
  }, (message) => expandedQuotes.has(message.id) || revealQuotesForSearch(message) ? message.bodyHtml : messageQuoteContent(message).bodyHtml);
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
  if (scopedSearchFocused && document.querySelector('#conversation-search')) {
    const input = document.querySelector('#conversation-search');
    input.focus({ preventScroll: true });
    input.setSelectionRange(scopedCursor, scopedCursor);
  }
  if (pendingReads.size) queueMicrotask(markOpenedConversationsRead);
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

function revealConversation(message) {
  account = message.accountId;
  folder = state.folders?.find((entry) => entry.accountId === account && (entry.kind === 'sent' || entry.remoteId === 'SENT'))?.id || 'sent';
  folderChosen = true; selected = message.id; query = ''; unreadOnly = false;
  audience = findContact(state.contacts, conversationAddress(message)) ? 'contacts' : 'unknown';
  const group = findContact(state.contacts, conversationAddress(message))?.id || conversationAddress(message).trim().toLowerCase();
  expandedGroups.add(groupExpansionKey(group));
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

function openSenderContact(messageId) {
  const candidates = unknownSenders(state, messageId);
  if (!candidates.length) { notify('All received senders in this conversation are already contacts.'); return; }
  if (!realMode) { openContact(candidates[0].name, candidates[0].email); return; }
  const message = state.messages.find((entry) => entry.id === messageId);
  senderContext = { messageId, accountId: message.accountId, real: realMode, candidates };
  senderForm.reset();
  senderForm.querySelector('.form-error').textContent = '';
  senderForm.elements.sender.innerHTML = candidates.map((sender) =>
    `<option value="${escape(sender.email)}">${escape(sender.name)} &lt;${escape(sender.email)}&gt;</option>`).join('');
  senderForm.elements.name.value = candidates[0].name;
  document.querySelector('#sender-destination').textContent =
    `Create this contact in ${accounts.find((entry) => entry.id === message.accountId).email}. The provider's existing contacts will be checked first.`;
  senderDialog.showModal();
}

senderForm.elements.sender.addEventListener('change', () => {
  senderForm.elements.name.value = senderContext.candidates.find((sender) => sender.email === senderForm.elements.sender.value).name;
});
senderForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (conversationActionBusy || realBusy || sending || !senderContext) return;
  const context = senderContext;
  const email = senderForm.elements.sender.value;
  const name = senderForm.elements.name.value.trim();
  if (!name) { senderForm.querySelector('.form-error').textContent = 'Enter a contact name.'; return; }
  conversationActionBusy = true;
  [...senderForm.elements].forEach((element) => { element.disabled = true; });
  try {
    const result = await connections.actOnConversation(context.accountId, context.messageId, 'contact', { email, name });
    notify(result.warning || 'Sender added to provider contacts.');
    if (senderDialog.open && realMode === context.real && account === context.accountId && !homeVisible) {
      audience = 'contacts'; selected = context.messageId;
    }
    senderDialog.close();
  } catch (error) { senderForm.querySelector('.form-error').textContent = error.message; }
  finally {
    conversationActionBusy = false;
    [...senderForm.elements].forEach((element) => { element.disabled = false; });
    render();
  }
});

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
  if (event.target.id === 'conversation-search') {
    const message = state.messages.find((entry) => entry.id === selected);
    if (message) conversationSearches.set(conversationKey(message), event.target.value);
    render();
    return;
  }
  if (event.target.id === 'search') {
    query = event.target.value;
    render();
  }
  if (event.target.id === 'chat-reply') {
    const message = state.messages.find((entry) => entry.id === selected);
    if (message) replyDrafts.set(conversationKey(message), event.target.value);
  }
});

app.addEventListener('change', async (event) => {
  if (event.target.id === 'account-select') {
    const next = event.target.value;
    if (!accounts.some((entry) => entry.id === next)) return;
    account = next;
    resetAccountView();
    render();
    document.querySelector('#account-select')?.focus({ preventScroll: true });
  }
});

app.addEventListener('keydown', (event) => {
  const tab = event.target.closest('[data-audience]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 'contacts' : event.key === 'End' ? 'unknown'
    : tab.dataset.audience === 'contacts' ? 'unknown' : 'contacts';
  document.querySelector(`[data-audience="${next}"]`)?.click();
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
      conversationSearches.delete(key);
      notify(result.warning || 'Email accepted by the provider and added to the conversation.');
    } catch (error) { replyErrors.set(key, error.message); }
    finally { sending = false; render(); }
    document.querySelector('.chat-message:last-child')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  try {
    const updated = replyToConversation(state, selected, new FormData(event.target).get('body'));
    replyDrafts.delete(conversationKey(message));
    conversationSearches.delete(conversationKey(message));
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
  if (event.target.closest('a[data-home]')) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    showHome();
    return;
  }
  const button = event.target.closest('button[data-folder], button[data-provider-folder], button[data-toggle-provider-folder], button[data-audience], button[data-group], button[data-message], button[data-write], button[data-edit-contact], button[data-action]');
  if (!button) return;
  if (button.dataset.toggleProviderFolder) {
    const id = button.dataset.toggleProviderFolder;
    if (expandedFolderBranches.has(id)) expandedFolderBranches.delete(id); else expandedFolderBranches.add(id);
    render();
    [...app.querySelectorAll('button[data-toggle-provider-folder]')]
      .find((entry) => entry.dataset.toggleProviderFolder === id)?.focus({ preventScroll: true });
    return;
  }
  if (button.dataset.audience) {
    audience = button.dataset.audience;
    selected = null;
    render();
    document.querySelector(`[data-audience="${audience}"]`)?.focus({ preventScroll: true });
    return;
  }
  if (realMode && ['star', 'read', 'archive', 'reset'].includes(button.dataset.action)) {
    notify('Real accounts are read-only. No changes were made.');
    return;
  }
  if (button.dataset.providerFolder) {
    const target = state.folders?.find((entry) => entry.id === button.dataset.providerFolder);
    if (!target) { notify('This folder is no longer available. Sync to refresh the folder list.'); return; }
    account = target.accountId; selectFolder(target.id);
  } else if (button.dataset.folder) {
    selectFolder(button.dataset.folder);
  } else if (button.dataset.group) {
    const key = groupExpansionKey(button.dataset.group);
    if (expandedGroups.has(key)) expandedGroups.delete(key); else expandedGroups.add(key);
  } else if (button.dataset.message) {
    selected = button.dataset.message;
    folderChosen = true;
    if (!realMode) {
      conversationMessages(state, selected).forEach((message) => { message.unread = false; });
      persist();
    } else {
      const message = state.messages.find(entry => entry.id === selected);
      if (message) pendingReads.set(conversationKey(message), { accountId: message.accountId, messageId: message.id });
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
      case 'clear-conversation-search':
        if (message) conversationSearches.delete(conversationKey(message));
        render();
        document.querySelector('#conversation-search')?.focus({ preventScroll: true });
        return;
      case 'enter-demo':
      case 'enter-real':
        await switchMode(button.dataset.action === 'enter-real');
        document.querySelector('#account-select:not(:disabled), .desktop-compose')?.focus({ preventScroll: true });
        return;
      case 'connections': await connections.show(); return;
      case 'cancel-real-sync': connections.cancel(); return;
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
      case 'add-conversation-sender':
        if (realBusy || sending || conversationActionBusy || !message) return;
        openSenderContact(message.id);
        return;
      case 'archive-conversation':
      case 'trash-conversation': {
        if (realBusy || sending || syncing || conversationActionBusy || !message) return;
        const action = button.dataset.action === 'trash-conversation' ? 'trash' : 'archive';
        const providerName = accounts.find((entry) => entry.id === message.accountId)?.name || 'the provider';
        const scope = realMode ? `This updates the full conversation at ${providerName}, including messages outside the current search or cached date range.`
          : 'This affects every message in this demo conversation, not just search matches.';
        const detail = action === 'trash' ? 'Messages, including sent mail, will move to Trash / Deleted Items. Nothing will be permanently deleted.'
          : 'Received mail will be archived. Sent mail, drafts, spam, and deleted mail are kept in their current locations.';
        if (!confirm(`${action === 'trash' ? 'Move this conversation to Trash?' : 'Archive this conversation?'}\n\n${scope}\n\n${detail}`)) return;
        conversationActionBusy = true;
        render();
        try {
          if (realMode) {
            const result = await connections.actOnConversation(message.accountId, message.id, action);
            notify(result.warning || (action === 'trash' ? 'Conversation moved to Trash / Deleted Items.' : 'Conversation archived.'));
          } else {
            state = updateDemoConversation(state, message.id, action);
            persist();
            notify(action === 'trash' ? 'Demo conversation moved to Trash.' : 'Demo conversation archived.');
          }
        } catch (error) {
          if (realMode) { realStatus = error.message; realError = true; }
          notify(error.message);
        } finally { conversationActionBusy = false; render(); }
        return;
      }
      case 'add-sender': {
        const received = conversationMessages(state, selected).find((entry) => entry.folder !== 'sent');
        openContact(received.senderName, received.sender);
        return;
      }
      case 'about': notify(realMode ? 'Mail is cached on this device. Opening a conversation marks it read when authorized. Sending and moving conversations require your confirmation. No Gather backend is used.' : 'Demo accounts are fictional samples. Use Real mail to connect your own accounts.'); return;
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
      case 'show-folders':
        folderChosen = false; selected = null;
        if (folder === 'contacts') { folder = 'inbox'; query = ''; }
        break;
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
        account = accounts[0]?.id || '';
        resetAccountView();
        expandedGroups.clear();
        replyDrafts.clear();
        htmlConversations.clear();
        conversationSearches.clear();
        expandedQuotes.clear();
        for (const permission of imagePermissions.values()) permission.controller.abort();
        imagePermissions.clear();
        persist();
        notify('A fresh start. Demo data restored.');
        break;
    }
  }
  render();
  if (button.dataset.providerFolder || button.dataset.folder) document.querySelector('.conversation-navigation, .contacts-page')?.scrollIntoView({ block: 'start' });
  if (button.dataset.group) [...document.querySelectorAll('[data-group]')].find((entry) => entry.dataset.group === button.dataset.group)?.focus({ preventScroll: true });
  if (button.dataset.message) document.querySelector('.chat-reader')?.scrollIntoView({ block: 'start' });
  if (button.dataset.action === 'back') document.querySelector('.message-list')?.scrollIntoView({ block: 'start' });
  if (button.dataset.action === 'show-folders') document.querySelector('.brand-row')?.scrollIntoView({ block: 'start' });
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
  if (senderToAdd) audience = 'contacts';
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
      revealConversation(result.message);
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
  revealConversation(message);
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
    (selected ? document.querySelector('#conversation-search') : document.querySelector('#search'))?.focus();
  }
});

async function refreshRealMail() {
  if (homeVisible || !realMode || document.hidden || sending) return;
  try { await connections.syncWhenDue(); }
  catch (error) { realStatus = error.message; realError = true; render(); }
}
document.addEventListener('visibilitychange', refreshRealMail);
mobileLayout.addEventListener('change', () => render());
setInterval(refreshRealMail, 5 * 60000);
render();

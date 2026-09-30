import { isEmail } from './mail.js';

const DATABASE = 'gather-real-mail-v1';
const STORE = 'accounts';

export function isValidSnapshot(snapshot) {
  const text = (value) => typeof value === 'string';
  const date = (value) => text(value) && Number.isFinite(Date.parse(value));
  const account = snapshot?.account;
  return Boolean(snapshot?.version === 1 && account && ['gmail', 'outlook'].includes(account.provider)
    && text(account.id) && account.id.startsWith(`${account.provider}:`) && isEmail(account.email) && text(account.clientId)
    && date(snapshot.lastSync) && date(snapshot.since) && [7, 30, 90, 365].includes(snapshot.days)
    && snapshot.cursors && Object.values(snapshot.cursors).every(text)
    && Array.isArray(snapshot.messages) && Array.isArray(snapshot.contacts)
    && snapshot.messages.every((message) => message?.remote === true && message.accountId === account.id
      && text(message.id) && text(message.remoteId) && text(message.threadId) && message.threadId.length > 0
      && isEmail(message.sender) && isEmail(message.to) && text(message.senderName) && text(message.subject) && text(message.body)
      && date(message.date) && ['inbox', 'sent', 'archive'].includes(message.folder)
      && typeof message.unread === 'boolean' && typeof message.starred === 'boolean'
      && Array.isArray(message.participants) && message.participants.every(isEmail))
    && new Set(snapshot.messages.map((message) => message.id)).size === snapshot.messages.length
    && snapshot.contacts.every((contact) => contact && text(contact.id) && contact.accountId === account.id
      && text(contact.name) && text(contact.note) && ['sage', 'blue'].includes(contact.color)
      && contact.source === account.provider && Array.isArray(contact.emails) && contact.emails.length > 0 && contact.emails.every(isEmail)));
}

export function openMailboxStore(name = DATABASE) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'account.id' });
    request.onerror = () => reject(new Error(`Unable to open local mailbox storage: ${request.error?.message}`));
    request.onblocked = () => reject(new Error('Mailbox storage is blocked by another tab. Close other Gather tabs and retry.'));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      function run(mode, operation) {
        return new Promise((done, fail) => {
          const transaction = database.transaction(STORE, mode);
          const result = operation(transaction.objectStore(STORE));
          transaction.oncomplete = () => done(result.result);
          transaction.onabort = () => fail(new Error(`Local mailbox changes were not saved: ${transaction.error?.message || 'transaction aborted'}`));
          transaction.onerror = () => { /* The abort handler reports the transaction failure. */ };
        });
      }
      resolve({
        list: () => run('readonly', (store) => store.getAll()),
        save: (snapshot) => {
          if (!isValidSnapshot(snapshot)) return Promise.reject(new Error('Invalid mailbox import. Previous local data has not been replaced.'));
          return run('readwrite', (store) => store.put(snapshot));
        },
        remove: (id) => run('readwrite', (store) => store.delete(id)),
        close: () => database.close(),
      });
    };
  });
}

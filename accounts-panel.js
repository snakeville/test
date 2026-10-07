import { openMailboxStore, isValidSnapshot } from './mailbox-store.js';
import { importMailbox, combineSnapshots, PROVIDERS } from './provider-mail.js';
import { prepareSignIn, getAccountApi, forgetSession, hasSession, canSend, canManageMail, canManageContacts, mutationToken, sendingToken, validateClientId } from './auth.js';
import { prepareOutgoing, submitOutgoing, acceptedOutgoing, mergeLocalSends } from './email-send.js';
import { conversationMessages, findContact, isOutgoing, normalizeEmail } from './mail.js';
import { createActionRequest, changeProviderConversation, addProviderSender } from './conversation-actions.js';

const SETTINGS_KEY = 'gather-oauth-public-client-ids-v1';
const escape = (value) => String(value).replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function createAccountsPanel({ onChange, onStatus }) {
  const dialog = document.querySelector('#accounts-dialog');
  const form = document.querySelector('#connection-form');
  const providerField = form.elements.provider;
  const clientField = form.elements.clientId;
  const editClientButton = document.querySelector('#edit-provider-client');
  const clientHelp = document.querySelector('#provider-client-help');
  const daysField = form.elements.days;
  const prepareButton = document.querySelector('#prepare-provider');
  const connectButton = document.querySelector('#connect-provider');
  const feedback = document.querySelector('#connection-feedback');
  const list = document.querySelector('#connected-accounts');
  let store;
  let loading;
  let snapshots = [];
  let settings = {};
  let busy = false;
  let controller;
  let authorize;
  let expectedId = null;
  let lastAutomaticAttempt = 0;

  function status(message, error = false) {
    feedback.textContent = message;
    feedback.classList.toggle('form-error', error);
    onStatus(message, error, busy);
  }

  function publish() {
    onChange(combineSnapshots(snapshots));
    renderAccounts();
  }

  function setBusy(value) {
    busy = value;
    [...form.elements].forEach((element) => { element.disabled = value; });
    document.querySelector('#cancel-import').hidden = !value || !controller;
    renderAccounts();
    onStatus(feedback.textContent, feedback.classList.contains('form-error'), busy);
  }

  function renderAccounts() {
    list.innerHTML = snapshots.length ? snapshots.map((snapshot) => `<article class="connected-account">
      <div><strong>${escape(snapshot.account.email)}</strong><span>${PROVIDERS[snapshot.account.provider].name} · ${hasSession(snapshot.account.id) ? canSend(snapshot.account.id) ? 'Sync and sending authorized' : 'Sync authorized · Reconnect to enable sending' : 'Reconnect to sync or send'}</span>
      <span>Mail actions: ${canManageMail(snapshot.account.id) ? 'authorized' : 'reconnect required'} · Add contacts: ${canManageContacts(snapshot.account.id) ? 'authorized' : 'reconnect required'}</span>
      ${snapshot.pendingContact ? `<span>Contact creation unconfirmed. Check provider contacts and sync before retrying.</span>
      <button type="button" class="text-button" data-clear-contact-attempt="${escape(snapshot.account.id)}" ${busy ? 'disabled' : ''}>Clear unconfirmed contact attempt</button>` : ''}
      <small>${snapshot.messages.length} messages · ${snapshot.contacts.length} contacts · ${snapshot.folders?.length || 0} folders/labels<br>Mail since ${escape(new Date(snapshot.since).toLocaleDateString())}<br>Last synced ${escape(new Date(snapshot.lastSync).toLocaleString())}</small></div>
      <div class="connection-actions"><button type="button" class="text-button" data-reconnect="${escape(snapshot.account.id)}" ${busy ? 'disabled' : ''}>Reconnect</button>
      <button type="button" class="text-button" data-remove-account="${escape(snapshot.account.id)}" ${busy ? 'disabled' : ''}>Remove local data</button></div>
    </article>`).join('') : '<p class="muted">No real accounts imported yet. Demo data is stored separately.</p>';
  }

  async function initialize() {
    if (loading) return loading;
    loading = (async () => {
      if (!store) store = await openMailboxStore();
      snapshots = await store.list();
      if (snapshots.some((snapshot) => !isValidSnapshot(snapshot))) {
        throw new Error('Saved real-mail data is not supported. Clear this site\'s IndexedDB in browser settings and reconnect.');
      }
      publish();
    })();
    try { await loading; } finally { loading = null; }
  }

  function resetPrepared() {
    authorize = null;
    connectButton.hidden = true;
    prepareButton.hidden = false;
  }

  function configure(snapshot = null) {
    expectedId = snapshot?.account.id || null;
    providerField.disabled = false;
    if (snapshot) {
      providerField.value = snapshot.account.provider;
      daysField.value = String(snapshot.days);
    }
    clientField.value = settings[providerField.value] || '';
    clientField.readOnly = Boolean(clientField.value);
    editClientButton.hidden = !clientField.readOnly;
    clientHelp.textContent = clientField.readOnly
      ? `Saved ${PROVIDERS[providerField.value].name} application ID. Reused for every account of this type, including reconnects.`
      : `Enter the public ${PROVIDERS[providerField.value].name} application ID once. It will be reused for all accounts of this type.`;
    document.querySelector('#connection-target').textContent = snapshot
      ? `Reconnect ${snapshot.account.email}. Choose this same account in the sign-in window.`
      : 'Connect a new account. You can connect more than one account from each provider.';
    resetPrepared();
  }

  providerField.addEventListener('change', () => { configure(); });
  editClientButton.addEventListener('click', () => {
    if (busy) return;
    clientField.readOnly = false;
    editClientButton.hidden = true;
    clientHelp.textContent = 'The new application ID will be used for all future connections and reconnects of this provider. Existing mailboxes and active sessions are kept.';
    resetPrepared();
    clientField.focus();
  });
  clientField.addEventListener('input', resetPrepared);
  daysField.addEventListener('change', resetPrepared);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    try {
      const clientId = validateClientId(providerField.value, clientField.value);
      setBusy(true);
      status('Preparing sign-in. No mailbox data is requested until you press Connect.');
      authorize = await prepareSignIn(providerField.value, clientId);
      const updatedSettings = { ...settings, [providerField.value]: clientId };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(updatedSettings));
      settings = updatedSettings;
      clientField.readOnly = true;
      editClientButton.hidden = false;
      clientHelp.textContent = `Saved ${PROVIDERS[providerField.value].name} application ID. Reused for every account of this type, including reconnects.`;
      prepareButton.hidden = true;
      connectButton.hidden = false;
      status('Ready. Press Connect and import to open the provider sign-in window.');
    } catch (error) {
      resetPrepared();
      status(error.message, true);
    } finally {
      setBusy(false);
    }
  });

  async function saveImported(account, days) {
    const run = async () => {
      const previous = (await store.list()).find((snapshot) => snapshot.account.id === account.id);
      const snapshot = await importMailbox({
        account, previous, days, api: getAccountApi(account, controller.signal, (message) => status(message)),
        signal: controller.signal, progress: (message) => status(message),
      });
      controller.signal.throwIfAborted();
      mergeLocalSends(snapshot, previous);
      if (previous?.pendingContact && !findContact(snapshot.contacts, previous.pendingContact.email)) snapshot.pendingContact = previous.pendingContact;
      await store.save(snapshot);
      snapshots = [...snapshots.filter((entry) => entry.account.id !== account.id), snapshot];
      publish();
      return snapshot;
    };
    if (!navigator.locks) return run();
    return navigator.locks.request(`gather-mail-sync:${account.id}`, { ifAvailable: true }, (lock) => {
      if (!lock) throw new Error('This account is already syncing in another Gather tab. Wait for it to finish or cancel sync in that tab.');
      return run();
    });
  }

  connectButton.addEventListener('click', async () => {
    if (busy || !authorize) return;
    controller = new AbortController();
    setBusy(true);
    status('Waiting for provider sign-in...');
    try {
      const account = await authorize(controller.signal, expectedId);
      const snapshot = await saveImported(account, Number(daysField.value));
      status(`Imported ${snapshot.messages.length} messages, ${snapshot.contacts.length} contacts, and ${snapshot.folders.length} folders/labels. Open Real mail to read them.`);
      configure();
    } catch (error) {
      status(controller.signal.aborted ? 'Import cancelled. The previous cache is unchanged.' : error.message, !controller.signal.aborted);
    } finally {
      setBusy(false);
      controller = null;
    }
  });

  function cancel() {
    controller?.abort();
    status('Cancelling. Close any open provider sign-in window to finish.');
  }
  document.querySelector('#cancel-import').addEventListener('click', cancel);
  document.querySelector('#close-accounts').addEventListener('click', () => dialog.close());
  document.querySelector('#new-provider-account').addEventListener('click', () => { if (!busy) configure(); });
  list.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || busy) return;
    const snapshot = snapshots.find((entry) => entry.account.id === (button.dataset.reconnect || button.dataset.removeAccount || button.dataset.clearContactAttempt));
    if (!snapshot) return;
    if (button.dataset.reconnect) { configure(snapshot); return; }
    if (button.dataset.clearContactAttempt) {
      if (!confirm('Have you checked provider contacts and synced? Clear this local unconfirmed attempt only if the contact was not created. Retrying could otherwise create a duplicate. No provider contact will be deleted.')) return;
      setBusy(true);
      try {
        const clear = async () => {
          const latest = (await store.list()).find((entry) => entry.account.id === snapshot.account.id);
          if (!latest) throw new Error('This account no longer exists in the cache.');
          delete latest.pendingContact;
          await store.save(latest);
          snapshots = snapshots.map((entry) => entry.account.id === latest.account.id ? latest : entry);
          publish();
          status('Local contact attempt cleared. No provider contact was changed.');
        };
        if (!navigator.locks) await clear();
        else await navigator.locks.request(`gather-mail-sync:${snapshot.account.id}`, { ifAvailable: true }, async (lock) => {
          if (!lock) throw new Error('This account is busy in another Gather tab.');
          await clear();
        });
      } catch (error) { status(error.message, true); }
      finally { setBusy(false); }
      return;
    }
    if (!confirm(`Remove locally cached messages and contacts for ${snapshot.account.email}? Close other Gather tabs first so they cannot sync this data back. This will not change provider mail or revoke its consent.`)) return;
    setBusy(true);
    try {
      await store.remove(snapshot.account.id);
      snapshots = snapshots.filter((entry) => entry.account.id !== snapshot.account.id);
      publish();
      await forgetSession(snapshot.account.id);
      configure();
      status('Local account data removed. Provider permissions can be revoked on your Google or Microsoft account settings page.');
    } catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  });

  async function show() {
    dialog.showModal();
    document.querySelector('#google-origin').textContent = location.origin;
    document.querySelector('#microsoft-redirect').textContent = new URL('./oauth-redirect.html', document.baseURI).href;
    if (busy) return;
    setBusy(true);
    try {
      const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      settings = {};
      await initialize();
      for (const provider of Object.keys(PROVIDERS)) {
        const clientId = stored?.[provider] || snapshots.find(snapshot => snapshot.account.provider === provider)?.account.clientId;
        if (clientId) settings[provider] = validateClientId(provider, clientId);
      }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      configure();
    } catch (error) { status(`Unable to load account setup: ${error.message}`, true); }
    finally { setBusy(false); }
  }

  async function sync(accountId = 'all', automatic = false) {
    if (busy) return;
    controller = new AbortController();
    setBusy(true);
    const failures = [];
    let completed = 0;
    try {
      await initialize();
      const targets = snapshots.filter((snapshot) => (accountId === 'all' || snapshot.account.id === accountId)
        && (!automatic || hasSession(snapshot.account.id)));
      if (!targets.length) {
        if (!automatic) status('Connect or reconnect an account to sync real email. Open Accounts to continue.', true);
        return;
      }
      for (const snapshot of targets) {
        try { await saveImported(snapshot.account, snapshot.days); completed++; }
        catch (error) {
          if (controller.signal.aborted) break;
          failures.push(`${snapshot.account.email}: ${error.message}`);
        }
      }
      if (controller.signal.aborted) status('Sync cancelled. Completed accounts were saved; unfinished accounts keep their previous cache.');
      else if (failures.length) status(`${completed} account(s) synced. ${failures.join(' ')}`, true);
      else status(`Synced ${completed} account(s). Sync did not change mail at the provider.`);
    } finally {
      setBusy(false);
      controller = null;
    }
  }

  async function send(accountId, values) {
    if (busy) throw new Error('Wait for the current sync or send to finish before sending.');
    setBusy(true);
    try {
      if (!store) store = await openMailboxStore();
      const run = async () => {
        // Read again while holding the account lock so another tab's sends are not overwritten.
        snapshots = await store.list();
        const snapshot = snapshots.find((entry) => entry.account.id === accountId);
        if (!snapshot) throw new Error('Connect and sync this account before sending.');
        const getToken = sendingToken(snapshot.account);
        let parent = null;
        if (values.replyToId) {
          parent = snapshot.messages.find((message) => message.id === values.replyToId && !message.sendState);
          if (!parent || !conversationMessages({ messages: snapshot.messages }, parent.id).length) throw new Error('Sync this conversation before replying.');
        }
        let message = prepareOutgoing(snapshot, { ...values, parent });
        let updated = { ...snapshot, messages: [...snapshot.messages, message] };
        await store.save(updated);
        const publishAttempt = () => {
          snapshots = [...snapshots.filter((entry) => entry.account.id !== accountId), updated];
          publish();
        };
        publishAttempt();
        status('Sending real email. Do not close this tab or submit it again.');
        let result;
        try {
          result = await submitOutgoing(snapshot.account, message, parent, getToken);
        } catch (error) {
          message = { ...message, sendState: error.uncertain ? 'unknown' : 'failed', sendError: error.message };
          updated = { ...snapshot, messages: [...snapshot.messages, message] };
          let saveError = '';
          try { await store.save(updated); } catch { saveError = ' The send status could not be saved locally; check Sent at the provider before retrying.'; }
          publishAttempt();
          status(error.message + saveError, true);
          throw new Error(error.message + saveError);
        }
        message = acceptedOutgoing(snapshot, message, result);
        updated = { ...snapshot, messages: [...snapshot.messages, message] };
        let warning = '';
        try { await store.save(updated); }
        catch { warning = 'The provider accepted this email, but its sent status could not be saved locally. Do not resend; sync to recover it.'; }
        publishAttempt();
        status(warning || 'Email accepted by the provider. Delivery is not guaranteed; sync will confirm its Sent copy.', Boolean(warning));
        return { message, warning };
      };
      if (!navigator.locks) return await run();
      return await navigator.locks.request(`gather-mail-sync:${accountId}`, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('This account is busy in another Gather tab. Wait before sending.');
        return run();
      });
    } finally { setBusy(false); }
  }

  async function removeSendAttempt(accountId, messageId) {
    if (busy) throw new Error('Wait for the current sync or send to finish.');
    setBusy(true);
    try {
      const run = async () => {
        if (!store) store = await openMailboxStore();
        snapshots = await store.list();
        const snapshot = snapshots.find((entry) => entry.account.id === accountId);
        const attempt = snapshot?.messages.find((message) => message.id === messageId);
        if (!attempt || !['sending', 'unknown', 'failed'].includes(attempt.sendState)) {
          throw new Error('This is not an unconfirmed local send attempt. Sync to refresh its status.');
        }
        const updated = { ...snapshot, messages: snapshot.messages.filter((message) => message.id !== messageId) };
        await store.save(updated);
        snapshots = snapshots.map((entry) => entry.account.id === accountId ? updated : entry);
        publish();
        status('Local send attempt removed after your confirmation. No provider email was changed or recalled.');
      };
      if (!navigator.locks) return await run();
      return await navigator.locks.request(`gather-mail-sync:${accountId}`, { ifAvailable: true }, (lock) => {
        if (!lock) throw new Error('This account is busy in another Gather tab.');
        return run();
      });
    } finally { setBusy(false); }
  }

  async function actOnConversation(accountId, messageId, action, values = {}) {
    if (busy) throw new Error('Wait for the current sync, send, or conversation action to finish.');
    if (!['contact', 'archive', 'trash', 'read'].includes(action)) throw new Error('Unsupported conversation action.');
    setBusy(true);
    try {
      if (!store) store = await openMailboxStore();
      const run = async () => {
        snapshots = await store.list();
        let snapshot = snapshots.find((entry) => entry.account.id === accountId);
        if (!snapshot || !isValidSnapshot(snapshot)) throw new Error('Connect and sync this account before changing it.');
        const api = getAccountApi(snapshot.account, undefined, (message) => status(message));
        const request = createActionRequest(mutationToken(snapshot.account, action === 'contact' ? 'contact' : 'mail'), snapshot.account.provider);
        const publishSnapshot = () => {
          snapshots = snapshots.map((entry) => entry.account.id === accountId ? snapshot : entry);
          publish();
        };
        const saveAndPublish = async () => {
          await store.save(snapshot);
          publishSnapshot();
        };
        if (action === 'contact') {
          const source = conversationMessages(snapshot, messageId).find((message) => !isOutgoing(message)
            && normalizeEmail(message.sender) === normalizeEmail(values.email || ''));
          if (!source) throw new Error('Choose a sender from this conversation.');
          status('Checking provider contacts before adding the sender...');
          let creationStarted = false;
          try {
            const result = await addProviderSender(snapshot, source.sender, values.name, api, request, async (email) => {
              snapshot = { ...snapshot, pendingContact: { email, name: values.name.trim() } };
              await saveAndPublish();
              creationStarted = true;
              status('Adding sender to provider contacts...');
            });
            snapshot = { ...snapshot, contacts: result.contacts };
            if (snapshot.pendingContact?.email === result.contact.emails[0]) delete snapshot.pendingContact;
            try { await saveAndPublish(); }
            catch {
              publishSnapshot();
              const warning = 'The contact exists at the provider, but its local cache could not be saved. Sync before adding it again.';
              status(warning, true);
              return { warning, contact: result.contact };
            }
            status(result.existing ? 'Sender is already in provider contacts. Local contacts refreshed.' : 'Sender added to provider contacts.');
            return { contact: result.contact, warning: '' };
          } catch (error) {
            // A known rejection is safe to retry. Preserve uncertain creation markers across reloads.
            let persistenceWarning = '';
            if (creationStarted && !error.uncertain && snapshot.pendingContact?.email === source.sender) {
              snapshot = { ...snapshot };
              delete snapshot.pendingContact;
              try { await saveAndPublish(); } catch {
                publishSnapshot();
                persistenceWarning = ' The local action status could not be saved. Check provider contacts and sync before retrying.';
              }
            }
            status(error.message + persistenceWarning, true);
            throw new Error(error.message + persistenceWarning);
          }
        }
        let result, failure;
        status(action === 'read' ? 'Marking conversation as read...' : action === 'trash' ? 'Moving conversation to Trash / Deleted Items...' : 'Archiving conversation...');
        try { result = await changeProviderConversation(snapshot, messageId, action, api, request, (message) => status(message)); }
        catch (error) { failure = error; result = { updates: error.updates || [], destination: error.destination }; }
        let saveWarning = '';
        if (result.updates?.length) {
          const updates = new Map(result.updates.map((message) => [message.previousId || message.id, message]));
          const folders = [...(snapshot.folders || [])];
          if (result.destination && !folders.some((folder) => folder.id === result.destination.id)) folders.push(result.destination);
          snapshot = { ...snapshot, folders, messages: snapshot.messages.map((message) => {
            const updated = updates.get(message.id);
            if (!updated) return message;
            const { previousId, ...clean } = updated;
            return clean;
          }) };
          try { await saveAndPublish(); } catch { publishSnapshot(); saveWarning = ' Confirmed changes could not be saved locally.'; }
        }
        if (action === 'read') {
          if (failure) {
            const message = failure.message + saveWarning;
            status(message, true);
            throw new Error(message);
          }
          const summary = 'Conversation marked as read.' + saveWarning;
          status(summary, Boolean(saveWarning));
          return { warning: saveWarning ? summary + ' Sync again to refresh the cache.' : '', changed: result.changed };
        }
        status('Refreshing the mailbox after the conversation action...');
        let refreshError = '';
        try {
          const fresh = await importMailbox({ account: snapshot.account, previous: snapshot, days: snapshot.days, api,
            progress: (message) => status(message) });
          mergeLocalSends(fresh, snapshot);
          if (snapshot.pendingContact && !findContact(fresh.contacts, snapshot.pendingContact.email)) fresh.pendingContact = snapshot.pendingContact;
          snapshot = fresh;
          await saveAndPublish();
          saveWarning = '';
        } catch (error) { refreshError = `${saveWarning} Refresh failed: ${error.message} The cache may be incomplete; sync again.`; }
        if (failure) {
          const message = failure.message + refreshError;
          status(message, true);
          throw new Error(message);
        }
        const summary = result.changed ? action === 'trash' ? 'Conversation moved to Trash / Deleted Items. Nothing was permanently deleted.' : 'Conversation archived.'
          : 'No messages needed to be moved.';
        status(summary + refreshError, Boolean(refreshError));
        return { warning: refreshError ? summary + refreshError : '', changed: result.changed };
      };
      if (!navigator.locks) return await run();
      return await navigator.locks.request(`gather-mail-sync:${accountId}`, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('This account is busy in another Gather tab. Wait before changing the conversation.');
        return run();
      });
    } finally { setBusy(false); }
  }

  return {
    show, initialize, sync, send, removeSendAttempt, actOnConversation, isBusy: () => busy,
    cancel,
    async syncWhenDue() {
      if (busy || document.hidden || Date.now() - lastAutomaticAttempt < 5 * 60000) return;
      lastAutomaticAttempt = Date.now();
      await sync('all', true);
    },
  };
}

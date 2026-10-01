import { openMailboxStore, isValidSnapshot } from './mailbox-store.js';
import { importMailbox, combineSnapshots, PROVIDERS } from './provider-mail.js';
import { prepareSignIn, getAccountApi, forgetSession, hasSession, canSend, sendingToken, validateClientId } from './auth.js';
import { prepareOutgoing, submitOutgoing, acceptedOutgoing, mergeLocalSends } from './email-send.js';
import { conversationMessages } from './mail.js';

const SETTINGS_KEY = 'gather-oauth-public-client-ids-v1';
const escape = (value) => String(value).replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function createAccountsPanel({ onChange, onStatus }) {
  const dialog = document.querySelector('#accounts-dialog');
  const form = document.querySelector('#connection-form');
  const providerField = form.elements.provider;
  const clientField = form.elements.clientId;
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
      <div><strong>${escape(snapshot.account.email)}</strong><span>${PROVIDERS[snapshot.account.provider].name} · ${hasSession(snapshot.account.id) ? canSend(snapshot.account.id) ? 'Sync and sending authorized' : 'Read-only · Reconnect to enable sending' : 'Reconnect to sync or send'}</span>
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
      clientField.value = snapshot.account.clientId;
      daysField.value = String(snapshot.days);
    } else clientField.value = settings[providerField.value] || '';
    document.querySelector('#connection-target').textContent = snapshot
      ? `Reconnect ${snapshot.account.email}. Choose this same account in the sign-in window.`
      : 'Connect a new account. You can connect more than one account from each provider.';
    resetPrepared();
  }

  providerField.addEventListener('change', () => { configure(); });
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
      settings = { ...settings, [providerField.value]: clientId };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
      const previous = snapshots.find((snapshot) => snapshot.account.id === account.id);
      const snapshot = await importMailbox({
        account, previous, days, api: getAccountApi(account, controller.signal, (message) => status(message)),
        signal: controller.signal, progress: (message) => status(message),
      });
      controller.signal.throwIfAborted();
      mergeLocalSends(snapshot, previous);
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
    const snapshot = snapshots.find((entry) => entry.account.id === (button.dataset.reconnect || button.dataset.removeAccount));
    if (!snapshot) return;
    if (button.dataset.reconnect) { configure(snapshot); return; }
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
      settings = stored && typeof stored === 'object' ? stored : {};
      await initialize();
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

  return {
    show, initialize, sync, send, removeSendAttempt, isBusy: () => busy,
    cancel,
    async syncWhenDue() {
      if (busy || document.hidden || Date.now() - lastAutomaticAttempt < 5 * 60000) return;
      lastAutomaticAttempt = Date.now();
      await sync('all', true);
    },
  };
}

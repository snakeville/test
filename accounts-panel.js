import { openMailboxStore, isValidSnapshot } from './mailbox-store.js';
import { importMailbox, combineSnapshots, PROVIDERS } from './provider-mail.js';
import { prepareSignIn, getAccountApi, forgetSession, hasSession, validateClientId } from './auth.js';

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
      <div><strong>${escape(snapshot.account.email)}</strong><span>${PROVIDERS[snapshot.account.provider].name} · ${hasSession(snapshot.account.id) ? 'Authorized in this tab' : 'Reconnect to sync'}</span>
      <small>${snapshot.messages.length} messages · ${snapshot.contacts.length} contacts<br>Mail since ${escape(new Date(snapshot.since).toLocaleDateString())}<br>Last synced ${escape(new Date(snapshot.lastSync).toLocaleString())}</small></div>
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
    const previous = snapshots.find((snapshot) => snapshot.account.id === account.id);
    const snapshot = await importMailbox({
      account, previous, days, api: getAccountApi(account, controller.signal),
      signal: controller.signal, progress: (message) => status(message),
    });
    controller.signal.throwIfAborted();
    await store.save(snapshot);
    snapshots = [...snapshots.filter((entry) => entry.account.id !== account.id), snapshot];
    publish();
    return snapshot;
  }

  connectButton.addEventListener('click', async () => {
    if (busy || !authorize) return;
    controller = new AbortController();
    setBusy(true);
    status('Waiting for provider sign-in...');
    try {
      const account = await authorize(controller.signal, expectedId);
      const snapshot = await saveImported(account, Number(daysField.value));
      status(`Imported ${snapshot.messages.length} messages and ${snapshot.contacts.length} contacts. Open Real mail to read them.`);
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
      else status(`Synced ${completed} account(s). Real mail is read-only; nothing was changed at the provider.`);
    } finally {
      setBusy(false);
      controller = null;
    }
  }

  return {
    show, initialize, sync, isBusy: () => busy,
    cancel,
    async syncWhenDue() {
      if (busy || document.hidden || Date.now() - lastAutomaticAttempt < 5 * 60000) return;
      lastAutomaticAttempt = Date.now();
      await sync('all', true);
    },
  };
}

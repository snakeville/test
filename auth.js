import { createApi, identifyAccount, ProviderError } from './provider-mail.js';

const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/contacts.readonly'];
const MICROSOFT_SCOPES = ['User.Read', 'Mail.Read', 'Contacts.Read'];
const GOOGLE_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const sessions = new Map();
const libraries = new Map();

function loadScript(source, ready) {
  if (ready()) return Promise.resolve();
  if (libraries.has(source)) return libraries.get(source);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = source;
    script.referrerPolicy = 'no-referrer';
    const timeout = setTimeout(() => finish(new Error('Authentication library timed out. Check your connection and try again.')), 20000);
    function finish(error) {
      clearTimeout(timeout);
      if (error) {
        libraries.delete(source);
        script.remove();
        reject(error);
      } else resolve();
    }
    script.onload = () => finish(ready() ? null : new Error('Authentication library could not initialize.'));
    script.onerror = () => finish(new Error('Authentication library could not load. Check browser privacy settings and your connection.'));
    document.head.append(script);
  });
  libraries.set(source, promise);
  return promise;
}

export function validateClientId(provider, value) {
  const id = value.trim();
  const valid = provider === 'gmail' ? /^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(id)
    : provider === 'outlook' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (!valid) throw new Error(`Enter a valid ${provider === 'gmail' ? 'Google OAuth client ID' : 'Microsoft application (client) ID'}, not a client secret.`);
  return id;
}

export function hasSession(accountId) {
  const session = sessions.get(accountId);
  return Boolean(session && (!session.expiresAt || Date.now() < session.expiresAt));
}

export function getAccountApi(account, signal, onWait) {
  const session = sessions.get(account.id);
  if (!hasSession(account.id)) throw new ProviderError('Reconnect this account to sync. Cached messages are still available.');
  return createApi(session.getToken, account.provider, signal, fetch, { onWait });
}

export function canSend(accountId) {
  return hasSession(accountId) && sessions.get(accountId).canSend === true;
}

export function sendingToken(account) {
  if (!canSend(account.id)) throw new ProviderError('Reconnect this account and grant sending permission before sending real email.');
  return () => {
    if (!canSend(account.id)) throw new ProviderError('Authorization expired. Reconnect with sending permission.');
    return sessions.get(account.id).getToken(true);
  };
}

export async function forgetSession(id) {
  const session = sessions.get(id);
  sessions.delete(id);
  if (session?.clear) await session.clear();
}

export async function prepareSignIn(provider, inputId) {
  if (!window.isSecureContext) throw new Error('OAuth requires HTTPS or a localhost development origin.');
  const clientId = validateClientId(provider, inputId);
  let authorize;
  if (provider === 'gmail') {
    await loadScript('https://accounts.google.com/gsi/client', () => Boolean(window.google?.accounts?.oauth2));
    authorize = () => new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId, scope: [...GOOGLE_SCOPES, GOOGLE_SEND_SCOPE].join(' '),
        include_granted_scopes: false,
        callback: (response) => {
          if (response.error) { reject(new Error(`Google authorization failed (${response.error}).`)); return; }
          if (!google.accounts.oauth2.hasGrantedAllScopes(response, ...GOOGLE_SCOPES)) {
            reject(new Error('Both read-only Gmail and contacts permissions are required. Reconnect and grant both permissions.'));
            return;
          }
          if (!response.access_token || !Number.isFinite(Number(response.expires_in)) || Number(response.expires_in) <= 0) {
            reject(new Error('Google returned incomplete authorization. Please reconnect.'));
            return;
          }
          const expires = Date.now() + Number(response.expires_in) * 1000 - 60000;
          resolve({ canSend: google.accounts.oauth2.hasGrantedAllScopes(response, GOOGLE_SEND_SCOPE), expiresAt: expires, getToken: async () => {
            if (Date.now() >= expires) throw new ProviderError('Gmail authorization expired. Reconnect Gmail to continue syncing.');
            return response.access_token;
          } });
        },
        error_callback: (error) => reject(new Error(error.type === 'popup_closed'
          ? 'Google sign-in was cancelled. Your existing cache is unchanged.'
          : 'Google sign-in could not open. Allow popups or open Gather in a regular browser.')),
      });
      client.requestAccessToken({ prompt: 'select_account' });
    });
  } else {
    await loadScript('./vendor/msal-browser/lib/msal-browser.min.js', () => Boolean(window.msal?.PublicClientApplication));
    const instance = new msal.PublicClientApplication({
      auth: {
        clientId, authority: 'https://login.microsoftonline.com/common',
        redirectUri: new URL('./oauth-redirect.html', document.baseURI).href,
      },
      cache: { cacheLocation: 'memoryStorage', temporaryCacheLocation: 'memoryStorage' },
      system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } },
    });
    await instance.initialize();
    authorize = () => instance.acquireTokenPopup({ scopes: [...MICROSOFT_SCOPES, 'Mail.Send'], prompt: 'select_account' }).then((result) => ({
      canSend: result.scopes?.some((scope) => scope.toLowerCase().replace('https://graph.microsoft.com/', '') === 'mail.send') === true,
      getToken: async (forSending = false) => {
        try {
          const token = await instance.acquireTokenSilent({ scopes: forSending ? [...MICROSOFT_SCOPES, 'Mail.Send'] : MICROSOFT_SCOPES, account: result.account });
          return token.accessToken;
        } catch (error) {
          if (error instanceof msal.InteractionRequiredAuthError) throw new ProviderError('Microsoft needs authorization again. Reconnect this account.');
          throw new ProviderError('Microsoft token renewal failed. Reconnect this account and try again.');
        }
      },
      clear: () => instance.clearCache({ account: result.account }),
    }));
  }
  // The returned function must be called directly from the Connect button gesture.
  return async (signal, expectedId = null) => {
    const session = await authorize();
    try {
      signal?.throwIfAborted();
      const api = createApi(session.getToken, provider, signal);
      const account = await identifyAccount(provider, api, clientId);
      if (expectedId && expectedId !== account.id) throw new ProviderError('You selected a different account. Choose the original account to reconnect.');
      sessions.set(account.id, session);
      return account;
    } catch (error) {
      if (session.clear) await session.clear();
      throw error;
    }
  };
}

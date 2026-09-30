# Gather

A responsive, contact-first email client for the browser. Includes a sample-data
demo and an opt-in **read-only Gmail/Outlook connection**, with no application
backend and no build step. Google Identity Services handles Google authorization;
a pinned, locally vendored MSAL Browser SDK handles Microsoft authorization.
System fonts are used; there are no third-party fonts or analytics.

## Run

On Windows, start the local server from the repository directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\serve.ps1
```

Open http://127.0.0.1:5173. On other platforms, any static HTTP server works,
for example `python3 -m http.server 5173 --bind 127.0.0.1`.
JavaScript modules require HTTP; do not open `index.html` as a file.
Keep the serving terminal running. This process only serves static files; it
does not receive OAuth tokens or process email. Any HTTPS static host can serve
the same files, including the `vendor` directory and `oauth-redirect.html`.

## Demo behavior

- Sample Gmail and Outlook.com accounts share a unified inbox, with account filters.
- Inbox messages are grouped by known contact, including contacts with multiple
  email addresses. Matching is case-insensitive and uses exact email addresses,
  not display names. Contacts are shared across the unified inbox.
- Each topic opens as a chat: received messages appear on the left and local sent
  messages on the right, oldest first, with timestamps and date dividers.
  The list shows one card per conversation, its latest message, and message count.
  Folder badges count conversations rather than individual emails.
- Replies are written inline and saved to both the conversation and demo Sent
  without leaving the chat. The reply uses the conversation's account and exact
  correspondent address. Unsaved replies stay in memory while switching topics
  but are lost on reload; saved replies persist in browser storage.
- Folder and account filters determine which conversations appear. Opening a
  conversation shows its complete received/sent/archived history, and search
  includes sent replies even from the inbox. Opening it marks its messages read;
  unread filtering does not close the chat being read. Star, read/unread, and
  archive/restore actions beneath each bubble affect that individual message.
- Existing sample/locally saved messages without thread IDs are matched by account,
  exact correspondent email, and subject (case-insensitive, ignoring leading
  `Re:` prefixes). Different addresses/accounts never share a topic. New messages
  started with **New message** get a distinct thread ID, even with an identical
  subject; replies retain that ID. This demo fallback is not a replacement for
  provider thread IDs and email reply headers in a real integration.
- Fresh demo data includes a sent reply in Maya's getaway conversation. Existing
  saved data is preserved; write an inline reply to try the chat without resetting.
- Unknown senders appear only in the **Unknown senders** subfolder. Adding their
  address to contacts immediately reclassifies all their inbox messages.
- In **Contacts**, use **Edit contact** to rename someone or add, change, and remove
  their email addresses. New contacts can also have multiple addresses. At least
  one valid address is required, and addresses cannot be repeated within a contact
  or shared by different contacts (ignoring case and surrounding whitespace).
- From an unknown message, **Add contact** lets you create a new contact or add the
  sender's address to an existing one. Click any address on a contact card to
  compose a demo message to that specific address.
- Saving contact edits immediately updates inbox groups and search. Removing an
  address returns its inbox messages to **Unknown senders**; message contents,
  read/starred states, and archived/sent folders are unchanged. Cancel discards
  edits. Local contact edits persist across reloads and simulated syncs, and are
  never written to Google or Microsoft.
- Search, unread filtering, starring, archiving/restoring, contact creation,
  local demo sending/replying, and responsive message reading work.
- **Sync demo** simulates importing one new email and contact from each provider.
  Repeated syncs do not duplicate imported records. Existing read/archive states
  are preserved.
- Changes persist in this browser's local storage. **Reset demo** restores sample
  data. Storage errors are shown rather than silently ignored.

**Demo mode never connects or sends email.** All sample identities and message
content are fictional. Real mode is separate and requires explicit account
authorization. Real sending and provider-side changes are not implemented.

## Checks

With the server running, open http://127.0.0.1:5173/tests.html.
The dependency-free browser tests cover contact matching, grouping, filtering,
unknown-sender reclassification, account isolation, sync idempotence, and storage
validation, including multi-address contact editing, duplicate-address checks,
conversation grouping, chronological order, account isolation, and inline replies.
Open http://127.0.0.1:5173/ui-tests.html for button-click regression checks, including
Save reply validation, provider onboarding, partial consent, read-only controls,
sync failures, cancellation, mode separation, and local account removal. They use
mock authentication/API responses and a disposable IndexedDB database; they do
not modify your saved mail or call real mail APIs.

Open http://127.0.0.1:5173/provider-tests.html for async adapter, pagination,
incremental sync, expired cursor, account mismatch, MIME/HTML conversion, token
handling, and IndexedDB checks. These also use mock providers and a disposable
database. Run this page in a normal browser; headless virtual-time DOM snapshots
can finish before asynchronous IndexedDB work does.

Actual OAuth consent and authenticated provider API access require your own
registered client IDs and accounts. Mock checks do not verify a registration,
organizational consent policy, or a live mailbox.

## Real account integrations

### Connect an account

1. Click **Connect Gmail or Outlook** (or **Real mail → Manage accounts**).
2. Select the provider, enter its **public client ID**, and choose the initial
   mail range: 7, 30, 90, or 365 days.
3. Click **Prepare sign-in**, then **Connect and import**. Preparation loads the
   provider SDK but does not read your mailbox. The separate Connect click
   preserves the browser gesture needed to open the sign-in popup.
4. Sign in at Google/Microsoft and grant the requested read-only permissions.
   Both mail and contacts access are required. Use a regular browser if the app's
   embedded preview blocks popups or provider authentication.
5. Switch to **Real mail**. Each account's import is saved only after its mail
   and contacts complete successfully. Cancelled/failed imports leave that
   account's previous cache unchanged. Other successfully synced accounts are
   committed independently.

You can connect multiple accounts from either provider. **Reconnect** requires
choosing the same account; an accidental different-account sign-in is rejected
instead of overwriting its cache. **Connect another account** adds a new one.

### Google registration

1. Create/select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Gmail API** and **People API**.
3. Configure Google Auth Platform's branding, audience, and data access. For
   development with an external app, add your Google account as a test user.
4. Create an OAuth client of type **Web application**. Add the exact
   **Authorized JavaScript origin** displayed in Gather's setup panel, e.g.
   `http://127.0.0.1:5173`. Add your HTTPS origin separately for deployment.
   Google's browser token model does not use our Microsoft redirect page.
5. Add the scopes `https://www.googleapis.com/auth/gmail.readonly` and
   `https://www.googleapis.com/auth/contacts.readonly`. Paste only the client ID,
   ending in `.apps.googleusercontent.com`, into Gather.

The browser receives a short-lived access token, not a Google refresh token.
When it expires, reconnect through a user gesture. Google may require app
verification before public distribution because Gmail read access is restricted;
personal/testing exceptions and account limits apply. Keeping restricted data
off your servers does not automatically remove verification requirements.

### Microsoft registration

1. Create an app registration in [Microsoft Entra](https://entra.microsoft.com/).
   Select an audience that includes **personal Microsoft accounts** for
   Outlook.com. To also support work/school mail, choose accounts in any
   organizational directory and personal Microsoft accounts.
2. Under Authentication, add a **Single-page application** platform with the
   exact redirect URI shown in Gather, e.g.
   `http://127.0.0.1:5173/oauth-redirect.html`. Add the deployed HTTPS URI separately.
3. Add delegated Microsoft Graph permissions **User.Read**, **Mail.Read**, and
   **Contacts.Read**. Your organization may require administrator consent.
   Do not enable implicit grant or create/use a client secret.
4. Paste the Application (client) ID (a UUID) into Gather.

MSAL Browser uses authorization code + PKCE and maintains tokens in memory.
Renewal can be silent while authorization remains valid, but interaction may
be required by expiry, policy, or browser privacy controls. Reloading the page
clears the in-memory authorization and requires reconnecting to sync.

The MSAL v5 redirect page contains only the required redirect bridge scripts.
Do **not** add a `Cross-Origin-Opener-Policy` header to that page. Its URI must
match the registration exactly, including hostname, path, scheme, and port.

### What is synced

| Provider | Mail | Contacts |
| --- | --- | --- |
| Gmail | Mail since the chosen start date, excluding Spam, Trash, and Drafts. INBOX/SENT labels determine the view; remaining messages appear as Archive. Gmail `historyId` is used for subsequent changes. | Google People `connections`, including all pages with email addresses; refreshed on each sync. Other Contacts and Workspace directory searches are not included. |
| Outlook | Inbox, Sent Items, and the standard Archive folder since the chosen start date; other custom folders, Junk, Deleted Items, and Drafts are not included. Folder delta links and immutable message IDs track changes. | The default Outlook contacts folder, including all pages; refreshed on each sync. Organizational directory and custom contact folders are not included. |

Initial imports follow pagination; there is no silent client-side message limit.
Large imports can take time and use considerable local storage. The chosen start
date stays fixed for incremental sync. Reconnect with a different range to rebuild
from a different starting date. Microsoft limits filtered delta queries to 5,000
messages; folders reaching that threshold switch to regular full pagination on
this and later syncs instead of silently truncating the mailbox.

Expired Gmail history/Outlook delta cursors trigger a visible rebuild of the
affected cache. Rate limits and service-unavailable responses receive bounded
retries; permission, network, malformed response, and storage errors are shown.
The app syncs manually and, while **Real mail** is visible, every five minutes or
when returning to the tab (at most once per five minutes). Automatic sync uses
only accounts authorized in this tab and never opens a login popup. It cannot
run reliably while the browser/app is closed.

Real conversations use **account + provider thread ID**, not subject matching.
Multi-person threads remain together; their participant addresses are shown.
History is limited to imported folders and the selected date range, so it may
not contain every message in the provider's full thread. Folder placement is
based on matching imported messages, so a mixed-sender thread can be accessible
from more than one view. Unknown senders is a virtual view, not a provider folder.
Imported contacts with overlapping addresses are merged in the display without
modifying either provider's address book.

Real mode is strictly **read-only**: opening a message does not mark it read,
and send, star, archive, and contact-edit controls are absent. Make changes in
Google/Microsoft and sync to see them here. Demo sending remains demo-only.

### Local data and browser safety

- Real accounts, text message bodies, contacts, and sync cursors are stored in
  IndexedDB database `gather-real-mail-v1`. Demo data remains in its original
  localStorage key. Only public OAuth client IDs are saved to the real-account
  localStorage settings key; access/refresh tokens are not stored there or in
  the mailbox database.
- Tokens are held only in memory. **Remove local data** deletes the account's
  IndexedDB record and drops its active authorization from this tab. It does not
  delete provider mail or revoke provider consent. Close other open Gather tabs
  when removing data; they may still hold their own in-memory copies and sessions.
  Revoke consent separately in Google/Microsoft account settings when desired.
- IndexedDB is **not encrypted by this app** and is accessible to scripts running
  on the same origin. Use a dedicated static-host origin, a private OS/browser
  profile, and a trusted device. Do not host untrusted scripts on that origin.
  Browser clearing, eviction, private-browsing restrictions, or quota limits
  can remove/prevent the cache. The cache is not a backup.
- Real HTML email is converted inside an inert template and displayed as escaped
  text. Remote images, scripts, active links, embedded resources, and attachment
  downloads are not rendered. Large Gmail bodies stored as attachment objects
  receive an explicit placeholder rather than being silently shown as complete.
  Complex HTML formatting and encoded display-name headers are not fully retained.
- Provider requests are GET-only, omit cookies, reject redirects, and restrict
  bearer tokens to the expected Google/Microsoft API origins. Third-party fonts
  and analytics are not loaded. Google's SDK loads only after preparation;
  Microsoft's SDK is served locally.
- `index.html` includes a restrictive Content Security Policy, and the bundled
  static server sends `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`. Replicate these headers on deployment.
  Add `frame-ancestors 'self'` as an HTTP CSP header where appropriate for your
  hosting/embedding requirements. Do not weaken script policy to display email.

This is an initial local-first integration, not a production security
certification. Public distribution needs provider approval where applicable,
privacy disclosures, and a deployment/security review. There is no hosted
background worker, cross-device data sync, real sending, or provider-side editing.

### SDK provenance and implementation

`vendor/manifest.json` pins MSAL Browser **5.23.0** to its npm release and SHA-512
integrity value; its browser bundle, redirect bridge, and license are vendored.
To restore those exact files on Windows, run `.\restore-sdk.ps1`. This verifies
the package checksum before extracting the selected files. Google requires its
Identity Services script to load from `https://accounts.google.com/gsi/client`.

- `auth.js`: provider SDK setup and in-memory authorization.
- `provider-mail.js`: GET-only transport, provider normalization, pagination,
  incremental mail sync, and imported-contact grouping.
- `mailbox-store.js`: atomic per-account IndexedDB snapshots.
- `accounts-panel.js`: connection, reconnect, sync, and removal UI.
- `mail.js` / `app.js`: shared views and separate real/demo modes.

References: [Google browser token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model),
[Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync),
[Microsoft message delta](https://learn.microsoft.com/en-us/graph/api/message-delta),
[MSAL v5 redirect bridge](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/redirect-bridge).

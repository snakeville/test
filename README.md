# Gather

A responsive, contact-first email client for the browser. Includes a sample-data
demo and opt-in **Gmail/Outlook sync and sending**, with no application
backend and no build step. Google Identity Services handles Google authorization;
a pinned, locally vendored MSAL Browser SDK handles Microsoft authorization.
DOMPurify sanitizes HTML messages before they are displayed in isolated frames.
System fonts are used; there are no third-party fonts or analytics.

## Run

On Windows, start the local server from the repository directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\serve.ps1
```

Open http://localhost:5173. On other platforms, any static HTTP server works,
for example `python3 -m http.server 5173 --bind localhost`.
JavaScript modules require HTTP; do not open `index.html` as a file.
Keep the serving terminal running. This process only serves static files; it
does not receive OAuth tokens or process email. Any HTTPS static host can serve
the same files, including the `vendor` directory and `oauth-redirect.html`.

Use `localhost` consistently for local browsing and OAuth registration. The app
derives its OAuth origin and redirect URI from the page URL; it does not hardcode
a development hostname into deployed authentication.

If you previously used the numeric loopback address, switch to the localhost URL
and reconnect your accounts. Browser storage and popup permissions are separate
for each origin, so re-enter your public client IDs and allow sign-in popups on
localhost. Old cached data remains at the old origin; it is not moved or deleted.

## Azure Static Web Apps

Production URL: **https://orange-sand-0aa22321e.1.azurestaticapps.net/**

The existing Azure resource is `gather` in resource group `gather` (Free tier).
This deployment uses static files only; no Azure Functions/API backend is added.

### Publish the current working copy

Install Azure CLI, Node.js LTS, and `@azure/static-web-apps-cli@2.0.10`, then sign
in with `az login`. From this repository:

```powershell
.\deploy-azure.ps1 -SubscriptionId '<subscription-id>' -ResourceGroup 'gather' -AppName 'gather'
```

The script packages an explicit allowlist into ignored `dist`, obtains the
deployment token directly from Azure, passes it only through the deployment
process environment, and deploys to **production**. It does not commit files,
push branches, or change the resource tier or linked repository. Optional
`-AzureCli` and `-SwaCli` parameters accept executable paths for portable tools.

Run `.\build-static.ps1` separately to inspect the package before deploying.
Only app assets, required vendor bundles/licenses, and `staticwebapp.config.json`
are published. Tests, PowerShell scripts, README, Git data, and local caches are
excluded. Packaging refuses unexpected files or filesystem links in `dist`
instead of silently uploading them.

The resource's existing GitHub workflow still tracks **master** and deploys that
branch independently. The manual upload uses the current worktree, including
uncommitted changes. A subsequent master-branch deployment can replace it.
Before relying on CI for this version, integrate the application and adapt that
workflow to run `build-static.ps1` and deploy `dist` with `skip_app_build: true`.
This publication does not modify or retarget the existing workflow.

### Add the production OAuth URLs

Keep the localhost registrations for local development and add:

- Google **Authorized JavaScript origin**:
  `https://orange-sand-0aa22321e.1.azurestaticapps.net`
- Microsoft **Single-page application redirect URI**:
  `https://orange-sand-0aa22321e.1.azurestaticapps.net/oauth-redirect.html`

The app derives these values from its current origin and displays them in account
setup. The deployed origin has its own IndexedDB/localStorage and popup
permissions; re-enter public client IDs and reconnect accounts there. No local
mailbox cache or account tokens are uploaded during deployment.

`staticwebapp.config.json` supplies JavaScript MIME types, cache revalidation,
no-referrer/nosniff headers, and same-origin framing restrictions. The OAuth bridge
page has `no-store`, local scripts only, and **no COOP header**, as required by
MSAL's popup bridge. There is no catch-all navigation fallback: excluded files
return 404 instead of the app page. The app's existing meta CSP remains active.

## Demo behavior

- Sample Gmail and Outlook.com accounts share a unified inbox, with account filters.
- Inbox messages are grouped by known contact, including contacts with multiple
  email addresses. Matching is case-insensitive and uses exact email addresses,
  not display names. Contacts are shared across the unified inbox.
- Each topic opens as a chat: received messages appear on the left and local sent
  messages on the right, oldest first, with timestamps and date dividers.
  The list shows one card per conversation, its latest message, and message count.
  Folder badges count conversations rather than individual emails.
- The conversation and topic list expand vertically to fit their contents on
  desktop and mobile. Long messages use the browser's page scrollbar, not nested
  conversation/list scrollbars. Full subject headings are shown, and the reply
  box follows the conversation. Opening a topic shows its beginning; saving a
  reply brings the new message into view.
  The reply form sits directly below the last message, even when the folder or
  conversation list beside it is taller.
- Plain-text views trim trailing spaces, collapse repeated prose spaces and
  excessive blank lines, normalize nonbreaking spaces and line endings, and keep
  paragraphs readable. Indented/fenced plain-text code and HTML `<pre>` blocks
  retain their alignment. HTML-to-text conversion ignores source-code indentation
  and hidden preheaders, adds list markers, and separates table cells. Previews use
  compact spacing; search matches the cleaned text too. Existing cached messages
  benefit immediately without rewriting their stored bodies or requiring a sync.
- Conversation bubbles hide recognized quoted reply history by default, including
  Proton Mail/Gmail/Yahoo containers, citation blockquotes, Outlook reply headers,
  and common plain-text reply separators. **Show quoted text / Hide quoted text**
  restores or collapses the original content for that message in either HTML or
  plain-text view. Latest reply text, signatures, and ordinary editorial HTML
  blockquotes remain visible. Detection is conservative and not every email
  client's format is recognized. No original content is deleted; search still
  includes stored message text. Expansion lasts for the current tab only.
- Messages with an HTML body show formatting, lists, tables, safe inline styles,
  and sanitized width-based responsive stylesheets in a sandboxed frame that
  expands to the full message height. Newsletter container widths, nested
  auto-width tables, image dimensions, rounded corners, and hidden preheaders
  are retained rather than replaced with a uniform full-width layout. **Show
  plain text / Show HTML** switches each message's view. Sofia's gallery message
  in fresh demo data includes sample HTML formatting; resetting is not necessary
  for existing real accounts.
- **Load images** enables images for one HTML message after a tracking/privacy
  warning. **Hide images** blocks them again and cancels pending embedded-image
  fetches; it cannot undo requests already sent. The choice is memory-only,
  applies only to the unchanged message in this tab, and clears on reload,
  mailbox-mode changes, or account removal. There is no global always-load option.
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
authorization. Real sending is available after granting sending permission;
editing/deleting existing provider messages and contacts remains disabled.

## Checks

With the server running, open http://localhost:5173/tests.html.
The dependency-free browser tests cover contact matching, grouping, filtering,
unknown-sender reclassification, account isolation, sync idempotence, and storage
validation, including multi-address contact editing, duplicate-address checks,
conversation grouping, chronological order, account isolation, and inline replies.
Open http://localhost:5173/ui-tests.html for button-click regression checks, including
Save reply validation, provider onboarding, partial consent, read-only controls,
sync failures, cancellation, mode separation, and local account removal. They use
mock authentication/API responses and a disposable IndexedDB database; they do
not modify your saved mail or call real mail APIs.

Open http://localhost:5173/provider-tests.html for async adapter, pagination,
incremental sync, expired cursor, account mismatch, MIME/HTML conversion, token
handling, and IndexedDB checks. These also use mock providers and a disposable
database. Run this page in a normal browser; headless virtual-time DOM snapshots
can finish before asynchronous IndexedDB work does.

Open http://localhost:5173/html-tests.html for sanitizer, sandbox, default
resource-blocking, image opt-in, embedded-image lookup, link interception, and
full-height responsive rendering checks. All content is synthetic. UI checks
also cover image consent/cancellation, hiding, permission isolation, and failures.

Open http://localhost:5173/send-tests.html for synthetic send-transport, Unicode MIME,
reply-header, uncertain-outcome, duplicate-prevention, and reconciliation checks.
UI checks also exercise explicit send confirmation, accepted replies appearing
in place, rejected/uncertain sends, double-submit prevention, and new messages.
All sending checks use mock responses: no real email is sent by tests.

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
4. Sign in at Google/Microsoft and grant mail/contacts reading plus sending
   permission. Mail and contacts reading are required for sync; Google accounts
   that withhold sending permission can still sync, but cannot send.
   Use a regular browser if the app's
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
2. Enable **Gmail API** and **People API** in the **same Google Cloud project that
   owns your OAuth client ID**. Granting consent for their scopes does not enable
   the APIs. Setup includes links to both API Library pages.
3. Configure Google Auth Platform's branding, audience, and data access. For
   development with an external app, add your Google account as a test user.
4. Create an OAuth client of type **Web application**. Add the exact
   **Authorized JavaScript origin** displayed in Gather's setup panel, e.g.
   `http://localhost:5173`. Add your HTTPS origin separately for deployment.
   Google's browser token model does not use our Microsoft redirect page.
5. Add the scopes `https://www.googleapis.com/auth/gmail.readonly`,
   `https://www.googleapis.com/auth/contacts.readonly`, and
   `https://www.googleapis.com/auth/gmail.send`. Paste only the client ID,
   ending in `.apps.googleusercontent.com`, into Gather.

The browser receives a short-lived access token, not a Google refresh token.
When it expires, reconnect through a user gesture. Google may require app
verification before public distribution because Gmail read access is restricted;
personal/testing exceptions and account limits apply. Keeping restricted data
off your servers does not automatically remove verification requirements.

#### Gmail sync troubleshooting

Errors identify the failing service and operation (for example **Google People
API (contacts sync)** or **Gmail API (folder/label discovery)**), rather than
reporting every HTTP 403 as a missing permission:

- **SERVICE_DISABLED**: enable the named API in the project owning the client ID.
  Both Gmail API and People API are required. Allow a few minutes for the change
  to propagate, then retry Sync.
- **ACCESS_TOKEN_SCOPE_INSUFFICIENT**: reconnect and grant both read-only scopes.
  If Google does not offer consent, remove the app's access in your Google
  account settings and reconnect. Do not share access tokens or client secrets.
- **domainPolicy**: a Workspace administrator must permit the app/API.
- **QUOTA_EXCEEDED**: check the named API's quota settings or wait for reset.
- **RATE_LIMIT_EXCEEDED**: transient Google 403 rate limits receive the same bounded
  backoff as 429 responses. Gmail requests are paced to at most five starts per
  second per tab. Google retries wait 5, 10, 20, then 40 seconds (or a longer
  `Retry-After`, up to two minutes). The sync status shows each wait and Cancel
  remains available. Persistent limits are reported as rate limits, not
  permission errors. Longer `Retry-After` delays are shown rather than ignored.
  Close extra Gather tabs and avoid repeatedly reconnecting: other email clients
  share Google's per-user quota too. Reconnect only if authorization has expired.

Browsers supporting Web Locks prevent two Gather tabs on the same origin from
syncing the same account concurrently. A second sync reports that another tab is
already syncing. Different browsers/devices or origins cannot share this lock.

Unknown or non-JSON errors retain the HTTP status and service context. Raw
provider error messages, response bodies, request URLs, and tokens are not shown
in diagnostics. Imports still preserve the previous cache when any required
service fails; a contacts failure is not silently treated as a successful sync.

### Microsoft registration

1. Create an app registration in [Microsoft Entra](https://entra.microsoft.com/).
   Select an audience that includes **personal Microsoft accounts** for
   Outlook.com. To also support work/school mail, choose accounts in any
   organizational directory and personal Microsoft accounts.
2. Under Authentication, add a **Single-page application** platform with the
   exact redirect URI shown in Gather, e.g.
   `http://localhost:5173/oauth-redirect.html`. Add the deployed HTTPS URI separately.
3. Add delegated Microsoft Graph permissions **User.Read**, **Mail.Read**,
   **Contacts.Read**, and **Mail.Send**. Your organization may require administrator consent.
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
| Gmail | All messages since the chosen start date, including Drafts, Spam, and Trash. All system and custom labels are discovered, including hidden labels and slash-nested labels. Gmail `historyId` tracks message and label changes. A message with multiple labels is stored once and can appear under each matching label. | Google People `connections`, including all pages with email addresses; refreshed on each sync. Other Contacts and Workspace directory searches are not included. |
| Outlook | All mail folders returned by Microsoft Graph, traversing nested folders and including hidden folders, Drafts, Junk Email, Deleted Items, Outbox, and search folders. Each physical folder uses its own delta link and immutable message IDs. Drafts, Outbox, and search folders use regular paginated refreshes. | The default Outlook contacts folder, including all pages; refreshed on each sync. Organizational directory and custom contact folders are not included. |

The **Provider folders & labels** browser appears in the **left pane above
Contacts** in Real mail. Every account starts collapsed. Use the account
chevron to reveal its folders and a parent folder's chevron to expand or collapse
its children; click the folder name to select it. Nested folders start collapsed
too. Expansion choices survive navigation, filtering, and sync in the current
tab, but reset on reload. Collapsing a branch does not change the selected
conversation or stop syncing it. Selecting a folder shows every matching cached conversation,
regardless of whether its sender is a known contact. The existing contact-grouped
Inbox and Unknown senders views still include only inbox messages. Spam, Trash,
and drafts do not enter those views merely because their sender is a contact.
Custom Outlook folders are not incorrectly grouped into the unified Archive.

Folder counts are cached **messages**, while conversation-list counts are
**topics**; neither claims to be the provider's all-time mailbox total. Empty
folders remain selectable. Search and unread filters apply within the selected
folder. Selecting a folder selects its account; **Sync mail** refreshes all folders
for that account. Select **All accounts** to refresh every connected account.
No per-folder write permissions are requested, and no provider folders are created.

Folder catalogs are rediscovered each sync. Renames keep their stable folder IDs,
new folders are imported, and deleted folders and their cached membership/cursors
are removed. If the selected folder disappears, the app returns to Inbox. Overlapping
Outlook search-folder results are deduplicated by immutable message ID.
Provider permissions still control what Microsoft exposes: shared/delegated
mailboxes, separate online archive mailboxes, and folders not returned by the
provider are not included. An inaccessible discovered folder causes the account
sync to fail visibly and preserves the previous account snapshot, rather than
silently pretending the folder was synced.

Unsent drafts are labeled **Draft · Not sent**, including drafts without a
recipient or subject. They remain read-only and separate from delivered-message
threads. Outbox messages are labeled pending, not sent. Draft/Outbox date filtering
uses modification/creation dates when appropriate instead of assuming a received
date exists. Provider folders and messages are still limited to the account's
chosen import starting date.

Old caches remain readable. On the next successful **Sync mail**, Gather refreshes
the selected date range once to add the folder catalog and all-folder memberships,
including previously excluded drafts, junk, and deleted mail. No reset is required.
This wider import may take longer and use more storage than the previous three-folder
Outlook/inbox-oriented Gmail import.

Initial imports follow pagination; there is no silent client-side message limit.
Large imports can take time and use considerable local storage. The chosen start
date stays fixed for incremental sync. Reconnect with a different range to rebuild
from a different starting date. Microsoft limits filtered delta queries to 5,000
messages; folders reaching that threshold switch to regular full pagination on
this and later syncs instead of silently truncating the mailbox.

Gmail imports retain both MIME text and HTML alternatives (when available).
Outlook requests HTML bodies and derives a plain-text version for search and
previews. Existing text-only caches still work offline. On their next successful
**Sync mail**, the selected date range is refreshed once to fetch original HTML,
even for unchanged messages; later syncs return to the normal incremental path.
No account reset or deletion is required.

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

Reading and syncing remain non-mutating: opening a message does not mark it read,
and star, archive, delete, and contact-edit controls remain absent. Make these
changes in Google/Microsoft and sync to see them here. Demo sending remains
demo-only and never uses a real account.

### Sending real email

Reconnect existing accounts to grant **gmail.send** / **Mail.Send**. Click
**New message**, choose the sending account, enter one or more comma-separated
addresses, a subject, and a plain-text body, then **Send email**. Gather confirms
the real sending account and recipients before submitting. The initial version
supports plain text up to 1 MB, at most 50 recipients, and no attachment uploads.

In a conversation, **Send reply** keeps the accepted message in that chat and
adds it to Sent. Replies now default to **Reply all**: incoming messages use their
Reply-To addresses when available (otherwise the sender), plus the original To
and Cc recipients. A sent-only thread keeps its original To/Cc recipients.
Your sending account's email address is excluded, and duplicate addresses are
removed case-insensitively. Other aliases are not automatically identified as
self. Bcc recipients are not added. To and Cc remain distinct in the outgoing
email and are displayed in the form and confirmation before sending.
Older caches recover Cc from their stored visible participants until the next
sync provides explicit Cc metadata. Existing provider drafts cannot be edited or sent
directly; compose a new message instead. Old caches refresh once on sync to
obtain Reply-To and message-header metadata before replies are enabled.

Gmail sends RFC-formatted, UTF-8/base64 messages with Message-ID, In-Reply-To,
References, Cc headers, and the provider thread ID. Microsoft uses Graph's replyAll action or
sendMail action, with explicit recipients and a client correlation header.
Neither path requests mailbox read/write permissions beyond the separate send
permission.

Send requests are **never automatically retried**. A durable local attempt is
saved before the POST, and sending is protected against double submission and
concurrent same-account sync/send in other tabs using Web Locks. A rejection
keeps the draft editable and labels the attempt as not sent. A network interruption,
timeout, or server error may have occurred after the provider accepted the email;
these remain in **Outbox** as unconfirmed/unknown. Check the provider's Sent folder
and sync before attempting again. Identical unknown sends are blocked to reduce
duplicate delivery risk.

After checking the provider's Sent folder, **Remove local attempt** can clear a
rejected/unconfirmed attempt so you can retry manually. This does not recall or
delete any provider email; the confirmation warns that resending can duplicate
a message that was already accepted.

An accepted response is **not a delivery receipt**. The chat initially says
**Accepted by provider · Sent copy pending sync**. The next sync replaces the
local record using the provider message ID, Internet Message-ID, or unique
`x-gather-send-id` header, without duplicate bubbles. Until Microsoft returns a
new conversation's canonical Sent copy, further replies in that new thread
require sync. If an accepted send's local save fails, Gather explicitly warns
not to resend; its persisted pre-send attempt prevents an automatic duplicate.

### Local data and browser safety

- Real accounts, text and HTML message bodies, contacts, and sync cursors are stored in
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
- HTML email is parsed in an inert template, sanitized using pinned DOMPurify,
  restricted to presentation markup and a conservative CSS allowlist,
  then rendered in a sandboxed `srcdoc` iframe. That frame permits same-origin
  access only so Gather can measure its height and intercept link clicks; it does
  **not** permit scripts, forms, popups, downloads, or top-level navigation.
  A separate frame CSP blocks scripts and, by default, all network/resource
  loading. Only its image policy is relaxed after per-message image consent.
  Formatting cannot affect the surrounding application. Raw cached HTML is
  always sanitized again on display rather than trusted because it was stored.
- Remote, data-URL, and CID images start as labeled placeholders. Safe rules in
  style blocks, class selectors, inline styles, priorities, and width-based media
  queries are preserved inside the isolated document. External stylesheets/fonts,
  CSS resource URLs/imports, fixed/absolute positioning, internal scrolling rules,
  viewport-dependent sizing, and embedded active content are stripped. Root body
  height is controlled by Gather to avoid clipping or resize feedback.
  Proprietary Outlook/Word markup, VML, and unsupported CSS can still look different
  from Outlook. Plain text is available per message, and search/previews use it.
- After **Load images**, ordinary HTTP(S) image URLs load directly in the message
  frame with no referrer and no Google/Microsoft bearer token. The image host can
  still observe the viewer's IP address, timing, and any identifiers in the URL;
  the browser may also send that host's cookies. Browser mixed-content/privacy
  rules can block some images. There is no image proxy or anonymity guarantee.
  Explicit local-host/IP-literal image URLs, credential-bearing URLs, relative
  paths, executable schemes, responsive `srcset`, and CSS background images are
  not enabled. Public DNS names can still resolve or redirect elsewhere.
- Embedded PNG, JPEG, GIF, WebP, and AVIF images are supported after consent.
  Referenced CID images are looked up in that message through Gmail or Microsoft
  Graph using the existing read-only authorization; reconnect if it has expired.
  SVG/data-HTML and unsupported image types remain blocked. Embedded downloads
  are limited to 10 MB per image and 25 MB per message. Newly downloaded image
  bytes stay in tab memory, not IndexedDB, and are discarded when permission is
  cleared. Data-URL images already present in cached HTML remain part of that
  HTML. Missing, oversized, unsupported, and failed images show explicit
  placeholders/errors instead of silently claiming they loaded.
- Failed remote images have **Retry image** and **Open image** actions; opening
  uses the usual destination confirmation. Browser image failures do not expose
  an HTTP status to the renderer, so a blocked, unavailable, or expired resource
  is not misreported as a particular server error. Valid vector images are not
  rejected solely because an intrinsic width is unavailable.
- Only explicit HTTP, HTTPS, and mailto links are retained. Clicking one shows
  its destination for confirmation before the parent app opens it separately
  with `noopener,noreferrer`; relative, credential-bearing, and executable URLs
  are removed. Use normal caution with links in email.
- Other attachments are not downloaded. This option displays images inside the
  email; it does not save image files to disk. Large Gmail bodies stored as attachment objects
  receive an explicit placeholder rather than being silently shown as complete.
  Encoded display-name headers are not fully decoded.
- Sync/image requests are GET-only. Sending uses one explicit POST to the
  provider's send/reply endpoint after confirmation. Requests omit cookies,
  reject redirects, and restrict bearer tokens to Google/Microsoft API origins. Third-party fonts
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
background worker, cross-device data sync, attachment uploads, or editing of
existing provider messages/contacts.

### SDK provenance and implementation

`vendor/manifest.json` pins MSAL Browser **5.23.0** and DOMPurify **3.4.16** to their
npm releases and SHA-512 integrity values. Their selected browser files and
licenses are vendored. To restore those exact files on Windows, run
`.\restore-sdk.ps1`. This verifies each package checksum before extracting its
selected files. Google requires its
Identity Services script to load from `https://accounts.google.com/gsi/client`.

- `auth.js`: provider SDK setup and in-memory authorization.
- `provider-mail.js`: GET-only transport, provider normalization, pagination,
  incremental mail sync, and imported-contact grouping.
- `mailbox-store.js`: atomic per-account IndexedDB snapshots.
- `email-html.js`: HTML sanitization, sandbox documents, responsive sizing, and link handling.
- `email-styles.js`: resource-free presentation CSS and width-based media-query sanitization.
- `email-images.js`: image URL/raster validation and on-demand provider CID-image retrieval.
- `email-text.js`: whitespace cleanup, structured HTML-to-text conversion, and display previews.
- `email-send.js`: outgoing validation, MIME encoding, send transport, and local-send reconciliation.
- `accounts-panel.js`: connection, reconnect, sync, and removal UI.
- `mail.js` / `app.js`: shared views and separate real/demo modes.

References: [Google browser token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model),
[Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync),
[Microsoft message delta](https://learn.microsoft.com/en-us/graph/api/message-delta),
[MSAL v5 redirect bridge](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/redirect-bridge).

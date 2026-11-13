// Types and event names for the engine's `<webview>` element, which shows web
// content in its own browsing context.
//
// The engine implements the element and dispatches every event below. This
// module only declares them for TypeScript. See
// `docs/architecture/BROWSER-WINDOWS.md`.

/**
 * Fired when the page inside the view takes focus, for example on a click.
 *
 * Use it to raise the window: pointer events inside the guest do not reach the
 * shell. The view also gets real `focus` and `focusin` events. Bubbles. See
 * `HTMLWebViewElement::GuestTookFocus` in the engine.
 */
export const WEBVIEW_GUEST_FOCUS_EVENT = "domicile-guest-focus";

/**
 * Fired when {@link HTMLWebViewElement.canGoBack} or
 * {@link HTMLWebViewElement.canGoForward} may have changed.
 *
 * Carries no payload. Read the properties instead, since a shell that mounts
 * late misses earlier events. Bubbles.
 */
export const WEBVIEW_HISTORY_CHANGE_EVENT = "domicile-history-change";

/**
 * Fired when {@link HTMLWebViewElement.loading} changes.
 *
 * Carries no payload. Fires once per start and stop, not per subresource.
 * Same-document navigations (fragments, `pushState`) do not fire it. Bubbles.
 */
export const WEBVIEW_LOADING_CHANGE_EVENT = "domicile-loading-change";

/**
 * Fired when {@link HTMLWebViewElement.loadProgress} changes. Carries no
 * payload. Bubbles.
 */
export const WEBVIEW_LOAD_PROGRESS_CHANGE_EVENT =
  "domicile-load-progress-change";

/**
 * Fired when {@link HTMLWebViewElement.url} or
 * {@link HTMLWebViewElement.security} changes. Carries no payload. Bubbles.
 *
 * Always show `security` with `url`, never with `src`. The engine updates both
 * from the same navigation entry; pairing the lock with another address
 * enables address-bar spoofing. See
 * `components/domicile/mojom/web_view_guest.mojom`.
 */
export const WEBVIEW_PAGE_CHANGE_EVENT = "domicile-page-change";

/**
 * The connection security levels a `<webview>` can report.
 *
 * Derived from `security_state::GetSecurityLevel`, as Chrome's omnibox lock
 * is. An `https://` page with a bad certificate or active mixed content is
 * `dangerous`.
 *
 * The element reports `""` before the first navigation commits. Do not treat
 * it as `neutral`; see `connection-safety.ts` in shell-manganese.
 */
export const WEBVIEW_SECURITY_LEVELS = [
  "neutral",
  "secure",
  "warning",
  "dangerous",
] as const;

export type WebViewSecurity = (typeof WEBVIEW_SECURITY_LEVELS)[number];

/**
 * The attribute that makes a `<webview>` show a browser window:
 * `<webview window="1">` shows the window whose `DomicileBrowserWindow.id` is
 * `"1"`.
 *
 * - **Lifetime:** the engine holds the page, so it outlives the shell's
 *   document. After `domicile load-shell` the next shell draws the same pages,
 *   with scroll, form input and history intact. A `<webview src>` page belongs
 *   to the document and goes with it.
 * - **Read once,** when the element is inserted. Set it before inserting the
 *   view; later changes do nothing.
 * - **`src`:** ignored on insert, since the page is already loaded. A later
 *   `src` navigates the window.
 * - **One view per window.** A second view of the same window is empty.
 * - **Opening:** `target="_blank"`, `window.open`, `domicile open`,
 *   `chrome.tabs.create` and `chrome.windows.create` open windows without the
 *   shell. They appear in `DomicileHost.browserWindows`. The shell's own UI
 *   opens one with `DomicileHost.openBrowserWindow`.
 */
export const WEBVIEW_WINDOW_ATTRIBUTE = "window";

/**
 * The attribute that gives a `<webview>`'s page storage of its own, apart from
 * the user's: `<webview partition="persist:work">`.
 *
 * - **`persist:<name>`** keeps the partition on disk across restarts. Any
 *   other name keeps it in memory until the engine exits.
 * - **Shared by name:** every view and window with the same partition shares
 *   its cookies and storage.
 * - **Read once,** when the element is inserted, like
 *   {@link WEBVIEW_WINDOW_ATTRIBUTE}. Ignored with it.
 * - **New windows** the page opens share its partition, and list it as
 *   `DomicileBrowserWindow.partition`.
 * - `persist:` with no name shows nothing.
 */
export const WEBVIEW_PARTITION_ATTRIBUTE = "partition";

/**
 * Fired when the page calls `window.close()`, or an extension's
 * `chrome.tabs.remove` names the view. The shell should remove the view.
 * Bubbles.
 *
 * Fired only on a view without {@link WEBVIEW_WINDOW_ATTRIBUTE}. A browser
 * window closes in the browser instead and leaves
 * `DomicileHost.browserWindows`.
 *
 * Fires only for script-closable pages (one history entry), per the HTML spec.
 * Extension popups close this way.
 */
export const WEBVIEW_CLOSE_EVENT = "domicile-close";

/**
 * A {@link DomicileWillNavigateEvent} fired before the page navigates its main
 * frame: a link, a form or a script setting `location`. Call
 * `preventDefault()` during dispatch to cancel the navigation; the page stays.
 * Bubbles. Like Electron's `will-navigate`.
 *
 * Not fired for the shell's own navigations (`src`, `goBack()`, `reload()`),
 * history steps, reloads, subframes or new windows. The navigation waits for
 * dispatch, so keep listeners fast.
 */
export const WEBVIEW_WILL_NAVIGATE_EVENT = "domicile-will-navigate";

/**
 * Fired when the page calls `window.focus()` or `client.focus()` (how a site
 * answers a click on its notification), or when an extension calls
 * `chrome.tabs.update(id, {active: true})` or
 * `chrome.windows.update(id, {focused: true})` for this view. The shell should
 * raise and focus it. Bubbles.
 */
export const WEBVIEW_FOCUS_REQUEST_EVENT = "domicile-focus-request";

/**
 * A `KeyboardEvent` fired for a Ctrl, Alt or Meta chord the page did not
 * `preventDefault`. Bubbles.
 *
 * Guest keys never reach the shell's document, so this is how a shell sees
 * them. The page handles the key first, as in Chrome. It is not named
 * `keydown` so existing `keydown` listeners do not see it. Plain keys are
 * never forwarded, so typed text such as passwords stays in the guest.
 */
export const WEBVIEW_GUEST_KEYDOWN_EVENT = "domicile-guest-keydown";

/**
 * Fired when {@link HTMLWebViewElement.zoom} changes. Carries no payload.
 * Bubbles.
 *
 * Zoom is per host, as in Chrome, so another window on the same site or a
 * navigation can also change it.
 */
export const WEBVIEW_ZOOM_CHANGE_EVENT = "domicile-zoom-change";

/**
 * Fired when {@link HTMLWebViewElement.favicon} changes. Carries no payload.
 * Bubbles.
 */
export const WEBVIEW_FAVICON_CHANGE_EVENT = "domicile-favicon-change";

/**
 * Fired when {@link HTMLWebViewElement.description} changes. Carries no
 * payload. Bubbles.
 */
export const WEBVIEW_DESCRIPTION_CHANGE_EVENT = "domicile-description-change";

/**
 * Fired when {@link HTMLWebViewElement.targetUrl} changes. Carries no payload.
 * Bubbles.
 */
export const WEBVIEW_TARGET_URL_CHANGE_EVENT = "domicile-target-url-change";

/**
 * Fired when {@link HTMLWebViewElement.tooltip} changes, with
 * {@link HTMLWebViewElement.tooltipX} and `tooltipY`. Carries no payload.
 * Bubbles.
 */
export const WEBVIEW_TOOLTIP_CHANGE_EVENT = "domicile-tooltip-change";

/**
 * Fired on Ctrl+wheel over a page that did not handle the wheel.
 *
 * The engine does not zoom; the shell picks the step and calls `setZoom`, so
 * the wheel and keyboard shortcuts share one path. Two plain `Event`s instead
 * of one with a direction. Both bubble.
 */
export const WEBVIEW_ZOOM_IN_REQUEST_EVENT = "domicile-zoom-in-request";
export const WEBVIEW_ZOOM_OUT_REQUEST_EVENT = "domicile-zoom-out-request";

/**
 * Fired when {@link HTMLWebViewElement.findMatches} or
 * {@link HTMLWebViewElement.findActiveMatch} changes. Carries no payload.
 * Bubbles.
 *
 * Fires several times as frames are searched. Navigation ends the find and
 * resets the counts, as in Chrome.
 */
export const WEBVIEW_FIND_CHANGE_EVENT = "domicile-find-change";

/**
 * Fired when {@link HTMLWebViewElement.contentWidth} or
 * {@link HTMLWebViewElement.contentHeight} changes. Carries no payload.
 * Bubbles.
 */
export const WEBVIEW_CONTENT_SIZE_CHANGE_EVENT = "domicile-content-size-change";

/**
 * Fired when {@link HTMLWebViewElement.pageFullscreen} changes. Carries no
 * payload. Bubbles.
 */
export const WEBVIEW_PAGE_FULLSCREEN_CHANGE_EVENT =
  "domicile-page-fullscreen-change";

/**
 * Fired when {@link HTMLWebViewElement.wakeLock} changes. Carries no payload.
 * Bubbles.
 */
export const WEBVIEW_WAKE_LOCK_CHANGE_EVENT = "domicile-wake-lock-change";

/**
 * Fired when {@link HTMLWebViewElement.renderProcessGone} or
 * {@link HTMLWebViewElement.renderProcessExitCode} changes: the page's
 * renderer went away, or a new one replaced it. Carries no payload. Bubbles.
 */
export const WEBVIEW_RENDER_PROCESS_CHANGE_EVENT =
  "domicile-render-process-change";

/**
 * Why a `<webview>`'s renderer went away, as Electron's
 * `render-process-gone` names it.
 *
 * - `clean-exit`: it exited with status 0.
 * - `abnormal-exit`: it exited with a nonzero status.
 * - `killed`: a signal such as SIGKILL or SIGTERM ended it.
 * - `crashed`: a signal such as SIGSEGV or SIGABRT ended it.
 * - `oom`: it ran out of memory.
 * - `launch-failed`: it never started.
 * - `memory-eviction`: the browser ended it to free memory.
 */
export const WEBVIEW_RENDER_PROCESS_GONE_REASONS = [
  "clean-exit",
  "abnormal-exit",
  "killed",
  "crashed",
  "oom",
  "launch-failed",
  "memory-eviction",
] as const;

export type WebViewRenderProcessGone =
  (typeof WEBVIEW_RENDER_PROCESS_GONE_REASONS)[number];

/**
 * Fired when {@link HTMLWebViewElement.pageFailure} or the attributes beside
 * it change: the page failed to load, or a page loaded after one did. Carries
 * no payload. Bubbles.
 */
export const WEBVIEW_PAGE_FAILURE_CHANGE_EVENT = "domicile-page-failure-change";

/**
 * Why a `<webview>`'s page failed to load, as
 * {@link HTMLWebViewElement.pageFailure}. The engine draws no error or warning
 * page: the page is blank and the shell draws one.
 *
 * - `network`: it could not be reached (no network, no such host, refused,
 *   timed out, blocked); `pageFailureError` says which.
 * - `http`: the server answered `pageFailureHttpStatus` with nothing to show.
 * - `certificate`: the site's certificate is not trusted.
 * - `warning`: the browser warned before loading it (Safe Browsing, a
 *   lookalike address, no secure connection under HTTPS-First).
 */
export const WEBVIEW_PAGE_FAILURES = [
  "network",
  "http",
  "certificate",
  "warning",
] as const;

export type WebViewPageFailure = (typeof WEBVIEW_PAGE_FAILURES)[number];

/**
 * Fired when the page needs a file picked: an `<input type="file">` or a
 * download. Bubbles.
 *
 * The browser draws no dialog. Call `preventDefault()` to handle it, then
 * answer with {@link DomicileFileChooserEvent.choose} or
 * {@link DomicileFileChooserEvent.cancel}. If no listener calls
 * `preventDefault()`, the request is canceled, so uploads and downloads fail.
 * Every download asks for a path. A picker lists directories with `readDir`
 * from `@domicile-desktop/sdk/system`.
 */
export const WEBVIEW_FILE_CHOOSER_EVENT = "domicile-file-chooser";

/**
 * What a {@link WEBVIEW_FILE_CHOOSER_EVENT} asks for.
 *
 * - `open`: one existing file.
 * - `open-multiple`: one or more existing files.
 * - `open-folder`: one existing directory, whose contents the browser reads.
 * - `save`: one path to write, which need not exist yet.
 */
export const WEBVIEW_FILE_CHOOSER_MODES = [
  "open",
  "open-multiple",
  "open-folder",
  "save",
] as const;

export type WebViewFileChooserMode =
  (typeof WEBVIEW_FILE_CHOOSER_MODES)[number];

/**
 * Fired on a right click the page did not `preventDefault`. Bubbles.
 *
 * The browser draws no context menu. The event carries what was under the
 * click, so the shell can draw one. {@link DomicileContextMenuEvent.run} does
 * the browser's part of an item. A newer menu replaces this one, after which
 * `run()` throws.
 */
export const WEBVIEW_CONTEXT_MENU_EVENT = "domicile-context-menu";

/**
 * What {@link DomicileContextMenuEvent.run} can do.
 *
 * - Edit commands on the focused element: `undo`, `redo`, `cut`, `copy`,
 *   `paste`, `paste-and-match-style`, `delete`, `select-all`.
 * - Over a link: `copy-link-address`, `save-link-as`.
 * - Over an image with pixels, or a canvas: `copy-image`.
 * - Over an image, video or audio: `copy-media-address`, `save-media-as`.
 * - Anywhere: `inspect`, DevTools on the element under the click.
 *
 * A save asks {@link WEBVIEW_FILE_CHOOSER_EVENT} where.
 */
export const WEBVIEW_CONTEXT_MENU_ACTIONS = [
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "paste-and-match-style",
  "delete",
  "select-all",
  "copy-link-address",
  "save-link-as",
  "copy-image",
  "copy-media-address",
  "save-media-as",
  "inspect",
] as const;

export type WebViewContextMenuAction =
  (typeof WEBVIEW_CONTEXT_MENU_ACTIONS)[number];

/** What was under the click: {@link DomicileContextMenuEvent.mediaType}. */
export const WEBVIEW_MEDIA_TYPES = [
  "none",
  "image",
  "video",
  "audio",
  "canvas",
  "file",
  "plugin",
] as const;

export type WebViewMediaType = (typeof WEBVIEW_MEDIA_TYPES)[number];

/**
 * Fired when the page asks for a permission its site has no stored choice
 * for, such as the camera in a video call. Bubbles.
 *
 * The browser draws no prompt. Call `preventDefault()` to handle it, then
 * answer with {@link DomicilePermissionRequestEvent.allow},
 * {@link DomicilePermissionRequestEvent.deny} or
 * {@link DomicilePermissionRequestEvent.dismiss}. If no listener calls
 * `preventDefault()`, the request is ignored: the page gets nothing and
 * nothing is stored. One request is outstanding at a time.
 */
export const WEBVIEW_PERMISSION_REQUEST_EVENT = "domicile-permission-request";

/**
 * Fired when the browser drops the outstanding
 * {@link WEBVIEW_PERMISSION_REQUEST_EVENT} unanswered, for example because the
 * page navigated. Answering it afterward throws. Carries no payload. Bubbles.
 */
export const WEBVIEW_PERMISSION_REQUEST_WITHDRAWN_EVENT =
  "domicile-permission-request-withdrawn";

/**
 * Fired when {@link HTMLWebViewElement.sitePermissions} may have changed: the
 * page moved to another site, or a setting changed. Carries no payload.
 * Bubbles.
 */
export const WEBVIEW_SITE_PERMISSIONS_CHANGE_EVENT =
  "domicile-site-permissions-change";

/**
 * The permissions a site can ask for and a shell can set.
 *
 * - `camera`, `microphone`: `getUserMedia`.
 * - `location`: the Geolocation API.
 * - `notifications`: allowed by default (see `NOTIFICATIONS.md`).
 * - `clipboard`: reading the clipboard.
 * - `midi`: Web MIDI with system exclusive messages.
 * - `window-management`: the Window Management API's screen details and
 *   placement.
 * - `local-fonts`: `queryLocalFonts()`.
 * - `idle-detection`: the Idle Detection API.
 * - `automatic-downloads`: several downloads without a click for each.
 */
export const WEBVIEW_PERMISSIONS = [
  "camera",
  "microphone",
  "location",
  "notifications",
  "clipboard",
  "midi",
  "window-management",
  "local-fonts",
  "idle-detection",
  "automatic-downloads",
] as const;

export type WebViewPermission = (typeof WEBVIEW_PERMISSIONS)[number];

/**
 * Fired when the page asks for a device through WebHID, WebUSB or Web Serial,
 * such as a hardware wallet. Bubbles.
 *
 * The browser draws no chooser. Call `preventDefault()` to handle it, then
 * answer with {@link DomicileDeviceRequestEvent.choose} or
 * {@link DomicileDeviceRequestEvent.cancel}. If no listener calls
 * `preventDefault()`, the request is canceled: the page gets no device. One
 * request is outstanding at a time.
 */
export const WEBVIEW_DEVICE_REQUEST_EVENT = "domicile-device-request";

/**
 * Fired when the outstanding {@link WEBVIEW_DEVICE_REQUEST_EVENT}'s devices
 * change: once listed, and as devices are plugged in or removed. Reread
 * {@link DomicileDeviceRequestEvent.devices}. Carries no payload. Bubbles.
 */
export const WEBVIEW_DEVICE_REQUEST_CHANGE_EVENT =
  "domicile-device-request-change";

/**
 * Fired when the browser drops the outstanding
 * {@link WEBVIEW_DEVICE_REQUEST_EVENT} unanswered, for example because the
 * page navigated. Answering it afterward throws. Carries no payload. Bubbles.
 */
export const WEBVIEW_DEVICE_REQUEST_WITHDRAWN_EVENT =
  "domicile-device-request-withdrawn";

/**
 * Fired when the page calls `alert()`, `confirm()` or `prompt()`, or its
 * `beforeunload` handler asks to stay. The page is paused until it is
 * answered. Bubbles.
 *
 * The browser draws no dialog. Call `preventDefault()` to handle it, then
 * answer with {@link DomicileDialogEvent.accept} or
 * {@link DomicileDialogEvent.dismiss}. If no listener calls `preventDefault()`,
 * the dialog is dismissed: `confirm()` returns false and `prompt()` null. An
 * unclaimed `beforeunload` is accepted, so the page leaves. One dialog is open
 * at a time.
 */
export const WEBVIEW_DIALOG_EVENT = "domicile-dialog";

/**
 * Fired when the browser drops the open {@link WEBVIEW_DIALOG_EVENT}
 * unanswered, for example because the page navigated or closed. Answering it
 * afterward throws. Carries no payload. Bubbles.
 */
export const WEBVIEW_DIALOG_WITHDRAWN_EVENT = "domicile-dialog-withdrawn";

/**
 * Fired when the page opens a link for an application, such as `zoommtg:` or
 * `mailto:`, that the browser would ask about. Nothing opens until it is
 * answered. Bubbles.
 *
 * The browser draws no dialog. Call `preventDefault()` to handle it, then
 * answer with {@link DomicileExternalAppEvent.open} or
 * {@link DomicileExternalAppEvent.dismiss}. If no listener calls
 * `preventDefault()`, nothing opens. A site the user let open these links
 * without asking, and a blocked scheme, fire nothing.
 */
export const WEBVIEW_EXTERNAL_APP_EVENT = "domicile-external-app";

/**
 * Fired when a newer {@link WEBVIEW_EXTERNAL_APP_EVENT} replaces the one still
 * unanswered, which then opens nothing. Answering it afterward throws. Carries
 * no payload. Bubbles.
 */
export const WEBVIEW_EXTERNAL_APP_WITHDRAWN_EVENT =
  "domicile-external-app-withdrawn";

/**
 * Fired when a site or a proxy asks for a user name and password (HTTP
 * authentication). The request waits until it is answered. Bubbles.
 *
 * The browser draws no dialog. Call `preventDefault()` to handle it, then
 * answer with {@link DomicileSignInEvent.signIn} or
 * {@link DomicileSignInEvent.dismiss}. If no listener calls
 * `preventDefault()`, it is canceled and the page shows the site's refusal.
 */
export const WEBVIEW_SIGN_IN_EVENT = "domicile-sign-in";

/**
 * Fired when the browser drops the unanswered {@link WEBVIEW_SIGN_IN_EVENT},
 * for example because the page navigated, or a newer one replaces it.
 * Answering it afterward throws. Carries no payload. Bubbles.
 */
export const WEBVIEW_SIGN_IN_WITHDRAWN_EVENT = "domicile-sign-in-withdrawn";

/**
 * Fired when the page, or an extension shown in the element, needs the user
 * to answer a question the browser would otherwise ask with a dialog of its
 * own: letting a site view or edit a file, picking a certificate to sign in
 * with, pairing a Bluetooth device, or granting an extension permissions. See
 * {@link WEBVIEW_PROMPT_KINDS}. The request waits until it is answered.
 * Bubbles.
 *
 * The browser draws no dialog. Call `preventDefault()` to handle it, then
 * answer with {@link DomicilePromptEvent.accept} or
 * {@link DomicilePromptEvent.dismiss}. If no listener calls
 * `preventDefault()`, it is answered no.
 */
export const WEBVIEW_PROMPT_EVENT = "domicile-prompt";

/**
 * Fired when the browser drops the unanswered {@link WEBVIEW_PROMPT_EVENT},
 * for example because the page navigated, or a newer one replaces it.
 * Answering it afterward throws. Carries no payload. Bubbles.
 */
export const WEBVIEW_PROMPT_WITHDRAWN_EVENT = "domicile-prompt-withdrawn";

/**
 * What a {@link WEBVIEW_PROMPT_EVENT} asks, as {@link DomicilePromptEvent.kind}:
 *
 * - `file-view`, `file-edit`: let the site view or edit the file or folder
 *   named `subject` (full path in `details[0]`).
 * - `file-restricted`: the site picked a folder that holds system files.
 *   Accepting picks another; dismissing gives up.
 * - `file-dangerous`: save `subject` anyway, though it may be harmful.
 * - `client-certificate`: pick one of `details` (each `"name\nissuer"`) to
 *   sign in to the site with; pass its index to `accept`. Dismissing continues
 *   without one.
 * - `bluetooth-pin`: the device `subject` needs a PIN; pass it as `accept`'s
 *   text.
 * - `bluetooth-confirm`: pair with the device `subject`; `pin`, when set, must
 *   match the one the device shows.
 * - `extension-install`, `extension-permissions`, `extension-re-enable`: add,
 *   grant more permissions to, or turn back on the extension `subject`, with
 *   the permissions in `details`.
 * - `resend-form`: reloading the page titled `subject` sends its form again.
 *   Accepting resends; dismissing leaves the page as it is.
 * - `unresponsive`: the page titled `subject` stopped responding. Accepting
 *   ends it, and the page then shows as crashed; dismissing waits. Withdrawn
 *   when it responds again.
 */
export const WEBVIEW_PROMPT_KINDS = [
  "file-view",
  "file-edit",
  "file-restricted",
  "file-dangerous",
  "client-certificate",
  "bluetooth-pin",
  "bluetooth-confirm",
  "extension-permissions",
  "extension-install",
  "extension-re-enable",
  "resend-form",
  "unresponsive",
] as const;

/** One of {@link WEBVIEW_PROMPT_KINDS}. */
export type WebViewPromptKind = (typeof WEBVIEW_PROMPT_KINDS)[number];

/**
 * Fired when a form control in the page opens a picker the browser would
 * otherwise draw itself: a color input, a date or time input, or a text
 * input's `<datalist>`. See {@link WEBVIEW_PICKER_KINDS}. The control waits
 * until it is answered. Bubbles.
 *
 * The browser draws no picker. Call `preventDefault()` to handle it, then
 * answer with {@link DomicilePickerEvent.choose} or
 * {@link DomicilePickerEvent.cancel}. If no listener calls `preventDefault()`,
 * the control keeps its value.
 */
export const WEBVIEW_PICKER_EVENT = "domicile-picker";

/**
 * Fired when the page closes the unanswered {@link WEBVIEW_PICKER_EVENT}, for
 * example because the control went away, or a newer one replaces it.
 * Answering it afterward throws. Carries no payload. Bubbles.
 */
export const WEBVIEW_PICKER_WITHDRAWN_EVENT = "domicile-picker-withdrawn";

/**
 * What a {@link WEBVIEW_PICKER_EVENT} picks, as {@link DomicilePickerEvent.kind},
 * and the format of its value:
 *
 * - `color`: `"#rrggbb"`.
 * - `date`, `time`, `datetime-local`, `month`, `week`: the input's HTML
 *   format, such as `"2026-11-06"`, `"13:45"`, `"2026-11-06T13:45"`,
 *   `"2026-11"` and `"2026-W45"`.
 * - `list`: one of `options`, for a text input's `<datalist>`.
 */
export const WEBVIEW_PICKER_KINDS = [
  "color",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
  "list",
] as const;

/** One of {@link WEBVIEW_PICKER_KINDS}. */
export type WebViewPickerKind = (typeof WEBVIEW_PICKER_KINDS)[number];

/**
 * Fired when the page signs in with an identity provider ("Sign in with",
 * FedCM), once for each step of it: see {@link WEBVIEW_IDENTITY_STEPS}. Each
 * step replaces the last, and the request waits on each until it is answered.
 * Bubbles.
 *
 * The browser draws no account chooser. Call `preventDefault()` to handle it,
 * then answer with {@link DomicileIdentityEvent.choose},
 * {@link DomicileIdentityEvent.signInToProvider},
 * {@link DomicileIdentityEvent.moreDetails} or
 * {@link DomicileIdentityEvent.dismiss}. If no listener calls
 * `preventDefault()`, the request fails, without the quiet period a dismissal
 * starts.
 */
export const WEBVIEW_IDENTITY_EVENT = "domicile-identity";

/**
 * Fired when the browser drops the unanswered {@link WEBVIEW_IDENTITY_EVENT},
 * for example because the page navigated or gave up, the request ended, or
 * a newer step replaces it. Answering it afterward throws.
 * Carries no payload. Bubbles.
 */
export const WEBVIEW_IDENTITY_WITHDRAWN_EVENT = "domicile-identity-withdrawn";

/**
 * The steps of a {@link WEBVIEW_IDENTITY_EVENT}, as
 * {@link DomicileIdentityEvent.step}:
 *
 * - `loading`: the browser is fetching the accounts. Only after the page's own
 *   sign-in button (`button`).
 * - `accounts`: pick one of `accounts()` with `choose`, or sign in another
 *   with `signInToProvider` where its provider has `addAccount`.
 * - `signed-out`: the user is signed out of `providers()[0]`;
 *   `signInToProvider(0)` opens its sign-in page.
 * - `verifying`: signing in with `accounts()[0]`. Takes no answer; the next
 *   step or the withdrawal ends it. `automatic` when the user picked nothing.
 * - `error`: signing in failed. `error` and `errorUrl` say why;
 *   `moreDetails()` opens `errorUrl`.
 */
export const WEBVIEW_IDENTITY_STEPS = [
  "loading",
  "accounts",
  "signed-out",
  "verifying",
  "error",
] as const;

/** One of {@link WEBVIEW_IDENTITY_STEPS}. */
export type WebViewIdentityStep = (typeof WEBVIEW_IDENTITY_STEPS)[number];

/**
 * What signing in is for, as {@link DomicileIdentityEvent.purpose}, to title a
 * step: "Sign in to", "Sign up to", "Use" or "Continue to" the site.
 */
export const WEBVIEW_IDENTITY_PURPOSES = [
  "sign-in",
  "sign-up",
  "use",
  "continue",
] as const;

/** One of {@link WEBVIEW_IDENTITY_PURPOSES}. */
export type WebViewIdentityPurpose = (typeof WEBVIEW_IDENTITY_PURPOSES)[number];

/**
 * What signing in with an account shares with the site, as
 * {@link WebViewIdentityAccount.shared}.
 */
export const WEBVIEW_IDENTITY_FIELDS = [
  "name",
  "email",
  "username",
  "phone-number",
  "picture",
] as const;

/** One of {@link WEBVIEW_IDENTITY_FIELDS}. */
export type WebViewIdentityField = (typeof WEBVIEW_IDENTITY_FIELDS)[number];

/** An identity provider, as {@link DomicileIdentityEvent.providers} lists it. */
export type WebViewIdentityProvider = {
  /** Its site, as the browser names it, such as `google.com`. */
  readonly name: string;
  /** Its icon as a `data:` URL, or `""`. */
  readonly icon: string;
  /** The signing-in site's privacy policy, as the provider lists it, or `""`. */
  readonly privacyPolicy: string;
  /** The signing-in site's terms of service, as the provider lists them, or `""`. */
  readonly termsOfService: string;
  /** The user is signed out of it, so it offers no accounts. */
  readonly signedOut: boolean;
  /** It can sign in another account, with `signInToProvider`. */
  readonly addAccount: boolean;
};

/** An account, as {@link DomicileIdentityEvent.accounts} lists it. */
export type WebViewIdentityAccount = {
  /** Its provider: an index into {@link DomicileIdentityEvent.providers}. */
  readonly provider: number;
  /** The name the provider shows. */
  readonly name: string;
  /** Its email or other identifier. */
  readonly identifier: string;
  /** Its picture as a `data:` URL, or `""`. */
  readonly picture: string;
  /** The user signed in to the site with it before. */
  readonly returning: boolean;
  /**
   * What signing in with it shares with the site, to say so. Empty when
   * there is nothing to say, as for a returning account.
   */
  readonly shared: readonly WebViewIdentityField[];
};

/** The dialogs a page can open, as {@link DomicileDialogEvent.dialogType}. */
export const WEBVIEW_DIALOG_TYPES = [
  "alert",
  "confirm",
  "prompt",
  "beforeunload",
] as const;

export type WebViewDialogType = (typeof WEBVIEW_DIALOG_TYPES)[number];

/** A site's stored choice for a permission. `ask` prompts the shell. */
export const WEBVIEW_PERMISSION_SETTINGS = ["ask", "allow", "block"] as const;

export type WebViewPermissionSetting =
  (typeof WEBVIEW_PERMISSION_SETTINGS)[number];

/** The kinds of device {@link HTMLWebViewElement.setMediaDevice} takes. */
export const WEBVIEW_MEDIA_DEVICE_KINDS = ["camera", "microphone"] as const;

export type WebViewMediaDeviceKind =
  (typeof WEBVIEW_MEDIA_DEVICE_KINDS)[number];

/**
 * Global declarations for the engine's `<webview>`.
 *
 * Merged into the global `HTMLWebViewElement` because `@types/react` already
 * declares an empty one for JSX `ref`s. A separate exported type would not be
 * assignable to it. The engine ships no `.d.ts`, so the interface is written
 * out here.
 */
declare global {
  // An `interface` so it can merge with existing declarations.
  interface HTMLWebViewElement extends HTMLElement {
    /** The address to load. Reflects the `src` attribute. */
    src: string;
    /** Whether {@link HTMLWebViewElement.goBack} would navigate. */
    readonly canGoBack: boolean;
    /** Whether {@link HTMLWebViewElement.goForward} would move the page. */
    readonly canGoForward: boolean;
    /**
     * Whether the page is loading. Changes fire
     * {@link WEBVIEW_LOADING_CHANGE_EVENT}.
     */
    readonly loading: boolean;
    /**
     * How far the page has loaded, from 0.1 when a load starts to 1 when it
     * finishes or stops. `0` until the first load starts. Meaningful only
     * while {@link HTMLWebViewElement.loading}. Changes fire
     * {@link WEBVIEW_LOAD_PROGRESS_CHANGE_EVENT}.
     */
    readonly loadProgress: number;
    /**
     * The current address, as a browser's address bar shows it. Differs from
     * {@link HTMLWebViewElement.src} after links and redirects.
     *
     * `""` until the first navigation commits. Changes fire
     * {@link WEBVIEW_PAGE_CHANGE_EVENT}.
     */
    readonly url: string;
    /**
     * The connection security of {@link HTMLWebViewElement.url}: one of
     * {@link WEBVIEW_SECURITY_LEVELS}, or `""` before the first commit.
     *
     * Typed as `string` because it is external data; parse it into
     * {@link WebViewSecurity}.
     */
    readonly security: string;
    /**
     * The zoom factor, where 1 is 100%. Changes fire
     * {@link WEBVIEW_ZOOM_CHANGE_EVENT}.
     */
    readonly zoom: number;
    /**
     * Set the zoom factor. Throws a `RangeError` outside 0.25 to 5. The result
     * fires {@link WEBVIEW_ZOOM_CHANGE_EVENT}.
     */
    setZoom(factor: number): void;
    /**
     * The page's best linked icon (SVG first, then largest) as an absolute
     * URL, or `""` if none. Changes fire {@link WEBVIEW_FAVICON_CHANGE_EVENT}.
     */
    readonly favicon: string;
    /**
     * The page's `<meta name="description">`, trimmed, or `""` if none.
     * Changes fire {@link WEBVIEW_DESCRIPTION_CHANGE_EVENT}.
     */
    readonly description: string;
    /**
     * The address of the link under the pointer, or `""` if none, for a status
     * bubble like Chrome's. Changes fire {@link WEBVIEW_TARGET_URL_CHANGE_EVENT}.
     */
    readonly targetUrl: string;
    /**
     * The tooltip under the pointer, such as a `title`, or `""` if none. The
     * engine draws no tooltip for the page, so the shell does. `""` while the
     * pointer is outside the page. Changes fire
     * {@link WEBVIEW_TOOLTIP_CHANGE_EVENT}.
     */
    readonly tooltip: string;
    /**
     * Where the pointer was when {@link HTMLWebViewElement.tooltip} appeared,
     * in the element's CSS pixels from its top left.
     */
    readonly tooltipX: number;
    readonly tooltipY: number;
    /**
     * Find `text` and select the next match, or the previous one when
     * `backward` is true. Repeating the same text steps through matches; `""`
     * ends the find and clears the selection. Results fire
     * {@link WEBVIEW_FIND_CHANGE_EVENT}.
     */
    find(text: string, backward?: boolean): void;
    /** End the find, keeping the current match selected. */
    stopFinding(): void;
    /** The match count across all frames, or 0 with no active find. */
    readonly findMatches: number;
    /** The 1-based index of the selected match, or 0 if none. */
    readonly findActiveMatch: number;
    /**
     * The size an `extensionpopup` view's page sized itself to, in CSS pixels,
     * as Chrome sizes its toolbar popup: between 25x25 and 800x600, growing
     * while the page loads. Size the view to it. Both 0 before the first
     * layout, and always 0 without `extensionpopup`. Changes fire
     * {@link WEBVIEW_CONTENT_SIZE_CHANGE_EVENT}.
     */
    readonly contentWidth: number;
    readonly contentHeight: number;
    /**
     * Whether the page is fullscreen, as a video's fullscreen button makes it.
     * The page fills the view's box; the shell grows the view to fill the
     * screen. Escape in the page ends it. Changes fire
     * {@link WEBVIEW_PAGE_FULLSCREEN_CHANGE_EVENT}.
     */
    readonly pageFullscreen: boolean;
    /** Take the page out of fullscreen, as Escape does. */
    exitPageFullscreen(): void;
    /**
     * Whether the page keeps the screens on with a screen wake lock: its own
     * `navigator.wakeLock`, or a video playing. Changes fire
     * {@link WEBVIEW_WAKE_LOCK_CHANGE_EVENT}.
     */
    readonly wakeLock: boolean;
    /**
     * Why the page's renderer went away, or `""` while it runs. The view then
     * draws nothing, so the shell can show its own message over or under it.
     * {@link HTMLWebViewElement.reload} or a new `src` starts a new renderer.
     * Changes fire {@link WEBVIEW_RENDER_PROCESS_CHANGE_EVENT}.
     */
    readonly renderProcessGone: WebViewRenderProcessGone | "";
    /**
     * Chromium's code for the renderer that went away: its wait status, or
     * the browser's own code when the browser ended it. 0 while it runs. For
     * logs; branch on {@link HTMLWebViewElement.renderProcessGone}.
     */
    readonly renderProcessExitCode: number;
    /**
     * Why the page failed to load, or `""` while it loaded. The page is blank
     * then, for the shell to draw the error over. Changes to it and the
     * attributes below fire {@link WEBVIEW_PAGE_FAILURE_CHANGE_EVENT}.
     */
    readonly pageFailure: WebViewPageFailure | "";
    /** The address that failed, or `""`. */
    readonly pageFailureUrl: string;
    /** Chromium's name for the error, e.g. `ERR_NAME_NOT_RESOLVED`, or `""`. */
    readonly pageFailureError: string;
    /** The HTTP status for an `http` failure; otherwise 0. */
    readonly pageFailureHttpStatus: number;
    /**
     * Whether {@link HTMLWebViewElement.proceedPastWarning} loads the page
     * anyway: a certificate the user may override, or a warning.
     */
    readonly pageFailureCanProceed: boolean;
    /**
     * Load the page a certificate or safety warning stopped, as Chrome's
     * "Proceed anyway" does. Does nothing unless
     * {@link HTMLWebViewElement.pageFailureCanProceed}.
     */
    proceedPastWarning(): void;
    /**
     * Open DevTools for the page in a new browser window. If DevTools is
     * already open, the view showing it fires
     * {@link WEBVIEW_FOCUS_REQUEST_EVENT} instead.
     */
    inspect(): void;
    /**
     * Print the page, or the focused frame's selection, through the desktop's
     * print dialog.
     */
    print(): void;
    /**
     * The page's site's setting for each of {@link WEBVIEW_PERMISSIONS}, or
     * `{}` for a page that is not `http`, `https` or `chrome-extension`.
     * Changes fire {@link WEBVIEW_SITE_PERMISSIONS_CHANGE_EVENT}.
     *
     * Keys and values are external data; parse them at the boundary.
     */
    sitePermissions(): Record<string, string>;
    /**
     * Store `setting` for `permission` on the page's site. The result fires
     * {@link WEBVIEW_SITE_PERMISSIONS_CHANGE_EVENT}. Throws a `TypeError` for
     * an unknown name, and an `InvalidStateError` when
     * {@link HTMLWebViewElement.sitePermissions} is empty.
     */
    setSitePermission(
      permission: WebViewPermission,
      setting: WebViewPermissionSetting,
    ): void;
    /**
     * The cameras and microphones, each most preferred first: a page that
     * names no device gets the first. The preference is the profile's, not
     * the site's. Rejects with an `InvalidStateError` before the view has a
     * page.
     *
     * External data; parse it at the boundary.
     */
    mediaDevices(): Promise<DomicileMediaDevices>;
    /**
     * Give device `id` to pages that ask for a `kind` without naming one.
     * Rejects with a `NotFoundError` when no connected device of that kind
     * has the id.
     */
    setMediaDevice(kind: WebViewMediaDeviceKind, id: string): Promise<void>;
    /**
     * How many elements in the page's main document match the CSS
     * `selector`. The page's own script cannot change the answer, and a
     * hidden page answers. Throws a `SyntaxError` for a selector that does
     * not parse. Rejects with an `InvalidStateError` before the view has a
     * page, and when the page gave no number, as when it navigated first.
     */
    countMatches(selector: string): Promise<number>;
    goBack(): void;
    goForward(): void;
    /**
     * Go back or forward in a new browser window, as a middle click on
     * Chrome's back button does. The window gets a copy of this view's
     * history and this view stays on its page. A private view's window is
     * private. Does nothing with nowhere to go.
     */
    goBackInNewWindow(): void;
    goForwardInNewWindow(): void;
    stop(): void;
    reload(): void;
  }

  // biome-ignore lint/style/useConsistentTypeDefinitions: declaration merging onto a built-in type is what `interface` is for and what a type alias cannot do
  interface HTMLElementTagNameMap {
    webview: HTMLWebViewElement;
  }

  /**
   * The {@link WEBVIEW_CONTEXT_MENU_EVENT} event. The engine defines it in
   * `domicile_context_menu_event.idl`.
   */
  interface DomicileContextMenuEvent extends Event {
    /** The click, in CSS pixels from the view's top left. */
    readonly x: number;
    readonly y: number;
    /** The absolute link address, or `""` for none. */
    readonly linkUrl: string;
    readonly linkText: string;
    /** The absolute image, video or audio address, or `""` for none. */
    readonly srcUrl: string;
    /**
     * One of {@link WEBVIEW_MEDIA_TYPES}. A `string` because it is external
     * data; parse it at the boundary.
     */
    readonly mediaType: string;
    /** Whether an image has pixels to copy. A broken image has none. */
    readonly hasImageContents: boolean;
    /** The selected text, or `""`. */
    readonly selectionText: string;
    /** Whether the click was in an editable element. */
    readonly isEditable: boolean;
    /** What the page reports can be done where the click was. */
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly canCut: boolean;
    readonly canCopy: boolean;
    readonly canPaste: boolean;
    readonly canDelete: boolean;
    readonly canSelectAll: boolean;
    /**
     * Do one of {@link WEBVIEW_CONTEXT_MENU_ACTIONS} for this menu. Throws a
     * `TypeError` for an unknown action, a `NotSupportedError` for one this
     * menu does not offer (a link action with no link), and an
     * `InvalidStateError` once a newer menu has replaced this one.
     */
    run(action: WebViewContextMenuAction): void;
  }

  /**
   * The {@link WEBVIEW_FILE_CHOOSER_EVENT} event.
   *
   * Paths are absolute or relative to home, where `""` is home. A path
   * containing `..` throws a `TypeError`.
   */
  interface DomicileFileChooserEvent extends Event {
    /**
     * One of {@link WEBVIEW_FILE_CHOOSER_MODES}. A `string` because it is
     * external data; parse it at the boundary.
     */
    readonly mode: string;
    /**
     * Accepted file extensions, lowercase without the dot. MIME types such as
     * `image/*` are already expanded. Empty means any file.
     */
    readonly accept: readonly string[];
    /** The name the page suggests for a `save`; `""` otherwise. */
    readonly suggestedName: string;
    /** The absolute home directory. */
    readonly home: string;
    /**
     * The absolute folder a picker starts in, or `""` for `home`: a download
     * starts in the download folder. `undefined` from an engine without it.
     */
    readonly currentFolder: string | undefined;
    /**
     * Answer with the picked paths. `open-multiple` takes one or more; other
     * modes take exactly one. Otherwise throws a `TypeError`. Answering twice
     * throws an `InvalidStateError`.
     */
    choose(paths: readonly string[]): void;
    /** Answer that nothing was picked. */
    cancel(): void;
  }

  /**
   * The {@link WEBVIEW_PERMISSION_REQUEST_EVENT} event. The engine defines it
   * in `domicile_permission_request_event.idl`.
   */
  interface DomicilePermissionRequestEvent extends Event {
    /** The asking site's origin, such as `https://meet.google.com`. */
    readonly origin: string;
    /**
     * What it asks for, from {@link WEBVIEW_PERMISSIONS}. Camera and
     * microphone may come together. `string`s because they are external data;
     * parse them at the boundary.
     */
    readonly permissions: readonly string[];
    /**
     * Allow or block the site, storing the choice, or close without choosing.
     * Answering twice, or after
     * {@link WEBVIEW_PERMISSION_REQUEST_WITHDRAWN_EVENT}, throws an
     * `InvalidStateError`.
     */
    allow(): void;
    deny(): void;
    dismiss(): void;
  }

  /** A camera or microphone, as `mediaDevices()` lists it. */
  type DomicileMediaDevice = {
    /** The system's id for it, which `setMediaDevice()` takes. */
    readonly id: string;
    /** The name the system gives it, such as `USB Camera`. */
    readonly name: string;
  };

  /** Each kind's devices, most preferred first. */
  type DomicileMediaDevices = {
    readonly cameras: readonly DomicileMediaDevice[];
    readonly microphones: readonly DomicileMediaDevice[];
  };

  /** A device a {@link DomicileDeviceRequestEvent} offers. */
  type DomicileDevice = {
    /** Names the device to `choose()`. Never reused. */
    readonly id: number;
    /** The name Chrome's chooser shows, such as `Nano X`. */
    readonly name: string;
  };

  /**
   * The {@link WEBVIEW_DEVICE_REQUEST_EVENT} event. The engine defines it in
   * `domicile_device_request_event.idl`.
   */
  interface DomicileDeviceRequestEvent extends Event {
    /**
     * Chrome's question, naming the site and the kind of device, such as
     * `solflare.com wants to connect to a HID device`.
     */
    readonly title: string;
    /** Whether several devices may be chosen. */
    readonly multiple: boolean;
    /**
     * Whether the browser has listed the devices yet. Until it has,
     * {@link DomicileDeviceRequestEvent.devices} is empty because nothing is
     * known.
     */
    readonly listed: boolean;
    /**
     * The devices on offer, in Chrome's order. External data; parse it at the
     * boundary.
     */
    devices(): readonly DomicileDevice[];
    /**
     * Give the page the devices with these ids. Throws a `TypeError` for no
     * ids, several when not `multiple`, an id twice or one never offered.
     * Answering twice, or after
     * {@link WEBVIEW_DEVICE_REQUEST_WITHDRAWN_EVENT}, throws an
     * `InvalidStateError`.
     */
    choose(ids: readonly number[]): void;
    /** Give the page no device. */
    cancel(): void;
  }

  /**
   * The {@link WEBVIEW_DIALOG_EVENT} event. The engine defines it in
   * `domicile_dialog_event.idl`.
   */
  interface DomicileDialogEvent extends Event {
    /**
     * One of {@link WEBVIEW_DIALOG_TYPES}. External data; parse it at the
     * boundary.
     */
    readonly dialogType: string;
    /**
     * The calling frame's site, such as `https://example.com`, or `null` for
     * one with no site.
     */
    readonly origin: string;
    /** The text the page passed. Empty for `beforeunload`. */
    readonly message: string;
    /** `prompt()`'s initial text. Empty for the others. */
    readonly defaultValue: string;
    /**
     * OK, or Leave for `beforeunload`. `value` is what `prompt()` returns; the
     * others ignore it. Answering twice, or after
     * {@link WEBVIEW_DIALOG_WITHDRAWN_EVENT}, throws an `InvalidStateError`.
     */
    accept(value?: string): void;
    /**
     * Cancel, or Stay for `beforeunload`. An alert has only OK; either closes
     * it.
     */
    dismiss(): void;
  }

  /**
   * The {@link WEBVIEW_EXTERNAL_APP_EVENT} event. The engine defines it in
   * `domicile_external_app_event.idl`.
   */
  interface DomicileExternalAppEvent extends Event {
    /** The link, such as `zoommtg://zoom.us/join?confno=1`. */
    readonly url: string;
    /** The site that opened it, such as `https://zoom.us`, or `""` for none. */
    readonly origin: string;
    /**
     * Whether {@link DomicileExternalAppEvent.open} may remember the choice.
     * Only a secure site may.
     */
    readonly mayRemember: boolean;
    /**
     * Open the link in its scheme's default application. With `remember` and
     * {@link DomicileExternalAppEvent.mayRemember}, the site opens these links
     * without asking from then on. Answering twice, or after
     * {@link WEBVIEW_EXTERNAL_APP_WITHDRAWN_EVENT}, throws an
     * `InvalidStateError`.
     */
    open(remember?: boolean): void;
    /** Open nothing. */
    dismiss(): void;
  }

  /**
   * The {@link WEBVIEW_SIGN_IN_EVENT} event. The engine defines it in
   * `domicile_sign_in_event.idl`.
   */
  interface DomicileSignInEvent extends Event {
    /** The server or proxy that asked, such as `https://example.com/`. */
    readonly url: string;
    /**
     * Its name for what is behind the sign-in, as the server sent it. May be
     * `""`.
     */
    readonly realm: string;
    /** Whether a proxy asked rather than the site. */
    readonly proxy: boolean;
    /** False when the password would cross the network unencrypted. */
    readonly secure: boolean;
    /**
     * Send the user name and password. Answering twice, or after
     * {@link WEBVIEW_SIGN_IN_WITHDRAWN_EVENT}, throws an `InvalidStateError`.
     */
    signIn(username: string, password: string): void;
    /** Cancel. */
    dismiss(): void;
  }

  /**
   * The {@link WEBVIEW_PROMPT_EVENT} event. The engine defines it in
   * `domicile_prompt_event.idl`.
   */
  interface DomicilePromptEvent extends Event {
    /** What is asked: one of {@link WEBVIEW_PROMPT_KINDS}. */
    readonly kind: WebViewPromptKind;
    /** The site that asked, such as `https://vscode.dev`, or `""`. */
    readonly origin: string;
    /** A file's, device's or extension's name; `""` for the others. */
    readonly subject: string;
    /**
     * A file's full path, the certificates to pick from, or an extension's
     * permissions.
     */
    readonly details: readonly string[];
    /** The PIN a Bluetooth device shows, or `""`. */
    readonly pin: string;
    /**
     * Answer yes, with the picked entry of `details` and the typed text where
     * the kind reads them. Answering twice, or after
     * {@link WEBVIEW_PROMPT_WITHDRAWN_EVENT}, throws an `InvalidStateError`.
     */
    accept(choice?: number, text?: string): void;
    /** Answer no. */
    dismiss(): void;
  }

  /**
   * The {@link WEBVIEW_PICKER_EVENT} event. The engine defines it in
   * `domicile_picker_event.idl`.
   */
  interface DomicilePickerEvent extends Event {
    /** What to pick: one of {@link WEBVIEW_PICKER_KINDS}. */
    readonly kind: WebViewPickerKind;
    /** The control's value now, or the typed text for `list`. */
    readonly value: string;
    /** The control's `min`, `max` and `step` as written, or `""`. */
    readonly min: string;
    readonly max: string;
    readonly step: string;
    /** Suggestions: a `<datalist>`'s values, or a color input's colors. */
    readonly options: readonly string[];
    /** Each option's label at the same index, or `""` for none. */
    readonly labels: readonly string[];
    /** The control's box in the element's CSS pixels. */
    readonly anchorX: number;
    readonly anchorY: number;
    readonly anchorWidth: number;
    readonly anchorHeight: number;
    /**
     * Pick `value`, in the kind's format. Answering twice, or after
     * {@link WEBVIEW_PICKER_WITHDRAWN_EVENT}, throws an `InvalidStateError`.
     */
    choose(value: string): void;
    /** Keep the old value. */
    cancel(): void;
  }

  /**
   * The {@link WEBVIEW_IDENTITY_EVENT} event. The engine defines it in
   * `domicile_identity_event.idl`.
   */
  interface DomicileIdentityEvent extends Event {
    /** Which step to show: one of {@link WEBVIEW_IDENTITY_STEPS}. */
    readonly step: WebViewIdentityStep;
    /**
     * The page asked from its own sign-in button, so show the step over the
     * page. Otherwise the site offers it unasked: leave the page usable.
     */
    readonly button: boolean;
    /** The site signing in, as the browser names it, such as `medium.com`. */
    readonly site: string;
    /** The frame asking, when that is another site's, or `""`. */
    readonly frameSite: string;
    /** What signing in is for: one of {@link WEBVIEW_IDENTITY_PURPOSES}. */
    readonly purpose: WebViewIdentityPurpose;
    /** On `verifying`: signing in without the user picking. */
    readonly automatic: boolean;
    /** On `error`: the provider's error code, such as `access_denied`, or `""`. */
    readonly error: string;
    /** On `error`: the provider's page about it, or `""`. */
    readonly errorUrl: string;
    /** The providers. */
    providers(): WebViewIdentityProvider[];
    /** On `accounts`, those to pick from; on `verifying`, the one signing in. */
    accounts(): WebViewIdentityAccount[];
    /**
     * Sign in with `accounts()[account]`, on `accounts`. Answering twice,
     * after {@link WEBVIEW_IDENTITY_WITHDRAWN_EVENT}, or on a step that does
     * not take it throws an `InvalidStateError`; an index out of range throws
     * a `TypeError`.
     */
    choose(account: number): void;
    /**
     * Open `providers()[provider]`'s sign-in page in a browser window, on
     * `accounts` and `signed-out`.
     */
    signInToProvider(provider: number): void;
    /** Open `errorUrl` in a browser window, on an `error` that has one. */
    moreDetails(): void;
    /** Close the step, as the user's close. */
    dismiss(): void;
  }

  /**
   * The {@link WEBVIEW_WILL_NAVIGATE_EVENT} event. The engine defines it in
   * `domicile_will_navigate_event.idl`.
   */
  interface DomicileWillNavigateEvent extends Event {
    /** Where the page would go. */
    readonly url: string;
  }

  /**
   * Types `addEventListener` for the events that carry data. Merged into
   * `HTMLElementEventMap` because `HTMLWebViewElement` has no event map of its
   * own.
   */
  // biome-ignore lint/style/useConsistentTypeDefinitions: declaration merging onto a built-in type is what `interface` is for and what a type alias cannot do
  interface HTMLElementEventMap {
    "domicile-guest-keydown": KeyboardEvent;
    "domicile-file-chooser": DomicileFileChooserEvent;
    "domicile-context-menu": DomicileContextMenuEvent;
    "domicile-permission-request": DomicilePermissionRequestEvent;
    "domicile-device-request": DomicileDeviceRequestEvent;
    "domicile-dialog": DomicileDialogEvent;
    "domicile-external-app": DomicileExternalAppEvent;
    "domicile-identity": DomicileIdentityEvent;
    "domicile-picker": DomicilePickerEvent;
    "domicile-prompt": DomicilePromptEvent;
    "domicile-sign-in": DomicileSignInEvent;
    "domicile-will-navigate": DomicileWillNavigateEvent;
  }
}

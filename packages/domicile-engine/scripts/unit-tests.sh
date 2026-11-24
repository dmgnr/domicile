#!/usr/bin/env bash
# The fork's own gtest cases, in domicile_unittests.
#
# The cheapest thing that can fail and the only thing that exercises the
# broker's bookkeeping directly — a surface brokered per app, an embed held for
# the app it names — so this runs before the guards, which take longer and say
# less about why.
#
# AND COUNTED BEFORE IT IS RUN, because `--gtest_filter` matching nothing exits
# 0. A suite that was renamed or never linked is otherwise a silent pass, which
# is what happened: `ShellURLLoaderFactoryTest` and `ShellDocumentTest` were in
# the build and not in this list, so they compiled on every run and executed on
# none. Between them they are what refuses a path traversal out of the shell
# root and what pins the one document every desktop is.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
. "$ROOT/packages/domicile-engine/scripts/lib-engine-guard.sh"
require_engine_out

FILTER='PinchMetadataTest.*:ScrollMetadataTest.*:FrameSinkBrokerTest.*:WindowDiffTest.*:EngineEventQueueTest.*:ShortcutRegistryTest.*:ShellURLLoaderFactoryTest.*:ShellDocumentTest.*:ShellSourceTest.*:CursorShapeTest.*:CommandProtocolTest.*:DomicileDisplayListTest.*:DomicileKeyboardLayoutTest.*:ShellWindowsTest.*:ShellWindowPlacesTest.*:ShellWindowsToFitTest.*:LineFramerTest.*:DesktopPrefsTest.*:SurfaceCropTest.*:SurfaceTransformTest.*:SurfaceAlphaTest.*:ExtensionInstallerTest.*:ExtensionSettingsTest.*:ExtensionTrayEntryTest.*:DeskTabsTest.*:DeskGeometryTest.*:DomicileDisplayRegionsTest.*:DomicileDeskTargeterTest.*:PlaceholderStageTest.*:SystemCallTest.*:PortalRequestTest.*:FileChoiceTest.*:DisplayCaptureTest.*:CapturedFourccTest.*:DisplayCaptureTargetTest.*:HeldChordsTest.*:ForwardedKeysTest.*:SitePermissionsTest.*:ControlChannelTest.*:DeviceChoicesTest.*:SurfaceFramesTest.*:SurfaceHoldsTest.*:GuestDialogsTest.*:DownloadTallyTest.*:SurfaceSubmitsTest.*:SurfaceBacklogTest.*:PrivatePagesTest.*:ShellOriginTest.*:AppRootsTest.*:AppChannelTest.*:AppDocumentTest.*:WebViewUrlTest.*:ShellFetchTest.*:BrowserWindowCaptureTargetTest.*:BrowserWindowListingTest.*:ShellWindowWaitTest.*:ShellSwapTest.*:DeskCursorThemeSourceTest.*:XCursorThemeTest.*:XCursorThemeDirectoryTest.*:SyncedFrameTest.*:RenderProcessTest.*:ShellDeathTest.*:ProbeWaitTest.*:ScreenCaptureTest.*:ScreenChoiceTest.*:WebViewPartitionTest.*:WillNavigateTest.*:DeskActivityTest.*:DeskPointerTest.*:PointerWarpTest.*:PageMatchesTest.*:ForceDarkTest.*:HiddenFromCapturesTest.*:LocaleFallbackTest.*:DomicileLcdTextActivationTest.*:RtkitTest.*:DeskGesturesTest.*:NativeGestureSequenceTest.*:EdgeSwipeTest.*:DeskPointerHidingTest.*:PointerHidingTest.*:InputMethodLinesTest.*:DeskModifierTapsTest.*:TapModifierOfTest.*:IdentityDialogTest.*:PictureInPictureVideosTest.*:BufferColorTest.*:ElectronProtocolTest.*:ElectronAppTest.*:ElectronSessionEventsTest.*:ElectronPageCallTest.*:ElectronPageReportsTest.*:ElectronInputTest.*:ElectronPermissionForTest.*:ElectronSchemesTest.*:ContextBridgeTest.*:ContextMenuTest.*:UnacceleratedMotionTest.*:WarpLandingTest.*:PointerConfinementBoxesTest.*:BrowserProfilesTest.*:UnfocusedWebViewsTest.*:HistoryMenuTest.*:ShellDevServerTest.*:ShellDevServerLoadTest.*:ShellDevServerGoneTest.*:ForCaptureToolsTest.*:DeskDragTest.*:DomicileMonitorTwinActivationTest.*:CursorDisplayTest.*:DomicileHiddenPageTilesTest.*:ChannelDisconnectOrderTest.*'

# Every suite in the filter, counted rather than estimated: FrameSinkBroker 57,
# WindowDiff 7, EngineEventQueue 9, ShortcutRegistry 17, ShellURLLoaderFactory
# 16, ShellDocument 13, ShellSource 6, CursorShape 3, CommandProtocol 75,
# DomicileDisplayList 13, DomicileKeyboardLayout 3, ShellWindows 10,
# ShellWindowPlaces 8, LineFramer 4, DesktopPrefs 1, SurfaceCrop 3,
# SurfaceTransform 3, SurfaceAlpha 2, BufferColor 4, ExtensionInstaller 4,
# ExtensionSettings 7, ExtensionTrayEntry 3, DeskTabs 12, DeskGeometry 32,
# DomicileDisplayRegions 27, DomicileDeskTargeter 4, PlaceholderStage 3,
# SystemCall 6, PortalRequest 3, FileChoice 13, DisplayCapture 9,
# CapturedFourcc 1, DisplayCaptureTarget 4, HeldChords 6, ForwardedKeys 5,
# SitePermissions 11,
# ControlChannel 30, DeviceChoices 9, SurfaceFrames 8, SurfaceHolds 4,
# GuestDialogs 6, DownloadTally 6, SurfaceSubmits 4, SurfaceBacklog 4,
# PrivatePages 3, ShellOrigin 4, AppRoots 4, AppChannel 3, AppDocument 3,
# WebViewUrl 5, ShellFetch 22, BrowserWindowCaptureTarget 3, BrowserWindowListing 3, ShellWindowWait 4, ShellSwap 12,
# DeskCursorThemeSource 3, XCursorTheme 5, XCursorThemeDirectory 4,
# SyncedFrame 7, RenderProcess 3, ShellDeath 5, ProbeWait 3, ScreenCapture 7,
# ScreenChoice 3, WebViewPartition 5, WillNavigate 4, DeskActivity 2,
# DeskPointer 5, PointerWarp 10, PointerConfinementBoxes 4, PageMatches 8, ForceDark 2, HiddenFromCaptures 7,
# LocaleFallback 2, DomicileLcdTextActivation 2, Rtkit 1, DeskGestures 14,
# NativeGestureSequence 3, EdgeSwipe 10, DeskPointerHiding 2, PointerHiding 8,
# InputMethodLines 7, DeskModifierTaps 13, TapModifierOf 1, IdentityDialog 11,
# PictureInPictureVideos 15, ElectronProtocol 69, ElectronApp 89,
# ElectronSessionEvents 1, ElectronPageCall 3, ElectronPageReports 12,
# ElectronInput 12, ElectronPermissionFor 2, ElectronSchemes 8,
# ContextBridge 11, ContextMenu 13, UnacceleratedMotion 5, WarpLanding 4,
# BrowserProfiles 12, UnfocusedWebViews 7, HistoryMenu 2, ShellDevServer 7,
# ShellDevServerLoad 4, ShellDevServerGone 1, ForCaptureTools 2, DeskDrag 6,
# DomicileMonitorTwinActivation 1, CursorDisplay 7, DomicileHiddenPageTiles 4,
# ChannelDisconnectOrder 2.
#
# 1010, and it was 1007 — an Electron app's preconnects, dictionaries and GPU
# are two more ElectronApp cases and the ElectronSessionEvents suite. Before
# that
# 1007, and it was 1006 — a color matrix that brightens being refused is one
# more FrameSinkBroker case. Before that
# 1006, and it was 994 — an Electron app's sign-ins, certificates, network
# session calls and service workers are six more ElectronProtocol and six
# more ElectronApp cases. Before that
# 994, and it was 965 — what an Electron app's webContents hears of its page
# and asks of its input is twelve ElectronPageReports cases, twelve ElectronInput
# ones and five more ElectronApp ones. Before that
# 965, and it was 950 — app windows' navigations, history restore and entry
# removal, and whether an app listens for navigations are six more
# ElectronProtocol cases and nine more ElectronApp ones. Before that
# 950, and it was 939 — an Electron app's downloads are five more
# ElectronProtocol cases and six more ElectronApp ones. Before that
# 939, and it was 933 — an Electron app's page calls are three more
# ElectronApp cases and the ElectronPageCall suite. Before that
# 933, and it was 930 — which display changes refit the pointer is three
# more CursorDisplay cases. Before that
# 930, and it was 929 — claiming a named, installed extension the record
# lacks is one more ExtensionInstaller case. Before that
# 929, and it was 927 — a channel endpoint's disconnect queued behind its
# messages is the ChannelDisconnectOrder suite. Before that
# 927, and it was 925 — removing one copy from the clipboard history, and the
# current flag on each copy, is two more ControlChannel cases. Before that
# 925, and it was 924 — VERBOSE for a shell's console.debug is one more
# CommandProtocol case. Before that
# 924, and it was 922 — `domicile set-log-level` is two CommandProtocol
# cases. Before that 922, and it was 918 — a hidden page keeping the tiles it draws is the
# DomicileHiddenPageTiles suite. Before that 918, and it was 914 — the display the pointer is drawn for is the
# CursorDisplay suite. Before that 914, and it was 913 — the raster queue offering every tile activation
# waits on through a monitor's tiling is the DomicileMonitorTwinActivation
# suite. Before that 913, and it was 907 — a drag on the desk is the DeskDrag suite. Before that
# 897, and it was 895 — the views an Electron app's window holds, listed to
# the compositor for a shot of the window, are the ForCaptureTools suite.
# Before that 895, and it was 891 — a shell clicking a selector's first shown match in a
# page is four PageMatches cases. Before that 891, and it was 885 — an agent's
# DevTools methods to a browser window are six CommandProtocol cases. Before that
# 884, and it was 867 — serving a shell from `domicile dev`'s dev server is
# twelve ShellDevServer cases, two ShellSource, one ShellSwap and two
# CommandProtocol. Before that
# 867, and it was 865 — a <webview>'s back and forward lists are the
# HistoryMenu suite. Before that
# 865, and it was 859 — dropping another shell's shortcut claims on a swap is
# three more ShortcutRegistry cases and three more ShellSwap ones. Before that
# 859, and it was 858 — the extensions the user installs in one profile
# going into every other are one more BrowserProfiles case. Before that
# 858, and it was 855 — the Settings app's Profiles page is three more
# CommandProtocol cases. Before that
# 855, and it was 854 — a profile's extension switches are one more
# BrowserProfiles case than the extensions it turned on were. Before that
# 854, and it was 851 — sites the user pins to a profile are three more
# BrowserProfiles cases. Before that
# 851, and it was 847 — `domicile open --profile` is four more CommandProtocol
# cases. Before that
# 847, and it was 840 — Energy Saver slowing only unfocused <webview>s is the
# UnfocusedWebViews suite. Before that
# 840, and it was 837 — routing a page to its site's profile is three more
# BrowserProfiles cases. Before that
# 837, and it was 832 — the desk's browser profiles are four BrowserProfiles
# cases and one ControlChannel case. Before that
# 832, and it was 830 — a desktop getUserMedia(), as Electron apps capture a
# desktopCapturer source with, is two more ScreenCapture cases. Before that
# 830, and it was 828 — viz stopping a capture before or after a frame, which
# the screenshot and cast now say, is two more DisplayCapture cases. Before
# that
# 828, and it was 825 — the host's window moving when the host does is two
# more ShellWindows cases and one more ShellWindowPlaces one. Before that
# 825, and it was 824 — where a video in picture-in-picture came from in its
# page is one more PictureInPictureVideos case. Before that
# 824, and it was 822 — the shell and app modules being cross-origin isolated,
# and no other page, is two more ShellOrigin cases. Before that
# 822, and it was 819 — an Electron app's message boxes are two more
# ElectronProtocol cases and one more ElectronApp one. Before that
# 819, and it was 815 — an Electron app's menu bar is two more
# ElectronProtocol cases and two more ElectronApp ones. Before that
# 815, and it was 808 — an Electron app's views (WebContentsView) and its
# pages' sizes are three more ElectronProtocol cases and four more ElectronApp
# ones. Before that
# 808, and it was 799 — an Electron app's permission request handler is
# three more ElectronProtocol cases, four more ElectronApp ones and two
# ElectronPermissionFor ones. Before that
# 799, and it was 798 — a window that has not drawn keeping its frames
# unthrottled is one more FrameSinkBroker case. Before that
# 798, and it was 787 — an Electron app's session calls (cookies, storage,
# cache, user agent) are six more ElectronProtocol cases and five more
# ElectronApp ones. Before that
# 787, and it was 785 — a Super tap held too long, and how long it was held,
# are two more DeskModifierTaps cases. Before that
# 785, and it was 784 — dropping the desk's pointer theme being an error is
# one more DeskCursorThemeSource case. Before that
# 784, and it was 783 — the tray menu's extension entries are one more
# case. Before that
# 783, and it was 771 — an Electron app's webRequest listeners are six more
# ElectronProtocol cases and six more ElectronApp ones. Before that
# 771, and it was 762 — Electron apps' own schemes, registered at start, are
# eight ElectronSchemes cases (one moved from ElectronProtocol), one more
# ElectronProtocol case and one more ElectronApp one. Before that
# 762, and it was 743 — an Electron app's sessions and protocol handlers
# are eight more ElectronProtocol cases and eleven more ElectronApp ones.
# Before that 743, and it was 741 — the input devices reaching an observer are one
# FrameSinkBroker case and one EngineEventQueue case. Before that
# 741, and it was 726 — a mouse's unaccelerated motion is five
# UnacceleratedMotion cases, the warp a game must not feel four WarpLanding
# ones, a confinement's boxes four PointerConfinementBoxes ones, and the
# channel's confinement and its region two ControlChannel ones. Before that
# 726, and it was 717 — an Electron window's sendSync and message ports are
# five more ElectronProtocol cases and four more ElectronApp ones. Before that
# 717, and it was 703 — the context menu's cases, which were built and never
# run, are thirteen ContextMenu cases, and a seek of a picture-in-picture
# video is one PictureInPictureVideos case. Before that 703, and it was 681 — an Electron window's preload and IPC are five more
# ElectronProtocol cases, six more ElectronApp ones and eleven ContextBridge
# ones. Before that 681, and it was 680 — each display's HDR state reaching the page is one
# ControlChannel case. Before that 680, and it was 677 — a display's color
# matrix reaching its window, and the two ways it is a bad message, are three
# FrameSinkBroker cases. Before that 677, and it was 651 — the Electron
# socket's requests and events are twelve ElectronProtocol cases, and an app on
# it is fourteen ElectronApp cases. Before that
# 651, and it was 650 — a panel's HDR state and luminances are one
# DomicileDisplayList case. Before that
# 650, and it was 645 — a client's image description is four BufferColor
# cases and one more FrameSinkBroker case. Before that 645, and it was 642 — 10-bit and half-float client buffers are three
# FrameSinkBroker cases. Before that 642, and it was 641 — a renderer sending a
# zoom that is no positive number is one FrameSinkBroker case. Before that 641,
# and it was 637 — a subsurface drawn inside its window is four cases. Before that 637, and it was
# 624 — the videos in picture-in-picture the shell lists and shows are thirteen
# PictureInPictureVideos cases. Before that 624, and it was 613 — a site's
# "Sign in with" dialogs asked of the shell are eleven IdentityDialog cases.
# Before that 613, and it was 611 — a window's toplevel id and each browser
# window's reaching the page are two ControlChannel cases. Before that 611, and
# it was 599 — a tap of a modifier alone is eleven DeskModifierTaps
# cases and one TapModifierOf case. Before that 599, and it was 598 — a cursor
# a client drew reaching the page is one ControlChannel case. Before that 598, and it was 591 — the control channel's input method messages are seven
# InputMethodLines cases. Before that 591, and it was 589 — a window's pointer lock or confinement reaching the page,
# and the page's answer reaching the compositor, are two ControlChannel cases.
# Before that 589, and it was 588 — a hand's relative motion reaching the compositor is one
# ControlChannel case. Before that 588, and it was 579 — an extension's settings are seven ExtensionSettings
# cases and two CommandProtocol cases. Before that 579, and it was 575 — a
# monitor sleeping by name is four DeskGeometry cases. Before that 575, and it was 574 — a panel's adaptive sync is one DomicileDisplayList
# case. Before that 574, and it was 569 — listing the browser windows for capture tools is three
# BrowserWindowListing cases, one FrameSinkBroker case and one EngineEventQueue
# case. Before that 569, and it was 567 — a panel's modes and the rate it scans out at are two
# DomicileDisplayList cases. Before that 567, and it was 564 — sending the bound
# swipes and holds to a window that inhibits shortcuts is three DeskGestures
# cases. Before that 564, and it was 563 — redrawing a display
# once its gamma ramp is set is one FrameSinkBroker case. Before that 563, and
# it was 551 — hiding the pointer while typing and after a pause is
# eight PointerHiding cases, two DeskPointerHiding cases, one DeskGestures case
# and one ControlChannel case. Before that 551, and it was 547 — keeping a destroyed buffer until viz returns it is
# four SurfaceHolds cases. Before that 547, and it was 543 — forwarding the
# swipes and holds the shell leaves to
# the apps is three DeskGestures cases and one ControlChannel case. Before
# that 543, and it was 531 — a touchscreen finger in from a display's edge is
# ten EdgeSwipe cases and one DeskGestures case, and a touch on a window one
# ControlChannel case. Before that 531, and it was 529 — night light is one
# more FrameSinkBroker case and one more DomicileDisplayList case. Before
# that 529, and it was 520 — the shell's touchpad
# gestures are six DeskGestures cases and three NativeGestureSequence ones.
# 520 includes three native pinch cases and one ControlChannel case.
# 516, and it was 504 — putting the old shell back when `load_shell`'s does
# not run is eight ShellSwap cases, one ControlChannel case, one
# CommandProtocol case, one ShellSource case and one ShellDocument case. Before that
# 498, and it was 486 — a warp that stays put over the window it focuses is
# one DeskPointer case and four PointerWarp ones; PointerWarpTest was never in
# the filter, so its six cases ran nowhere, and DeskPointer had four cases, not
# three. Before that 486, and it was 485 — the call that asks rtkit to raise a thread is one
# Rtkit case. Before that 485, and it was 483 — a tooltip fitting on its own monitor is two
# DeskGeometry cases. Before that 483, and it was 480 — giving a frame the monitor it is on is three
# DeskGeometry cases. Before that 480, and it was 478 — a tree ready to activate keeping its LCD-text tiles
# is two DomicileLcdTextActivation cases. Before that 478, and it was 476 — falling back to en-US for a string a locale lacks is
# two LocaleFallback cases. Before that 476, and it was 469 — what the shell hides from desk captures is seven
# HiddenFromCaptures cases. Before that 469, and it was 463 — holding a window's frames while viz is behind is four
# SurfaceBacklog cases and two SurfaceFrames ones. Before that 463, and it was 460 — the sites a desk draws dark are two ForceDark cases
# and one ControlChannel case. Before that 460, and it was 456 — counting a selector's matches in a <webview>'s page is
# four PageMatches cases. Before that 456, and it was 451 — where the pointer is on the desk, for screen casts, is
# three DeskPointer cases, and DeskActivityTest was never in the filter, so its
# two cases compiled and ran nowhere. Before that 451, and it was 449 — a window in shared memory, a software image or refused
# on the GPU, is two FrameSinkBroker cases. Before that 449, and it was 440 — a
# <webview>'s partition is five WebViewPartition cases, and which navigations
# ask the shell four WillNavigate ones. Before that 440, and it was 438 —
# listing and clearing a site's data is two CommandProtocol cases. Before that 438, and it was 435 — an app's channel ending its calls and dialing the
# next compositor is one AppChannel case and two SystemCall ones. Before that
# 435, and it was 434 — a browser window drawing while it is captured is one
# more FrameSinkBroker case. Before that 434, and it was 431 — a page's screen share picked before it is answered is
# three ScreenChoice cases. Before that 431, and it was 428 — the touchpad's disable-while-typing switch is three
# CommandProtocol cases. Before that 428, and it was 426 — a page's
# getDisplayMedia answered through the portal is two ScreenCapture cases.
# Before that 426, and it was 421 — where a forwarded key's release goes is five
# ForwardedKeys cases. Before that 421, and it was 417 — serving the shell's and an app's files only to their
# own origin is four ShellURLLoaderFactory cases. Before that 417, and it was
# 414 — a spike probe the browser never answers is three
# ProbeWait cases. Before that 414, and it was 406 — why a page's renderer went away is three
# RenderProcess cases, and the engine dying with the shell's renderer five
# ShellDeath ones.
# Before that 406, and it was 405 — the desk an empty layout leaves where the hardware
# put each display is one DeskGeometry case. Before that 405, and it was 403 —
# where a page's popup goes on another monitor is two
# DeskGeometry cases. Before that 403, and it was 402 — the answer a shell
# fetch holds is one ShellFetch case. Before that 402, and it was 399 — a compositor that hangs up being ended for the page
# and replaced is two ControlChannel cases, and the producer said to have gone
# is one FrameSinkBroker case. Before that 399, and it was 395 — the synced frames a move shows with reaching the page
# is one ControlChannel case, and an <app> with no frame set showing the
# newest heard is three SyncedFrame cases. Before that 395, and it was 394 —
# which display each tablet covers is one FrameSinkBroker case. Before that
# 394, and it was 390 — a synced frame's surface id is four SyncedFrame cases.
# Before that 390, and it was 386 — giving back a chord, a page's own claims and a closed
# page's leftovers are three ShortcutRegistry cases, and a window inhibiting
# shortcuts reaching the page is one ControlChannel case. Before that
# 386, and it was 385 — a window's parent and urgency reaching the page is
# one ControlChannel case. Before that 385, and it was 384 — a window's presentation and suspension reaching the page
# is one ControlChannel case. Before that 384, and it was 380 — keeping the desk
# through a blank is four DeskGeometry
# cases. Before that 380, and it was 368 — the desk's pointer theme is the DeskCursorThemeSource,
# XCursorTheme and XCursorThemeDirectory suites and one ControlChannel case.
# Before that 368, and it was 366 — run_app and open_url waiting for the shell window's
# first page is two CommandProtocol cases. Before that 366, and it was 361 —
# waiting for the shell window's first page is four ShellWindowWait cases and
# one CommandProtocol case. Before that 361, and it was 355 — a POST from the shell is six more ShellFetch
# cases. Before that 355, and it was 350 — capturing a browser window alone is three
# BrowserWindowCaptureTarget cases and two FrameSinkBroker ones. Before that
# 350, and it was 348 — each display's connector is two DomicileDisplayList
# cases. Before that 348, and it was 333 — the shell's fetches with the profile's cookies are 15
# ShellFetch cases. Before that 333, and it was 326 — the History app's history and browsing data are
# seven CommandProtocol cases. Before that 326, and it was 323 — listing and
# switching extensions for the Settings app is three CommandProtocol cases.
# Before that 323, and it was 304 — app modules are two ShellURLLoaderFactory cases, three
# CommandProtocol ones, the AppRoots, AppChannel and AppDocument suites, and
# WebViewUrl joining the filter with its two new cases. Before that 304, and it was 303 — a window's owner reaching the page is one more
# ControlChannel case. Before that 303, and it was 301 — only the shell's origin binding the broker is two
# ShellOrigin cases. Before that 301, and it was 300 — counting a <webview>'s finished downloads apart is one
# more DownloadTally case. Before that 300, and it was 301 — Ctrl+wheel zooming again drops the one WheelAction
# case. Before that 301, and it was 300 — a window's size and hints reaching the page is one
# more ControlChannel case. Before that 300, and it was 297 — private browsing ending with its last page is three
# PrivatePages cases. Before that 297, and it was 291 — fencing an shm frame's buffer instead of waiting for
# its copy is two FrameSinkBroker cases and four SurfaceSubmits ones. Before
# that 291, and it was 286 — adding up a <webview>'s downloads for their progress is
# five DownloadTally cases. Before that 286, and it was 280 — the dialog a guest's page has open is six
# GuestDialogs cases. Before that 280, and it was 279 — dropping a waiting embed when its page disconnects is
# one more FrameSinkBroker case. Before that 279, and it was 273 — matching viz's acks and presentation feedback to a
# window's frames is six SurfaceFrames cases. Before that 273, and it was 272 —
# Ctrl+wheel scrolling is one WheelAction case. Before
# that 272, and it was 263 — the ids a <webview>'s device chooser gives the shell
# are nine DeviceChoices cases. Before that 263, and it was 259 — the Settings app's media devices are four
# CommandProtocol cases. Before that 259, and it was 254 — telling a page why its surface ended, so it embeds
# again after a compositor restart, is five more FrameSinkBroker cases. Before
# that 254, and it was 248 — loading and uninstalling extensions from the Settings
# app are six CommandProtocol cases. Before that 248, and it was 246 — a window
# that asks viz for no BeginFrames and answers the ones viz sends anyway is two
# more FrameSinkBroker cases. Before that 246, and it was 241 — turning a
# client's transformed buffer upright is three
# SurfaceTransform cases, and SurfaceAlphaTest was never in the filter, so its
# two cases compiled and ran nowhere. Before that 241, and it was 235 — the Settings app's site permissions are four
# CommandProtocol cases and two SitePermissions ones. Before that 235, and it
# was 232 — a shell crossfading from the one before, and served
# fresh to the navigation that loads it, is two ShellDocument cases and one
# ShellURLLoaderFactory. Before that 232, and it was 230 — refusing a parent frame sink in another renderer is
# two more FrameSinkBroker cases. Before that 230, and it was 229 — the compositor's lines held until the page binds are
# one ControlChannel case. Before that 229, and it was 220 — a <webview>'s permissions are nine SitePermissions
# cases. Before that 220, and it was 223 — the engine takes no screenshots, which was three
# CommandProtocol cases. Before that 223, and it was 215 — pairing a chord's press with its release is six
# HeldChords cases and two more ShortcutRegistry ones. Before that 215, and it was 200 — a display capture is seven DisplayCapture cases, one
# CapturedFourcc, four DisplayCaptureTarget, two more FrameSinkBroker and one
# more EngineEventQueue. Before that 200, and it was 187 — FileChoiceTest was never in the filter, so its
# thirteen cases compiled and ran nowhere. Before that 187, and it was 184 — wrapping a page's answer to a portal request is three
# PortalRequest cases. Before that 184, and it was 183 — the shell document's script policy is one more
# ShellDocument case. Before that 183, and it was 178 — the viewport tiles are sized from and which monitor
# tiles are drawn out of memory is five more DomicileDisplayRegions cases.
# Before that 178, and it was 174 — wrapping a page's system call is four SystemCall
# cases. Before that 174, and it was 171 — when a <webview>'s frame is ready for a guest is three
# PlaceholderStage cases. Before that 171, and it was 168 — a screenshot is three CommandProtocol cases. Before that
# 168, and it was 164 — the tile memory a widget on monitors asks for is four
# more DomicileDisplayRegions cases. Before that 164, and it was 159 — which
# monitors' tilings a layer keeps and draws from, and how many, is five more
# DomicileDisplayRegions cases. Before that 159, and
# it was 155 — which monitor a warp lands on, so the arrow is drawn for it, is
# four DeskGeometry cases. Before that 155, and it was 151 — where a pointer on another monitor lands in the desk's
# page is four DomicileDeskTargeter cases. Before that 151, and it was 137 — every monitor the desk is shown on, at its own
# density, is one DeskGeometry case and thirteen DomicileDisplayRegions ones.
# Before that 137, and it was 144 — one page for the desk has no window a second page
# mirrors, which was seven FrameSinkBroker cases. Before that 144, and it was
# 136 — the one page a desk is, its box, scale, host and screen, is eight
# DeskGeometry cases. Before that 136, and it was 123 — a window a second page
# mirrors is seven more FrameSinkBroker cases, and the tally had that suite at
# 17 when the file held 23. Before that 123, and it was 121 — the factor tabs.setZoom sets and the zoom settings a
# desk tab takes are two more DeskTabs cases. Before that 121, and it was 114 — ShellWindowPlaces was never in the filter, so its five
# cases compiled and ran nowhere; with the two a window still loading its page
# added, that suite is seven. Before that 114, and it was 104 — which <webview> is the active tab, what is refused
# and which tabs a query names is ten DeskTabs cases. Before that 104, and it
# was 101 — how the tray spells a badge color and an icon is three
# ExtensionTrayEntry cases. Before that 101, and it was 98 — which extensions a profile installs, loads and
# uninstalls is three ExtensionInstaller cases. Before that 98, and it was 95 — the part of a client's buffer its window geometry names
# is three SurfaceCrop cases. Before that 95, and it was 94 — the browser's offers turned off is one DesktopPrefs
# case. Before that 94, and it was 90 — how the control channel splits the compositor's socket
# into lines is four LineFramer cases. Before that 90, and it was 82 — which displays want a shell window is eight ShellWindows
# cases, a suite of its own and so in the filter as well as in the sum. Before
# that it was 79 — the layout a producer states back is three more
# FrameSinkBroker cases. Before that 77 — the name a display list now carries,
# which is what an output profile matches a monitor on, is two more
# DomicileDisplayList cases. Before that 74 — the keymap the compositor sends
# is three DomicileKeyboardLayout cases. Before that 70, which the panel a
# display list now carries moved, and 66 before that, which the display list
# itself did, and 46 before THAT, which was not drift: WindowDiffTest and
# EngineEventQueueTest had always been in the filter and were never in the sum,
# so the floor sat 12 below the truth and a whole suite could have stopped
# linking with room to spare. That is the failure this exists to catch, so the
# number is the real one.
FLOOR=1010

# From inside the out directory, because this is a component build and the
# binary loads its own .so files from beside it.
cd "$ENGINE_OUT"

# Test names are the indented lines of --gtest_list_tests; suite names are not.
count=$(./domicile_unittests --gtest_filter="$FILTER" --gtest_list_tests |
  grep -cE '^  ' || true)
echo "$count tests match the fork's filter (floor $FLOOR)"
[ "$count" -ge "$FLOOR" ] || {
  annotate "only $count tests matched; the suites were renamed or did not link"
  exit 1
}

# The launcher prints a failed test's output in the middle of the run, and CI
# shows only the end of this log, so a failure read there named the test and
# nothing else. Run each failed test again, alone, so its own assertion or
# crash is the last thing printed.
log="$(mktemp)"
status=0
./domicile_unittests --gtest_filter="$FILTER" 2>&1 | tee "$log" || status=$?
[ "$status" -eq 0 ] && exit 0
failed="$(grep -oE '^    [A-Za-z0-9_]+\.[A-Za-z0-9_/]+ \(' "$log" |
  awk '{print $1}' | sort -u | paste -sd: || true)"
if [ -n "$failed" ]; then
  echo "== the failed tests again, alone: $failed =="
  ./domicile_unittests --gtest_filter="$failed" --single-process-tests 2>&1 |
    tail -150 || true
fi
exit "$status"

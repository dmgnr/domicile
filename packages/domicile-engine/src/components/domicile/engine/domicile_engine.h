// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_ENGINE_DOMICILE_ENGINE_H_
#define COMPONENTS_DOMICILE_ENGINE_DOMICILE_ENGINE_H_

#include <stddef.h>
#include <stdint.h>

// libdomicile_engine.so: the C ABI between domicile-compositor and the
// browser.
//
// The library owns the mojo side; domicile-compositor owns Wayland. See
// docs/architecture/ENGINE-FORK.md#the-c-abi in the Domicile repository.
//
// Mojo runs on the library's own thread. The compositor polls an fd and calls
// dispatch, like wl_display_get_fd and wl_display_dispatch:
//
//   int  domicile_engine_fd(engine);        // add to calloop
//   void domicile_engine_dispatch(engine);  // run pending work, fire callbacks
//
// Callbacks fire only from inside dispatch, on the caller's thread.
//
// The browser imports dmabufs and returns opaque BufferIds, so the compositor
// never handles mailboxes or GPU channels. See
// docs/architecture/ENGINE-FORK.md#buffer-import.

// Chromium builds with -fvisibility=hidden.
#define DOMICILE_ENGINE_EXPORT __attribute__((visibility("default")))

#ifdef __cplusplus
extern "C" {
#endif

typedef struct DomicileEngine DomicileEngine;

// Which of the desktop's two clipboards. A fixed-width integer rather than an
// `enum` so both sides agree on its size.
typedef uint32_t DomicileClipboard;

// Ctrl-C and Ctrl-V (wl_data_device).
#define DOMICILE_CLIPBOARD_COPY 0u
// Select and middle-click paste (zwp_primary_selection_device_v1).
#define DOMICILE_CLIPBOARD_PRIMARY 1u

// One type a clipboard's contents can be pasted as. Borrowed for the call it
// crosses in.
//
// Text crosses once, under any text type; the browser offers it under every
// text type a reader asks for. An image crosses under its own type, such as
// "image/png".
typedef struct DomicileClipboardItem {
  // A nul-terminated MIME type. Never null.
  const char* mime_type;
  // `length` bytes. Null only when `length` is zero.
  const uint8_t* data;
  size_t length;
} DomicileClipboardItem;

// A monitor's rotation: the turn content takes to appear upright. Values follow
// `wl_output.transform` order.
typedef uint32_t DomicileDisplayTransform;

#define DOMICILE_DISPLAY_TRANSFORM_NORMAL 0u
#define DOMICILE_DISPLAY_TRANSFORM_ROTATE_90 1u
#define DOMICILE_DISPLAY_TRANSFORM_ROTATE_180 2u
#define DOMICILE_DISPLAY_TRANSFORM_ROTATE_270 3u

// A client's wl_surface.set_buffer_transform: the turn and flip it drew its
// buffer with. Values follow `wl_output.transform` order.
typedef uint32_t DomicileBufferTransform;

#define DOMICILE_BUFFER_TRANSFORM_NORMAL 0u
#define DOMICILE_BUFFER_TRANSFORM_ROTATE_90 1u
#define DOMICILE_BUFFER_TRANSFORM_ROTATE_180 2u
#define DOMICILE_BUFFER_TRANSFORM_ROTATE_270 3u
#define DOMICILE_BUFFER_TRANSFORM_FLIPPED 4u
#define DOMICILE_BUFFER_TRANSFORM_FLIPPED_90 5u
#define DOMICILE_BUFFER_TRANSFORM_FLIPPED_180 6u
#define DOMICILE_BUFFER_TRANSFORM_FLIPPED_270 7u

// A surface id. Zero is never valid and is domicile_surface_create's failure
// return.
typedef uint32_t DomicileSurfaceId;

// An imported buffer id. Zero is never valid and is domicile_surface_import's
// failure return.
typedef uint64_t DomicileBufferId;

// One plane of a dmabuf, as zwp_linux_buffer_params_v1.add sends it.
typedef struct DomicileDmabufPlane {
  int fd;
  uint32_t offset;
  uint32_t stride;
} DomicileDmabufPlane;

// A client's dmabuf.
//
// The fds are borrowed for the call: the library duplicates what it sends and
// the caller keeps the originals.
typedef struct DomicileDmabuf {
  uint32_t width;
  uint32_t height;
  // DRM_FORMAT_*, as the client sent it.
  uint32_t fourcc;
  uint64_t modifier;
  uint32_t plane_count;
  DomicileDmabufPlane planes[4];
} DomicileDmabuf;

// A window's frame in shared memory, one plane at offset 0.
//
// The fd is borrowed for the call: the library duplicates what it sends and the
// caller keeps the original. It must be open for reading and writing, as
// memfd_create makes it.
typedef struct DomicileShmBuffer {
  int fd;
  uint32_t width;
  uint32_t height;
  // Bytes from one row to the next; at least 4 * width.
  uint32_t stride;
  // DRM_FORMAT_ARGB8888, XRGB8888, ABGR8888 or XBGR8888.
  uint32_t fourcc;
} DomicileShmBuffer;

// The primaries a client's pixels are encoded in, as
// wp_color_manager_v1.primaries names them.
typedef uint32_t DomicilePrimaries;

#define DOMICILE_PRIMARIES_SRGB 0u
#define DOMICILE_PRIMARIES_BT2020 1u
#define DOMICILE_PRIMARIES_DISPLAY_P3 2u
#define DOMICILE_PRIMARIES_ADOBE_RGB 3u

// The transfer function a client's pixels are encoded with, as
// wp_color_manager_v1.transfer_function names it.
typedef uint32_t DomicileTransfer;

// The sRGB piecewise curve (compound_power_2_4).
#define DOMICILE_TRANSFER_SRGB 0u
#define DOMICILE_TRANSFER_GAMMA22 1u
// BT.1886: a pure 2.4 power.
#define DOMICILE_TRANSFER_BT1886 2u
// Linear, extended past 1.0, with 1.0 at the reference white.
#define DOMICILE_TRANSFER_EXT_LINEAR 3u
#define DOMICILE_TRANSFER_PQ 4u
#define DOMICILE_TRANSFER_HLG 5u
// Windows scRGB: linear, extended, with 1.0 at 80 cd/m².
#define DOMICILE_TRANSFER_SCRGB 6u

// One CIE 1931 xy chromaticity.
typedef struct DomicileChromaticity {
  float x;
  float y;
} DomicileChromaticity;

// How a client's pixels encode color: its wp_image_description_v1. Luminances
// are in cd/m²; a zero means the client did not say.
typedef struct DomicileColor {
  DomicilePrimaries primaries;
  DomicileTransfer transfer;
  // The luminance of the reference white, for HDR content. Zero for the
  // transfer function's own.
  float reference_luminance;
  // The mastering display (SMPTE ST 2086). Unset when `has_mastering` is 0.
  uint32_t has_mastering;
  DomicileChromaticity mastering_red;
  DomicileChromaticity mastering_green;
  DomicileChromaticity mastering_blue;
  DomicileChromaticity mastering_white;
  float mastering_min_luminance;
  float mastering_max_luminance;
  // CTA-861.3.
  float max_cll;
  float max_fall;
} DomicileColor;

// A capture id, of a display or a browser window. Zero is never valid and is
// the failure return of domicile_display_capture_start and
// domicile_browser_window_capture_start.
typedef uint32_t DomicileCaptureId;

// Where a captured frame's pixels are.
typedef uint32_t DomicileCaptureMemory;

// A dmabuf: the browser composites on the GPU.
#define DOMICILE_CAPTURE_DMABUF 0u
// Shared memory, one plane at offset 0: the browser composites in software.
#define DOMICILE_CAPTURE_SHM 1u

// One frame of a display capture, as viz composited it.
//
// The fds are lent for the callback: duplicate what you keep. The buffer
// stays the frame's until domicile_captured_frame_release, so a duplicated fd
// may be read until then.
typedef struct DomicileCapturedFrame {
  DomicileCaptureMemory memory;
  uint32_t width;
  uint32_t height;
  // DRM_FORMAT_ARGB8888 or DRM_FORMAT_ABGR8888, as viz picked.
  uint32_t fourcc;
  // Zero for shared memory.
  uint64_t modifier;
  uint32_t plane_count;
  DomicileDmabufPlane planes[4];
  // The part of the frame that holds the display. Viz letterboxes the rest
  // when the display's aspect differs from the size asked for.
  int32_t content_x;
  int32_t content_y;
  int32_t content_width;
  int32_t content_height;
  // What changed since the capture's previous frame. Empty means all of it.
  int32_t damage_x;
  int32_t damage_y;
  int32_t damage_width;
  int32_t damage_height;
} DomicileCapturedFrame;

// One display the browser scans out to.
//
// The engine holds DRM master, so on a tty this is the compositor's only source
// of displays. A headless desk (`--domicile-headless-desk`) sends its virtual
// displays. Nested sessions never send these.
//
// `x`, `y`, `width` and `height` place the display on the browser's desktop, in
// pixels. `physical_width_mm`, `physical_height_mm` and `refresh_mhz` use
// wl_output's units; any may be zero when the display does not report it.
typedef struct DomicileDisplay {
  // Derived from the EDID, so stable across a hotplug. The compositor names
  // its wl_output after it, so a replugged monitor keeps its clients.
  int64_t id;
  // "<MAKE> <MODEL> <SERIAL>" from the EDID, or "" (never null) if it has
  // none. A human-readable name for config matching, like kanshi and sway use;
  // `id` is the identity.
  //
  // Borrowed for the call; copy it to keep it.
  const char* name;
  int32_t x;
  int32_t y;
  int32_t width;
  int32_t height;
  int32_t physical_width_mm;
  int32_t physical_height_mm;
  int32_t refresh_mhz;
} DomicileDisplay;

// A display and the connector it is on, for `connected_displays`.
typedef struct DomicileConnectedDisplay {
  DomicileDisplay display;
  // The kernel's name for the connector, as sway uses it: "DP-1", "HDMI-A-1",
  // "eDP-1". Never null.
  //
  // The compositor names a monitor whose `name` is "" after it. Borrowed for
  // the call; copy it to keep it.
  const char* connector;
} DomicileConnectedDisplay;

// A display, its connector and its gamma ramp's size, for `ramped_displays`.
typedef struct DomicileRampedDisplay {
  DomicileConnectedDisplay connected;
  // How many entries the display's gamma ramp has, or 0 if it has none: a
  // DisplayLink dock, a virtual display, any platform but DRM. What
  // `domicile_displays_set_gamma` takes, and what a compositor offers
  // wlr-gamma-control clients.
  uint32_t gamma_size;
} DomicileRampedDisplay;

// A mode a display's connector advertises, for `moded_displays`.
typedef struct DomicileDisplayMode {
  // In physical pixels.
  int32_t width;
  int32_t height;
  // In mHz, as wl_output.mode states it.
  int32_t refresh_mhz;
} DomicileDisplayMode;

// A display, its connector, its gamma ramp's size and the modes it
// advertises, for `moded_displays`.
typedef struct DomicileModedDisplay {
  DomicileRampedDisplay ramped;
  // `mode_count` modes, borrowed for the call; null when there are none. A
  // display on a platform that sets no modes advertises none. The display's
  // own size and `refresh_mhz` are the mode it scans out.
  const DomicileDisplayMode* modes;
  uint32_t mode_count;
} DomicileModedDisplay;

// Whether a display's connector scans out with a variable refresh rate.
// The connector, its panel or its driver cannot.
#define DOMICILE_ADAPTIVE_SYNC_UNSUPPORTED 0
// It can, and is not: not asked for, or the modeset asking for it was refused.
#define DOMICILE_ADAPTIVE_SYNC_OFF 1
// It is.
#define DOMICILE_ADAPTIVE_SYNC_ON 2

// A display with its modes and whether it scans out with a variable refresh
// rate, for `adaptive_displays`.
typedef struct DomicileAdaptiveDisplay {
  DomicileModedDisplay moded;
  // One of the `DOMICILE_ADAPTIVE_SYNC_*` values, as the hardware says.
  int32_t adaptive_sync;
} DomicileAdaptiveDisplay;

// Whether a display's connector is driven in HDR10 (BT.2020 with PQ).
// Its panel's EDID takes no PQ, or the connector cannot scan out in 10 bits.
#define DOMICILE_HDR_UNSUPPORTED 0
// It can, and is not.
#define DOMICILE_HDR_OFF 1
// It is.
#define DOMICILE_HDR_ON 2

// An adaptive display, whether it is driven in HDR10, and its panel's
// luminances, for `hdr_displays`.
typedef struct DomicileHdrDisplay {
  DomicileAdaptiveDisplay adaptive;
  // One of the `DOMICILE_HDR_*` values.
  int32_t hdr;
  // The panel's luminances from its EDID, in cd/m², zero where unreported.
  float max_luminance;
  float max_average_luminance;
  float min_luminance;
  // In HDR, the luminance SDR content's white is shown at, in cd/m²; zero
  // otherwise.
  float sdr_white_nits;
} DomicileHdrDisplay;

// A browser window, for `browser_windows`: a page the browser holds, which a
// capture tool may pick on ext-foreign-toplevel-list-v1 and capture alone
// with domicile_browser_window_capture_start.
typedef struct DomicileBrowserWindow {
  // Its id, as domicile_browser_window_capture_start takes it. Never reused
  // while the browser runs.
  const char* id;
  // The page's title, or empty.
  const char* title;
  // The app window's id, or empty for any other window.
  const char* app_id;
} DomicileBrowserWindow;

// Like DomicileBrowserWindow, plus its address and whether it is private, for
// `listed_browser_windows`.
typedef struct DomicileListedBrowserWindow {
  const char* id;
  const char* title;
  const char* app_id;
  // The address it shows, or the one it is opening.
  const char* url;
  // Nonzero for a private window, in the off-the-record profile.
  uint8_t off_the_record;
} DomicileListedBrowserWindow;

// An Electron app's view a listed browser window holds and shows, for
// `viewed_browser_windows`: its page, which a shot of the window draws over
// the window's page.
typedef struct DomicileBrowserWindowView {
  // As domicile_browser_window_capture_start takes it.
  const char* id;
  // The index, in the call's `windows`, of the window holding it.
  uint32_t window;
  // Where the app placed it in the window's page, in that page's CSS pixels.
  int32_t x;
  int32_t y;
  int32_t width;
  int32_t height;
} DomicileBrowserWindowView;

// What a `DomicileInputDevice` is. A device that is more than one is listed
// once for each, under one id.
typedef enum DomicileInputDeviceKind {
  DOMICILE_INPUT_DEVICE_KEYBOARD = 0,
  DOMICILE_INPUT_DEVICE_MOUSE = 1,
  DOMICILE_INPUT_DEVICE_TOUCHPAD = 2,
  DOMICILE_INPUT_DEVICE_TOUCHSCREEN = 3,
  DOMICILE_INPUT_DEVICE_POINTING_STICK = 4,
  DOMICILE_INPUT_DEVICE_GRAPHICS_TABLET = 5,
  // Read for its keys or switches alone, like a power button or a lid.
  DOMICILE_INPUT_DEVICE_OTHER = 6,
} DomicileInputDeviceKind;

// How a `DomicileInputDevice` is attached.
typedef enum DomicileInputDeviceConnection {
  DOMICILE_INPUT_CONNECTION_UNKNOWN = 0,
  DOMICILE_INPUT_CONNECTION_INTERNAL = 1,
  DOMICILE_INPUT_CONNECTION_USB = 2,
  DOMICILE_INPUT_CONNECTION_BLUETOOTH = 3,
} DomicileInputDeviceConnection;

// An input device the browser reads, for `input_devices`.
typedef struct DomicileInputDevice {
  // What its driver calls it.
  const char* name;
  // Its device under /sys, or empty.
  const char* sys_path;
  // The browser's id for it, which holds while it stays plugged in.
  int32_t id;
  // Its USB or Bluetooth ids, or 0.
  uint16_t vendor_id;
  uint16_t product_id;
  // A DomicileInputDeviceKind.
  uint8_t kind;
  // A DomicileInputDeviceConnection.
  uint8_t connection;
} DomicileInputDevice;

// How the compositor wants one display's connector driven.
//
// The reverse of DomicileDisplay: the compositor's config decides, but the
// browser holds DRM master and applies it.
typedef struct DomicileDisplayLayout {
  // DomicileDisplay::id, as the browser sent it.
  int64_t id;
  // Nonzero to light this connector; zero leaves it dark (a profile's
  // `enabled: false`, such as a closed laptop lid).
  int32_t enabled;
  // Position on the browser's desktop, in physical pixels. Zero and ignored
  // when `enabled` is zero.
  int32_t x;
  int32_t y;
  // Rotation and scale. The browser applies both to the window on this
  // connector, so the page always lays out upright in logical pixels. Read
  // even when dark, because the window outlives that state.
  DomicileDisplayTransform transform;
  double scale;
  // Position on the compositor's logical desktop, used to move the pointer
  // between monitors. Zero when `enabled` is zero, except for a sleeping
  // display, which keeps its place on the desk page.
  int32_t desk_x;
  int32_t desk_y;
  int32_t desk_width;
  int32_t desk_height;
} DomicileDisplayLayout;

// A display layout and the mode to drive it at, for
// `domicile_displays_configure_modes`.
typedef struct DomicileModedLayout {
  DomicileDisplayLayout layout;
  // The mode to scan out, in physical pixels, or zeros for the native one. A
  // size the connector does not advertise gets the native mode.
  int32_t mode_width;
  int32_t mode_height;
  // The refresh rate in mHz: the advertised one nearest it is used. Zero for
  // the native mode's, or the fastest at a non-native mode.
  int32_t refresh_mhz;
} DomicileModedLayout;

// A moded layout and whether to drive it with a variable refresh rate, for
// `domicile_displays_configure_adaptive`.
typedef struct DomicileAdaptiveLayout {
  DomicileModedLayout moded;
  // Nonzero to scan out with a variable refresh rate where the connector can.
  // A modeset the driver refuses with it is tried again without it, and the
  // display then reports `DOMICILE_ADAPTIVE_SYNC_OFF`.
  int32_t adaptive_sync;
} DomicileAdaptiveLayout;

// An adaptive layout and whether to drive it in HDR10, for
// `domicile_displays_configure_hdr`.
typedef struct DomicileHdrLayout {
  DomicileAdaptiveLayout adaptive;
  // Nonzero to drive the connector in HDR10 where its panel takes it. The
  // display reports `DOMICILE_HDR_UNSUPPORTED` where it does not.
  int32_t hdr;
  // In HDR, the luminance to show SDR content's white at, in cd/m². Zero or
  // less is 203, the BT.2408 reference white.
  float sdr_white_nits;
} DomicileHdrLayout;

// A tablet or touchscreen and the display it covers, for
// `domicile_pointers_configure`.
typedef struct DomicilePointerTarget {
  // The evdev device's name or `phys`, matched exactly. Borrowed for the call.
  const char* device;
  // DomicileDisplay::id, as the browser sent it.
  int64_t display_id;
} DomicilePointerTarget;

// What a `DomicileDeskInput` is.
typedef enum DomicileDeskInputKind {
  // The pointer moved to `x`, `y`, a point on the desk.
  DOMICILE_DESK_INPUT_POINTER = 0,
  // Button `code`, an evdev code such as BTN_LEFT, went down or up.
  DOMICILE_DESK_INPUT_BUTTON = 1,
  // A scroll by `x`, `y` desk pixels: right and down are positive.
  DOMICILE_DESK_INPUT_SCROLL = 2,
  // Key `code`, an evdev code such as KEY_A, went down or up.
  DOMICILE_DESK_INPUT_KEY = 3,
} DomicileDeskInputKind;

// One event of emulated input, for `domicile_input_inject`. Points are in
// desk pixels, where `domicile_displays_configure` put the displays.
typedef struct DomicileDeskInput {
  // A DomicileDeskInputKind.
  uint32_t kind;
  double x;
  double y;
  uint32_t code;
  // Nonzero for a press.
  uint32_t pressed;
} DomicileDeskInput;

// A monitor with no connector, for `domicile_virtual_displays_configure`. The
// desk extends onto it, and only a capture shows it.
typedef struct DomicileVirtualDisplay {
  // Its display id, picked by the compositor. Must not collide with a
  // connector's EDID-derived id; the compositor sets the top bit.
  int64_t id;
  // Its mode, in physical pixels.
  int32_t width;
  int32_t height;
  // Its refresh rate in mHz.
  int32_t refresh_mhz;
  // Its name, such as the TV it is cast to. Borrowed for the call.
  const char* name;
} DomicileVirtualDisplay;

// How a frame reached the screen, for `presented`. The values are
// wp_presentation_feedback.kind's.
typedef uint32_t DomicilePresentedFlags;

#define DOMICILE_PRESENTED_VSYNC 0x1u
#define DOMICILE_PRESENTED_HW_CLOCK 0x2u
#define DOMICILE_PRESENTED_HW_COMPLETION 0x4u
#define DOMICILE_PRESENTED_ZERO_COPY 0x8u
// Never shown: a newer frame replaced it first, or its surface was not drawn.
// No other flag is set with it.
#define DOMICILE_PRESENTED_DISCARDED 0x80000000u

// Events from the browser, each mapped to a Wayland request:
//
//   configure  xdg_toplevel.configure — the page's layout box changed
//   released   wl_buffer.release      — viz is done sampling a buffer, so the
//                                       client may draw into it again
//   frame_done wl_surface.frame       — viz took a frame and will take the next
//   presented  wp_presentation_feedback — a frame reached the screen, or never
//                                       will
//   displays   wl_output              — the whole display list, primary first
//   copied     wl_data_device.set_selection — something was copied in a page
//   captured   a frame of a display capture, for a screen cast
//   imported   zwp_linux_buffer_params.created — a dmabuf was imported
//
// All fire from domicile_engine_dispatch, on the calling thread. `user_data`
// is passed back untouched. A null function pointer drops that event.
//
// Only append fields, so a newer compositor works with an older engine: the
// library reads the prefix it knows. A newer engine with an older compositor is
// unsupported; `engine-release.nix` pins the pair and
// `scripts/test-the-pinned-engine-meets-the-compositor.sh` checks it.
//
// `displays` points at `count` records borrowed for the call; copy any you
// keep. `count` is never zero.
typedef struct DomicileEngineCallbacks {
  void* user_data;
  void (*configure)(void* user_data,
                    DomicileSurfaceId surface,
                    uint32_t width,
                    uint32_t height);
  void (*released)(void* user_data, DomicileSurfaceId surface, uint64_t buffer);
  void (*displays)(void* user_data,
                   const DomicileDisplay* displays,
                   uint32_t count);
  // A copy in a page or browser window. The browser is not a Wayland client,
  // so this is how its copies reach a seat.
  //
  // `text` is `length` bytes borrowed for the call; empty when the copy was
  // not text. Length-delimited because copied bytes may contain a NUL.
  //
  // Not called when `copied_items` is set.
  void (*copied)(void* user_data,
                 DomicileClipboard clipboard,
                 const char* text,
                 size_t length);
  // Like `configure`, plus the page's device pixels per CSS pixel. Each
  // monitor is its own page at its own scale, so the compositor needs the
  // scale of the page this box is in.
  //
  // Called instead of `configure` when set. An older engine ignores it and
  // keeps calling `configure`.
  void (*configure_at)(void* user_data,
                       DomicileSurfaceId surface,
                       uint32_t width,
                       uint32_t height,
                       double scale);
  // A frame of `capture`. `record` is borrowed for the call. Release `frame`
  // with domicile_captured_frame_release once read: viz keeps a few buffers,
  // so a capture whose frames are all held stops.
  void (*captured)(void* user_data,
                   DomicileCaptureId capture,
                   uint64_t frame,
                   const DomicileCapturedFrame* record);
  // The browser ended `capture`, and no frame follows. Not called after
  // domicile_display_capture_stop.
  void (*capture_ended)(void* user_data, DomicileCaptureId capture);
  // Like `configure_at`, plus the box's number. Pass it to
  // domicile_surface_submit_for_box with the frame the client draws for this
  // configure. Numbers start at 1 and grow per surface.
  //
  // Called instead of `configure_at` when set.
  void (*configure_box)(void* user_data,
                        DomicileSurfaceId surface,
                        uint32_t width,
                        uint32_t height,
                        double scale,
                        uint64_t box);
  // Like `copied`, with every type the copy can be pasted as: its text and
  // its image. `items` points at `count` records borrowed for the call; zero
  // when the copy was neither.
  //
  // Called instead of `copied` when set.
  void (*copied_items)(void* user_data,
                       DomicileClipboard clipboard,
                       const DomicileClipboardItem* items,
                       uint32_t count);
  // Viz acked `frame` of `surface`: it drew or dropped it, and takes the next.
  //
  // `frame` counts the surface's submits, from 1, including any the engine
  // could not send to viz. Each submit gets one call, in order.
  void (*frame_done)(void* user_data,
                     DomicileSurfaceId surface,
                     uint64_t frame);
  // `frame` of `surface`, numbered as in `frame_done`, reached the screen at
  // `time_ns` on CLOCK_MONOTONIC. `refresh_ns` is the display's frame interval,
  // zero if unknown. With DOMICILE_PRESENTED_DISCARDED, both are zero.
  //
  // Viz reports a frame on its next BeginFrame, so this follows the frame's
  // `frame_done`. A frame that never reached viz is reported discarded at
  // once.
  void (*presented)(void* user_data,
                    DomicileSurfaceId surface,
                    uint64_t frame,
                    int64_t time_ns,
                    int64_t refresh_ns,
                    DomicilePresentedFlags flags);
  // The answer to domicile_surface_import_async with this `request`: the
  // buffer's id, or zero if the browser refused it.
  void (*imported)(void* user_data,
                   DomicileSurfaceId surface,
                   uint64_t request,
                   DomicileBufferId buffer);
  // Like `displays`, plus each display's connector. `displays` points at
  // `count` records borrowed for the call.
  //
  // Called instead of `displays` when set. An older engine ignores it and
  // keeps calling `displays`.
  void (*connected_displays)(void* user_data,
                             const DomicileConnectedDisplay* displays,
                             uint32_t count);
  // The browser went away: it exited, or closed the broker. No callback
  // follows; the compositor joins the next browser to say hello. An older
  // engine never calls it, so a compositor also compares the pid that dials
  // its chrome socket. See "Crashes are recovered" in
  // docs/architecture/THE-DOMICILE-BINARY.md.
  void (*disconnected)(void* user_data);
  // Nonzero when the browser composites in memory, where it shows no dmabuf:
  // hand it windows with domicile_surface_import_shm. Called once the browser
  // knows, and on every change, as when its GPU process falls back to
  // software. An older engine never calls it.
  void (*compositing)(void* user_data, int in_memory);
  // Like `connected_displays`, plus each display's gamma ramp size. `displays`
  // points at `count` records borrowed for the call.
  //
  // Called instead of `connected_displays` and `displays` when set. An older
  // engine ignores it.
  void (*ramped_displays)(void* user_data,
                          const DomicileRampedDisplay* displays,
                          uint32_t count);
  // Like `ramped_displays`, plus the modes each display advertises.
  // `displays` points at `count` records borrowed for the call.
  //
  // Called instead of `ramped_displays`, `connected_displays` and `displays`
  // when set. An older engine ignores it.
  void (*moded_displays)(void* user_data,
                         const DomicileModedDisplay* displays,
                         uint32_t count);
  // The browser's windows, in the order they opened. `windows` points at
  // `count` records, their strings borrowed for the call. Called once the
  // browser is connected, and when a window opens, closes or changes its
  // title. An older engine never calls it.
  void (*browser_windows)(void* user_data,
                          const DomicileBrowserWindow* windows,
                          uint32_t count);
  // Like `moded_displays`, plus whether each display scans out with a
  // variable refresh rate. `displays` points at `count` records borrowed for
  // the call.
  //
  // Called instead of `moded_displays` and the older display callbacks when
  // set. An older engine ignores it.
  void (*adaptive_displays)(void* user_data,
                            const DomicileAdaptiveDisplay* displays,
                            uint32_t count);
  // Like `configure_box`, plus the embedding element's CSS `zoom`. Configure
  // the client at `width` x `height` over `scale` times `zoom`, and have it
  // draw at that product: its buffer still fills the box, `zoom` times denser.
  // 1 for an unzoomed element.
  //
  // Called instead of `configure_box` when set. An older engine ignores it.
  void (*configure_zoomed)(void* user_data,
                           DomicileSurfaceId surface,
                           uint32_t width,
                           uint32_t height,
                           double scale,
                           double zoom,
                           uint64_t box);
  // Like `adaptive_displays`, plus whether each display is driven in HDR10
  // and its panel's luminances. `displays` points at `count` records borrowed
  // for the call.
  //
  // Called instead of `adaptive_displays` and the older display callbacks
  // when set. An older engine ignores it.
  void (*hdr_displays)(void* user_data,
                       const DomicileHdrDisplay* displays,
                       uint32_t count);
  // Like `browser_windows`, plus each window's address and whether it is
  // private. `windows` points at `count` records, their strings borrowed for
  // the call.
  //
  // Called instead of `browser_windows` when set. An older engine ignores it.
  void (*listed_browser_windows)(void* user_data,
                                 const DomicileListedBrowserWindow* windows,
                                 uint32_t count);
  // The input devices the browser reads, for `domicile list-inputs`.
  // `devices` points at `count` records, their strings borrowed for the call.
  // Sent once the browser connects, and when a device is plugged or
  // unplugged.
  //
  // An older engine ignores it.
  void (*input_devices)(void* user_data,
                        const DomicileInputDevice* devices,
                        uint32_t count);
  // Like `capture_ended`, for a capture the browser ended because it failed,
  // such as one viz could not allocate a frame for. `why` names the cause,
  // borrowed for the call.
  //
  // Called instead of `capture_ended` when set. An older engine ignores it.
  void (*capture_failed)(void* user_data,
                         DomicileCaptureId capture,
                         const char* why);
  // Like `listed_browser_windows`, plus the views each window holds and
  // shows. `views` points at `view_count` records, each window's bottom
  // first, their strings borrowed for the call.
  //
  // Called instead of `listed_browser_windows` when set. An older engine
  // ignores it.
  void (*viewed_browser_windows)(void* user_data,
                                 const DomicileListedBrowserWindow* windows,
                                 uint32_t count,
                                 const DomicileBrowserWindowView* views,
                                 uint32_t view_count);
} DomicileEngineCallbacks;

// Returns nonzero. Exists so a compositor can tell an engine that calls
// `frame_done` and `presented` from an older one that ignores them.
DOMICILE_ENGINE_EXPORT int domicile_engine_reports_frames(void);

// Connects to the browser's mojo socket. Returns null on failure, and the
// library logs why.
//
// Blocks until the browser accepts or refuses the invitation.
DOMICILE_ENGINE_EXPORT DomicileEngine* domicile_engine_connect(
    const char* socket_path,
    DomicileEngineCallbacks callbacks);

// Stops the internal thread and drops every surface. Callbacks do not fire
// after this returns.
DOMICILE_ENGINE_EXPORT void domicile_engine_destroy(DomicileEngine* engine);

// The fd to poll; readable when domicile_engine_dispatch has work. Valid until
// domicile_engine_destroy. -1 if the engine could not create it.
DOMICILE_ENGINE_EXPORT int domicile_engine_fd(DomicileEngine* engine);

// Runs pending work, firing callbacks on this thread. Safe to call on a
// spurious wakeup.
DOMICILE_ENGINE_EXPORT void domicile_engine_dispatch(DomicileEngine* engine);

// Asks the browser to broker a frame sink for a new window. Returns the surface
// id, or zero if the browser refused.
//
// A page's embedExternalSurface() waits until this call brokers a sink.
// `app_id` becomes the frame sink's debug label only.
DOMICILE_ENGINE_EXPORT DomicileSurfaceId
domicile_surface_create(DomicileEngine* engine, const char* app_id);

// Drops the surface and the frame sink behind it.
DOMICILE_ENGINE_EXPORT void domicile_surface_destroy(DomicileEngine* engine,
                                                     DomicileSurfaceId surface);

// Sets how `surface`'s pixels encode color (wp_color_management_surface_v1).
// Buffers imported after this, by any domicile_surface_import call, are drawn
// in it; buffers imported before keep the color they were imported with, so
// import a buffer again to show it in a new color. A null `color` is sRGB, as
// every surface starts.
DOMICILE_ENGINE_EXPORT void domicile_surface_set_color(
    DomicileEngine* engine,
    DomicileSurfaceId surface,
    const DomicileColor* color);

// Imports a client's dmabuf (zwp_linux_dmabuf_v1). Returns the buffer id, or
// zero if the browser refused.
//
// Blocks for a round trip to the GPU process. The usual failure is an ozone
// platform without CreateNativePixmapFromHandle, such as headless.
DOMICILE_ENGINE_EXPORT DomicileBufferId
domicile_surface_import(DomicileEngine* engine,
                        DomicileSurfaceId surface,
                        const DomicileDmabuf* dmabuf);

// Like domicile_surface_import, but returns at once. The answer arrives as
// `imported`, carrying `request`. Submit the buffer only once it has.
//
// The fds are duplicated before this returns. A null `dmabuf` aborts.
DOMICILE_ENGINE_EXPORT void domicile_surface_import_async(
    DomicileEngine* engine,
    DomicileSurfaceId surface,
    const DomicileDmabuf* dmabuf,
    uint64_t request);

// Imports a window's frame in shared memory, for a browser that composites in
// software (2D virtio-gpu, simpledrm, vkms, --disable-gpu). Returns the buffer
// id, or zero if the browser refused: it refuses while it composites on the
// GPU, where a dmabuf is the way in.
//
// Viz reads the memory itself at each frame that shows the buffer. Write to it
// only while the buffer is released. Blocks for a round trip to the browser.
DOMICILE_ENGINE_EXPORT DomicileBufferId
domicile_surface_import_shm(DomicileEngine* engine,
                            DomicileSurfaceId surface,
                            const DomicileShmBuffer* buffer);

// Submits a frame showing `buffer` (wl_surface.commit), damaging the given
// rectangle. An empty rectangle means the whole surface.
DOMICILE_ENGINE_EXPORT void domicile_surface_submit(DomicileEngine* engine,
                                                    DomicileSurfaceId surface,
                                                    DomicileBufferId buffer,
                                                    int32_t damage_x,
                                                    int32_t damage_y,
                                                    int32_t damage_width,
                                                    int32_t damage_height);

// Like domicile_surface_submit, but shows only `crop` of `buffer`, in buffer
// pixels. An empty crop is the whole buffer.
//
// Implements xdg_surface.set_window_geometry, so a client's own shadow is not
// part of the <app> box. A separate symbol so a newer compositor fails to
// resolve it against an older engine instead of passing ignored arguments.
DOMICILE_ENGINE_EXPORT void domicile_surface_submit_crop(
    DomicileEngine* engine,
    DomicileSurfaceId surface,
    DomicileBufferId buffer,
    int32_t crop_x,
    int32_t crop_y,
    int32_t crop_width,
    int32_t crop_height,
    int32_t damage_x,
    int32_t damage_y,
    int32_t damage_width,
    int32_t damage_height);

// Names the newest box in domicile_surface_submit_for_box.
#define DOMICILE_NEWEST_BOX UINT64_MAX

// Like domicile_surface_submit_crop, but shows the frame at the newest box
// numbered at most `box` (see `configure_box`). Zero is the box shown last.
//
// A client draws for the configure it acked, which may be older than the
// page's box. Shown at its own box, an old buffer keeps its size, and the page
// waits for the client's frame at the new one instead of stretching the old
// one over it.
DOMICILE_ENGINE_EXPORT void domicile_surface_submit_for_box(
    DomicileEngine* engine,
    DomicileSurfaceId surface,
    DomicileBufferId buffer,
    int32_t crop_x,
    int32_t crop_y,
    int32_t crop_width,
    int32_t crop_height,
    int32_t damage_x,
    int32_t damage_y,
    int32_t damage_width,
    int32_t damage_height,
    uint64_t box);

// Like domicile_surface_submit_for_box, but shows a buffer the client drew
// with `transform`, turned upright. `crop` is in the buffer's own pixels,
// before the turn.
//
// Implements wl_surface.set_buffer_transform. A transform past
// DOMICILE_BUFFER_TRANSFORM_FLIPPED_270 is a caller bug and aborts.
DOMICILE_ENGINE_EXPORT void domicile_surface_submit_transformed(
    DomicileEngine* engine,
    DomicileSurfaceId surface,
    DomicileBufferId buffer,
    int32_t crop_x,
    int32_t crop_y,
    int32_t crop_width,
    int32_t crop_height,
    int32_t damage_x,
    int32_t damage_y,
    int32_t damage_width,
    int32_t damage_height,
    uint64_t box,
    DomicileBufferTransform transform);

// Like domicile_surface_submit_transformed, for a buffer whose draw may not
// have finished. `acquire_fence` is a sync_file fd that signals when it has,
// and viz reads the buffer only after that. Later submits to the surface wait
// behind this one.
//
// The fd is duplicated before this returns. An invalid fd aborts. If the
// browser refuses the fence, the frame is dropped and the buffer `released`.
DOMICILE_ENGINE_EXPORT void domicile_surface_submit_fenced(
    DomicileEngine* engine,
    DomicileSurfaceId surface,
    DomicileBufferId buffer,
    int32_t crop_x,
    int32_t crop_y,
    int32_t crop_width,
    int32_t crop_height,
    int32_t damage_x,
    int32_t damage_y,
    int32_t damage_width,
    int32_t damage_height,
    uint64_t box,
    DomicileBufferTransform transform,
    int acquire_fence);

// Makes the next submit to `surface`, and every one after it, go up at synced
// frame `frame`. The page shows that frame once an <app> with `frame` set to
// it embeds it, in the same rendering update that applies the move the frame
// goes with. Until then it shows the previous frame.
//
// Frames count from 1 per surface; 0 is the frame a surface starts at. A
// `frame` not above the last aborts. See
// docs/architecture/WINDOW-COMPOSITING.md#synced-frames in the Domicile
// repository.
DOMICILE_ENGINE_EXPORT void domicile_surface_sync(DomicileEngine* engine,
                                                  DomicileSurfaceId surface,
                                                  uint32_t frame);

// One of a surface's subsurfaces (wl_subsurface), in logical pixels from the
// top left of the surface's crop.
typedef struct DomicileSubsurface {
  DomicileSurfaceId surface;
  double x;
  double y;
  double width;
  double height;
  // Nonzero when it is drawn over the surface, zero when under it.
  uint8_t above;
} DomicileSubsurface;

// Sets `surface`'s subsurfaces, bottom to top, which its frames draw with it:
// each frame embeds each subsurface's newest frame at its place. Replaces the
// last set; applies from the surface's next frame.
//
// A subsurface takes frames once the engine embeds it, which it reports as
// `configure` with its size in device pixels. Submit to it at the newest box.
// A subsurface whose surface is gone is left out.
DOMICILE_ENGINE_EXPORT void domicile_surface_set_children(
    DomicileEngine* engine,
    DomicileSurfaceId surface,
    const DomicileSubsurface* children,
    uint32_t count);

// Sends `surface`'s last frame again, to show subsurfaces set since with no
// new buffer of its own. Does nothing while a newer frame of it is on its
// way, which shows them. The frame answers no `frame_done` or `presented`.
DOMICILE_ENGINE_EXPORT void domicile_surface_redraw(DomicileEngine* engine,
                                                    DomicileSurfaceId surface);

// Tells the browser which connectors to light and where, in answer to the
// `displays` callback.
//
// An empty list means the compositor has no preference, and the browser lights
// what the hardware reports. This turns a panel back on when a monitor unplug
// stops a profile from matching.
//
// The records are borrowed for the call. Nothing is returned because the
// modeset completes asynchronously; the resulting `displays` callback reports
// the outcome.
DOMICILE_ENGINE_EXPORT void domicile_displays_configure(
    DomicileEngine* engine,
    const DomicileDisplayLayout* layout,
    uint32_t count);

// Like `domicile_displays_configure`, with the mode and refresh rate to drive
// each connector at. A compositor that finds no such symbol has an older
// engine, which lights each connector at its native mode.
DOMICILE_ENGINE_EXPORT void domicile_displays_configure_modes(
    DomicileEngine* engine,
    const DomicileModedLayout* layout,
    uint32_t count);

// Like `domicile_displays_configure_modes`, with whether to drive each
// connector with a variable refresh rate. A compositor that finds no such
// symbol has an older engine, which drives every connector at a fixed rate.
DOMICILE_ENGINE_EXPORT void domicile_displays_configure_adaptive(
    DomicileEngine* engine,
    const DomicileAdaptiveLayout* layout,
    uint32_t count);

// Like `domicile_displays_configure_adaptive`, with whether to drive each
// connector in HDR10 and the SDR white to draw it at. A compositor that finds
// no such symbol has an older engine, which drives every connector in SDR.
DOMICILE_ENGINE_EXPORT void domicile_displays_configure_hdr(
    DomicileEngine* engine,
    const DomicileHdrLayout* layout,
    uint32_t count);

// Tells the browser which display each tablet or touchscreen covers.
//
// The list replaces the last one. A device it names maps onto that display's
// rectangle; a device it does not name covers no display. Ignored off a tty.
// The records and strings are borrowed for the call.
DOMICILE_ENGINE_EXPORT void domicile_pointers_configure(
    DomicileEngine* engine,
    const DomicilePointerTarget* targets,
    uint32_t count);

// Replaces touchpad and mouse settings with a JSON object containing their
// configuration sections. The string is borrowed for the call. Ignored when
// nested, where the host compositor configures input devices.
DOMICILE_ENGINE_EXPORT void domicile_input_configure(DomicileEngine* engine,
                                                     const char* config);

// Sets the virtual displays, replacing the last list.
//
// Each joins the next `displays` callback as a display on connector
// `virtual-<n>`, n being its id without the top bit, laid out by
// `domicile_displays_configure` like any other. No CRTC lights for it. Ignored
// off a tty and a headless desk, where these are the only displays. The
// records and strings are borrowed for the call.
DOMICILE_ENGINE_EXPORT void domicile_virtual_displays_configure(
    DomicileEngine* engine,
    const DomicileVirtualDisplay* displays,
    uint32_t count);

// Sets the gamma ramp display `display_id` draws with, for a night light or a
// wlr-gamma-control client. `ramp` is `size` red entries, then `size` green,
// then `size` blue, each 0 to 65535, as wlr-gamma-control lays them out. A
// `size` of 0 draws colors as they are, and `ramp` may then be null. Any size
// works: the browser resamples it to the CRTC's, but the display's
// `gamma_size` maps one to one.
//
// The browser keeps each display's ramp and sets it again after each modeset.
// Ignored off a tty. The entries are copied before this returns.
DOMICILE_ENGINE_EXPORT void domicile_displays_set_gamma(DomicileEngine* engine,
                                                        int64_t display_id,
                                                        const uint16_t* ramp,
                                                        uint32_t size);

// Sets the 3x3 color matrix, row-major, that display `display_id` is drawn
// with, in linear light, for a night light on a display driven in HDR: a
// gamma ramp there would bend the PQ curve the panel decodes. The identity
// undoes it. `matrix` is nine finite numbers, copied before this returns.
//
// Unlike a gamma ramp, it works off a tty too: viz applies it, not the CRTC.
// Ignored for a display no browser window shows.
DOMICILE_ENGINE_EXPORT void domicile_displays_set_color_matrix(
    DomicileEngine* engine,
    int64_t display_id,
    const float* matrix);

// Delivers emulated input (EIS) to the desk, as the engine's own pointer and
// keyboard would: the shell sees it first, and the engine forwards what lands
// on a window as it forwards a real device's. A headless desk and a desk on
// DRM take it; nested it is dropped, so the compositor delivers emulated input
// itself.
// See docs/architecture/A-HEADLESS-DESKTOP.md.
DOMICILE_ENGINE_EXPORT void domicile_input_inject(DomicileEngine* engine,
                                                  const DomicileDeskInput* input);

// Sets the contents of one of the desktop's clipboards.
//
// The compositor reads every seat selection eagerly, so it pushes the bytes
// and the browser serves pastes from memory. Send empty `text` to clear the
// clipboard, or the browser keeps offering the last value.
//
// `text` is borrowed for the call and length-delimited, like `copied`.
DOMICILE_ENGINE_EXPORT void domicile_clipboard_set(DomicileEngine* engine,
                                                   DomicileClipboard clipboard,
                                                   const char* text,
                                                   size_t length);

// Sets the contents of one of the desktop's clipboards to `count` items: text,
// an image, or both, as `copied_items` reports them. Zero items clears the
// clipboard.
//
// The records and their bytes are borrowed for the call.
DOMICILE_ENGINE_EXPORT void domicile_clipboard_set_items(
    DomicileEngine* engine,
    DomicileClipboard clipboard,
    const DomicileClipboardItem* items,
    uint32_t count);

// Drops an imported buffer. Destroying a surface drops its buffers, so this is
// for a client that destroys a single buffer.
DOMICILE_ENGINE_EXPORT void domicile_buffer_destroy(DomicileEngine* engine,
                                                    DomicileSurfaceId surface,
                                                    DomicileBufferId buffer);

// Captures what a display shows, for a screen cast. Returns the capture id, or
// zero if no browser window shows that display.
//
// `display_id` is a DomicileDisplay::id. A nested browser, or a headless one
// without `--domicile-headless-desk`, sends no displays; zero names its only
// window.
//
// Frames arrive through `captured`, `width` x `height`, only when the display
// changed and at most `max_fps` a second. Blocks for the browser's answer.
DOMICILE_ENGINE_EXPORT DomicileCaptureId
domicile_display_capture_start(DomicileEngine* engine,
                               int64_t display_id,
                               uint32_t width,
                               uint32_t height,
                               uint32_t max_fps);

// Captures what browser window `window_id` shows, alone, for a screenshot.
// Returns the capture id, or zero if no such window has a page drawn.
//
// `window_id` is the id the shell's browser window list gives, borrowed for
// the call. Frames arrive through `captured` at the page's size in pixels,
// until domicile_display_capture_resize, and otherwise as for
// domicile_display_capture_start, whose resize, stop and release functions
// this capture also takes. Blocks for the browser's answer.
DOMICILE_ENGINE_EXPORT DomicileCaptureId
domicile_browser_window_capture_start(DomicileEngine* engine,
                                      const char* window_id,
                                      uint32_t max_fps);

// Captures at `width` x `height` from the next frame on.
DOMICILE_ENGINE_EXPORT void domicile_display_capture_resize(
    DomicileEngine* engine,
    DomicileCaptureId capture,
    uint32_t width,
    uint32_t height);

// Stops `capture` and releases every frame of it still held.
DOMICILE_ENGINE_EXPORT void domicile_display_capture_stop(
    DomicileEngine* engine,
    DomicileCaptureId capture);

// Gives a frame's buffer back to viz, which may draw the next frame into it.
DOMICILE_ENGINE_EXPORT void domicile_captured_frame_release(
    DomicileEngine* engine,
    DomicileCaptureId capture,
    uint64_t frame);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // COMPONENTS_DOMICILE_ENGINE_DOMICILE_ENGINE_H_

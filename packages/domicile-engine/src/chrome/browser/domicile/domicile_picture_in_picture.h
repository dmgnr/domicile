// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_PICTURE_IN_PICTURE_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_PICTURE_IN_PICTURE_H_

#include <memory>

#include "components/domicile/mojom/picture_in_picture.mojom.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"

namespace content {
class RenderFrameHost;
class VideoOverlayWindow;
class VideoPictureInPictureWindowController;
}  // namespace content

namespace domicile {

// The window a video in picture-in-picture floats in, which the shell draws in
// place of Chrome's: it lists the video for the shell, whose controls act on
// `controller`. ChromeContentBrowserClient::
// CreateWindowForVideoPictureInPicture returns it. See
// components/domicile/mojom/picture_in_picture.mojom.
std::unique_ptr<content::VideoOverlayWindow> CreateVideoPictureInPictureWindow(
    content::VideoPictureInPictureWindowController* controller);

// Binds PictureInPictureVideos for `frame`: the list, the controls, and the
// videos' surfaces.
//
// This function does no access control. PopulateChromeFrameBinders registers
// it only for the shell's origin.
void BindPictureInPictureVideos(
    content::RenderFrameHost* frame,
    mojo::PendingReceiver<mojom::PictureInPictureVideos> receiver);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_PICTURE_IN_PICTURE_H_

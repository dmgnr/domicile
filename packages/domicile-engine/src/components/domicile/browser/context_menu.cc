// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/context_menu.h"

#include <string>
#include <utility>
#include <vector>

#include "base/strings/utf_string_conversions.h"
#include "content/public/browser/context_menu_params.h"
#include "third_party/blink/public/common/context_menu_data/context_menu_data.h"
#include "third_party/blink/public/common/context_menu_data/edit_flags.h"
#include "third_party/blink/public/mojom/context_menu/context_menu.mojom.h"
#include "ui/gfx/geometry/point.h"

namespace domicile {
namespace {

using blink::mojom::ContextMenuDataMediaType;

// No default arm, so a media type Blink adds fails the build.
mojom::WebViewMediaType AsWebViewMediaType(ContextMenuDataMediaType type) {
  switch (type) {
    case ContextMenuDataMediaType::kNone:
      return mojom::WebViewMediaType::kNone;
    case ContextMenuDataMediaType::kImage:
      return mojom::WebViewMediaType::kImage;
    case ContextMenuDataMediaType::kVideo:
      return mojom::WebViewMediaType::kVideo;
    case ContextMenuDataMediaType::kAudio:
      return mojom::WebViewMediaType::kAudio;
    case ContextMenuDataMediaType::kCanvas:
      return mojom::WebViewMediaType::kCanvas;
    case ContextMenuDataMediaType::kFile:
      return mojom::WebViewMediaType::kFile;
    case ContextMenuDataMediaType::kPlugin:
      return mojom::WebViewMediaType::kPlugin;
  }
}

bool Can(const content::ContextMenuParams& params,
         blink::ContextMenuDataEditFlags flag) {
  return (params.edit_flags & flag) != 0;
}

bool Has(const content::ContextMenuParams& params,
         blink::ContextMenuData::MediaFlags flag) {
  return (params.media_flags & flag) != 0;
}

// A video Blink can float, as Chrome's menu checks it.
bool CanPictureInPicture(const content::ContextMenuParams& params) {
  return params.media_type == ContextMenuDataMediaType::kVideo &&
         Has(params, blink::ContextMenuData::kMediaCanPictureInPicture);
}

// An image that loaded, or a canvas.
bool HasPixels(const content::ContextMenuParams& params) {
  return (params.media_type == ContextMenuDataMediaType::kImage ||
          params.media_type == ContextMenuDataMediaType::kCanvas) &&
         params.has_image_contents;
}

// An image, video or audio with an address.
bool HasSource(const content::ContextMenuParams& params) {
  return (params.media_type == ContextMenuDataMediaType::kImage ||
          params.media_type == ContextMenuDataMediaType::kVideo ||
          params.media_type == ContextMenuDataMediaType::kAudio) &&
         params.src_url.is_valid();
}

// Electron's names for them. No default arm, as AsWebViewMediaType.
std::string ElectronMediaType(ContextMenuDataMediaType type) {
  switch (type) {
    case ContextMenuDataMediaType::kNone:
      return "none";
    case ContextMenuDataMediaType::kImage:
      return "image";
    case ContextMenuDataMediaType::kVideo:
      return "video";
    case ContextMenuDataMediaType::kAudio:
      return "audio";
    case ContextMenuDataMediaType::kCanvas:
      return "canvas";
    case ContextMenuDataMediaType::kFile:
      return "file";
    case ContextMenuDataMediaType::kPlugin:
      return "plugin";
  }
}

}  // namespace

mojom::WebViewContextMenuPtr AsWebViewContextMenu(
    int id,
    const content::ContextMenuParams& params,
    const gfx::Point& in_page) {
  auto menu = mojom::WebViewContextMenu::New();
  menu->id = id;
  menu->x = in_page.x();
  menu->y = in_page.y();
  menu->link_url = params.link_url;
  menu->link_text = base::UTF16ToUTF8(params.link_text);
  menu->src_url = params.src_url;
  menu->media_type = AsWebViewMediaType(params.media_type);
  menu->has_image_contents = params.has_image_contents;
  menu->can_picture_in_picture = CanPictureInPicture(params);
  menu->in_picture_in_picture =
      Has(params, blink::ContextMenuData::kMediaPictureInPicture);
  menu->selection_text = base::UTF16ToUTF8(params.selection_text);
  menu->is_editable = params.is_editable;
  menu->can_undo = Can(params, blink::ContextMenuDataEditFlags::kCanUndo);
  menu->can_redo = Can(params, blink::ContextMenuDataEditFlags::kCanRedo);
  menu->can_cut = Can(params, blink::ContextMenuDataEditFlags::kCanCut);
  menu->can_copy = Can(params, blink::ContextMenuDataEditFlags::kCanCopy);
  menu->can_paste = Can(params, blink::ContextMenuDataEditFlags::kCanPaste);
  menu->can_delete = Can(params, blink::ContextMenuDataEditFlags::kCanDelete);
  menu->can_select_all =
      Can(params, blink::ContextMenuDataEditFlags::kCanSelectAll);
  menu->misspelled_word = base::UTF16ToUTF8(params.misspelled_word);
  for (const std::u16string& suggestion : params.dictionary_suggestions) {
    menu->spelling_suggestions.push_back(base::UTF16ToUTF8(suggestion));
  }
  return menu;
}

ElectronContextMenu AsElectronContextMenu(
    const content::ContextMenuParams& params,
    const gfx::Point& in_page) {
  using blink::ContextMenuData;
  using blink::ContextMenuDataEditFlags;
  std::vector<std::string> suggestions;
  for (const std::u16string& suggestion : params.dictionary_suggestions) {
    suggestions.push_back(base::UTF16ToUTF8(suggestion));
  }
  return ElectronContextMenu{
      .x = in_page.x(),
      .y = in_page.y(),
      .link_url = params.link_url.possibly_invalid_spec(),
      .link_text = base::UTF16ToUTF8(params.link_text),
      .page_url = params.page_url.possibly_invalid_spec(),
      .frame_url = params.frame_url.possibly_invalid_spec(),
      .src_url = params.src_url.possibly_invalid_spec(),
      .media_type = ElectronMediaType(params.media_type),
      .has_image_contents = params.has_image_contents,
      .is_editable = params.is_editable,
      .selection_text = base::UTF16ToUTF8(params.selection_text),
      .title_text = base::UTF16ToUTF8(params.title_text),
      .alt_text = base::UTF16ToUTF8(params.alt_text),
      .suggested_filename = base::UTF16ToUTF8(params.suggested_filename),
      .misspelled_word = base::UTF16ToUTF8(params.misspelled_word),
      .dictionary_suggestions = std::move(suggestions),
      .spellcheck_enabled = params.spellcheck_enabled,
      .frame_charset = params.frame_charset,
      .edit_flags =
          {
              .can_undo = Can(params, ContextMenuDataEditFlags::kCanUndo),
              .can_redo = Can(params, ContextMenuDataEditFlags::kCanRedo),
              .can_cut = Can(params, ContextMenuDataEditFlags::kCanCut),
              .can_copy = Can(params, ContextMenuDataEditFlags::kCanCopy),
              .can_paste = Can(params, ContextMenuDataEditFlags::kCanPaste),
              .can_delete = Can(params, ContextMenuDataEditFlags::kCanDelete),
              .can_select_all =
                  Can(params, ContextMenuDataEditFlags::kCanSelectAll),
              .can_edit_richly =
                  Can(params, ContextMenuDataEditFlags::kCanEditRichly),
          },
      .media_flags =
          {
              .in_error = Has(params, ContextMenuData::kMediaInError),
              .is_paused = Has(params, ContextMenuData::kMediaPaused),
              .is_muted = Has(params, ContextMenuData::kMediaMuted),
              .has_audio = Has(params, ContextMenuData::kMediaHasAudio),
              .is_looping = Has(params, ContextMenuData::kMediaLoop),
              .is_controls_visible =
                  Has(params, ContextMenuData::kMediaControls),
              .can_toggle_controls =
                  Has(params, ContextMenuData::kMediaCanToggleControls),
              .can_print = Has(params, ContextMenuData::kMediaCanPrint),
              .can_save = Has(params, ContextMenuData::kMediaCanSave),
              .can_show_picture_in_picture = CanPictureInPicture(params),
              .is_showing_picture_in_picture =
                  Has(params, ContextMenuData::kMediaPictureInPicture),
              .can_rotate = Has(params, ContextMenuData::kMediaCanRotate),
              .can_loop = Has(params, ContextMenuData::kMediaCanLoop),
          },
  };
}

bool Offers(const content::ContextMenuParams& params,
            mojom::WebViewContextMenuAction action) {
  switch (action) {
    case mojom::WebViewContextMenuAction::kUndo:
    case mojom::WebViewContextMenuAction::kRedo:
    case mojom::WebViewContextMenuAction::kCut:
    case mojom::WebViewContextMenuAction::kCopy:
    case mojom::WebViewContextMenuAction::kPaste:
    case mojom::WebViewContextMenuAction::kPasteAndMatchStyle:
    case mojom::WebViewContextMenuAction::kDelete:
    case mojom::WebViewContextMenuAction::kSelectAll:
    case mojom::WebViewContextMenuAction::kInspect:
      return true;
    case mojom::WebViewContextMenuAction::kCopyLinkAddress:
      return params.unfiltered_link_url.is_valid();
    case mojom::WebViewContextMenuAction::kSaveLinkAs:
      return params.link_url.is_valid();
    case mojom::WebViewContextMenuAction::kCopyImage:
      return HasPixels(params);
    case mojom::WebViewContextMenuAction::kCopyMediaAddress:
      return HasSource(params);
    case mojom::WebViewContextMenuAction::kSaveMediaAs:
      return HasPixels(params) || HasSource(params);
    case mojom::WebViewContextMenuAction::kPictureInPicture:
      return CanPictureInPicture(params);
    case mojom::WebViewContextMenuAction::kAddToDictionary:
      return OffersSpellingFixes(params);
  }
}

bool OffersSpellingFixes(const content::ContextMenuParams& params) {
  return !params.misspelled_word.empty();
}

}  // namespace domicile

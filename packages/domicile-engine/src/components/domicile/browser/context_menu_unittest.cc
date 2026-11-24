// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/context_menu.h"

#include <string>
#include <vector>

#include "components/domicile/mojom/web_view_guest.mojom.h"
#include "content/public/browser/context_menu_params.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/blink/public/common/context_menu_data/context_menu_data.h"
#include "third_party/blink/public/common/context_menu_data/edit_flags.h"
#include "third_party/blink/public/mojom/context_menu/context_menu.mojom.h"
#include "ui/gfx/geometry/point.h"
#include "url/gurl.h"

namespace domicile {
namespace {

using Action = mojom::WebViewContextMenuAction;
using blink::mojom::ContextMenuDataMediaType;

content::ContextMenuParams OverAnImageInALink() {
  content::ContextMenuParams params;
  params.link_url = GURL("https://example.test/opened");
  params.unfiltered_link_url = GURL("https://example.test/opened");
  params.link_text = u"a picture";
  params.src_url = GURL("https://example.test/picture.png");
  params.media_type = ContextMenuDataMediaType::kImage;
  params.has_image_contents = true;
  return params;
}

TEST(ContextMenuTest, TheMenuSaysWhatWasUnderTheClick) {
  const mojom::WebViewContextMenuPtr menu =
      AsWebViewContextMenu(7, OverAnImageInALink(), gfx::Point(12, 34));

  EXPECT_EQ(menu->id, 7);
  EXPECT_EQ(menu->x, 12);
  EXPECT_EQ(menu->y, 34);
  EXPECT_EQ(menu->link_url, GURL("https://example.test/opened"));
  EXPECT_EQ(menu->link_text, "a picture");
  EXPECT_EQ(menu->src_url, GURL("https://example.test/picture.png"));
  EXPECT_EQ(menu->media_type, mojom::WebViewMediaType::kImage);
  EXPECT_TRUE(menu->has_image_contents);
}

TEST(ContextMenuTest, AnElectronAppHearsWhatWasUnderTheClick) {
  content::ContextMenuParams params = OverAnImageInALink();
  params.page_url = GURL("https://example.test/");
  params.media_flags = blink::ContextMenuData::kMediaCanSave;
  const ElectronContextMenu menu =
      AsElectronContextMenu(params, gfx::Point(12, 34));

  EXPECT_EQ(menu.x, 12);
  EXPECT_EQ(menu.y, 34);
  EXPECT_EQ(menu.link_url, "https://example.test/opened");
  EXPECT_EQ(menu.link_text, "a picture");
  EXPECT_EQ(menu.page_url, "https://example.test/");
  EXPECT_EQ(menu.src_url, "https://example.test/picture.png");
  EXPECT_EQ(menu.media_type, "image");
  EXPECT_TRUE(menu.has_image_contents);
  EXPECT_EQ(menu.media_flags,
            ElectronContextMenu::MediaFlags{.can_save = true});
}

TEST(ContextMenuTest, AnElectronAppHearsTheMisspellingAndEditFlags) {
  content::ContextMenuParams params;
  params.is_editable = true;
  params.spellcheck_enabled = true;
  params.misspelled_word = u"teh";
  params.dictionary_suggestions = {u"the", u"ten"};
  params.edit_flags = blink::ContextMenuDataEditFlags::kCanPaste |
                      blink::ContextMenuDataEditFlags::kCanSelectAll;
  const ElectronContextMenu menu = AsElectronContextMenu(params, gfx::Point());

  EXPECT_TRUE(menu.is_editable);
  EXPECT_TRUE(menu.spellcheck_enabled);
  EXPECT_EQ(menu.misspelled_word, "teh");
  EXPECT_EQ(menu.dictionary_suggestions,
            (std::vector<std::string>{"the", "ten"}));
  EXPECT_EQ(menu.edit_flags, (ElectronContextMenu::EditFlags{
                                 .can_paste = true, .can_select_all = true}));
  EXPECT_EQ(menu.media_type, "none");
}

TEST(ContextMenuTest, TheLinkIsTheOneTheGuestMayAskFor) {
  // A link content filtered is the blocked page: a shell opening it in a new
  // window opens nothing the page could not have opened itself.
  content::ContextMenuParams params;
  params.link_url = GURL("about:blank#blocked");
  params.unfiltered_link_url = GURL("file:///etc/passwd");

  EXPECT_EQ(AsWebViewContextMenu(1, params, gfx::Point())->link_url,
            GURL("about:blank#blocked"));
}

TEST(ContextMenuTest, EachEditFlagIsItsOwnAnswer) {
  content::ContextMenuParams params;
  params.is_editable = true;
  params.selection_text = u"chosen";
  params.edit_flags = blink::ContextMenuDataEditFlags::kCanCut |
                      blink::ContextMenuDataEditFlags::kCanPaste |
                      blink::ContextMenuDataEditFlags::kCanSelectAll;

  const mojom::WebViewContextMenuPtr menu =
      AsWebViewContextMenu(1, params, gfx::Point());

  EXPECT_TRUE(menu->is_editable);
  EXPECT_EQ(menu->selection_text, "chosen");
  EXPECT_FALSE(menu->can_undo);
  EXPECT_FALSE(menu->can_redo);
  EXPECT_TRUE(menu->can_cut);
  EXPECT_FALSE(menu->can_copy);
  EXPECT_TRUE(menu->can_paste);
  EXPECT_FALSE(menu->can_delete);
  EXPECT_TRUE(menu->can_select_all);
}

TEST(ContextMenuTest, EveryMediaTypeHasItsOwnName) {
  content::ContextMenuParams params;
  const auto named = [&params](ContextMenuDataMediaType type) {
    params.media_type = type;
    return AsWebViewContextMenu(1, params, gfx::Point())->media_type;
  };

  EXPECT_EQ(named(ContextMenuDataMediaType::kNone),
            mojom::WebViewMediaType::kNone);
  EXPECT_EQ(named(ContextMenuDataMediaType::kImage),
            mojom::WebViewMediaType::kImage);
  EXPECT_EQ(named(ContextMenuDataMediaType::kVideo),
            mojom::WebViewMediaType::kVideo);
  EXPECT_EQ(named(ContextMenuDataMediaType::kAudio),
            mojom::WebViewMediaType::kAudio);
  EXPECT_EQ(named(ContextMenuDataMediaType::kCanvas),
            mojom::WebViewMediaType::kCanvas);
  EXPECT_EQ(named(ContextMenuDataMediaType::kFile),
            mojom::WebViewMediaType::kFile);
  EXPECT_EQ(named(ContextMenuDataMediaType::kPlugin),
            mojom::WebViewMediaType::kPlugin);
}

TEST(ContextMenuTest, EditingAndInspectingAreOfferedEverywhere) {
  // The edit flags are the renderer's opinion, which a shell grays items out
  // by; the command itself is harmless where there is nothing to do.
  const content::ContextMenuParams nothing;
  for (Action action :
       {Action::kUndo, Action::kRedo, Action::kCut, Action::kCopy,
        Action::kPaste, Action::kPasteAndMatchStyle, Action::kDelete,
        Action::kSelectAll, Action::kInspect}) {
    EXPECT_TRUE(Offers(nothing, action));
  }
}

TEST(ContextMenuTest, TheMenuOverAMisspellingSaysTheWordAndSuggestions) {
  content::ContextMenuParams params;
  params.is_editable = true;
  params.misspelled_word = u"recieve";
  params.dictionary_suggestions = {u"receive", u"relieve"};

  const mojom::WebViewContextMenuPtr menu =
      AsWebViewContextMenu(1, params, gfx::Point());
  EXPECT_EQ(menu->misspelled_word, "recieve");
  EXPECT_EQ(menu->spelling_suggestions,
            (std::vector<std::string>{"receive", "relieve"}));
  EXPECT_TRUE(Offers(params, Action::kAddToDictionary));
  EXPECT_TRUE(OffersSpellingFixes(params));
}

TEST(ContextMenuTest, OnlyAMisspellingIsAddedToTheDictionaryOrReplaced) {
  content::ContextMenuParams params;
  params.is_editable = true;

  const mojom::WebViewContextMenuPtr menu =
      AsWebViewContextMenu(1, params, gfx::Point());
  EXPECT_EQ(menu->misspelled_word, "");
  EXPECT_TRUE(menu->spelling_suggestions.empty());
  EXPECT_FALSE(Offers(params, Action::kAddToDictionary));
  EXPECT_FALSE(OffersSpellingFixes(params));
}

TEST(ContextMenuTest, ALinksActionsNeedALink) {
  const content::ContextMenuParams nothing;
  EXPECT_FALSE(Offers(nothing, Action::kCopyLinkAddress));
  EXPECT_FALSE(Offers(nothing, Action::kSaveLinkAs));

  EXPECT_TRUE(Offers(OverAnImageInALink(), Action::kCopyLinkAddress));
  EXPECT_TRUE(Offers(OverAnImageInALink(), Action::kSaveLinkAs));
}

TEST(ContextMenuTest, AMediasActionsNeedMedia) {
  const content::ContextMenuParams nothing;
  EXPECT_FALSE(Offers(nothing, Action::kCopyImage));
  EXPECT_FALSE(Offers(nothing, Action::kCopyMediaAddress));
  EXPECT_FALSE(Offers(nothing, Action::kSaveMediaAs));

  EXPECT_TRUE(Offers(OverAnImageInALink(), Action::kCopyImage));
  EXPECT_TRUE(Offers(OverAnImageInALink(), Action::kCopyMediaAddress));
  EXPECT_TRUE(Offers(OverAnImageInALink(), Action::kSaveMediaAs));
}

TEST(ContextMenuTest, ABrokenImageHasNoPixelsToCopy) {
  content::ContextMenuParams params = OverAnImageInALink();
  params.has_image_contents = false;

  EXPECT_FALSE(Offers(params, Action::kCopyImage));
  // Its address is still one, and saving it fetches it again.
  EXPECT_TRUE(Offers(params, Action::kCopyMediaAddress));
  EXPECT_TRUE(Offers(params, Action::kSaveMediaAs));
}

TEST(ContextMenuTest, AVideoIsNotAnImage) {
  content::ContextMenuParams params;
  params.src_url = GURL("https://example.test/film.webm");
  params.media_type = ContextMenuDataMediaType::kVideo;
  params.has_image_contents = false;

  EXPECT_FALSE(Offers(params, Action::kCopyImage));
  EXPECT_TRUE(Offers(params, Action::kCopyMediaAddress));
  EXPECT_TRUE(Offers(params, Action::kSaveMediaAs));
}

TEST(ContextMenuTest, ACanvasHasPixelsAndNoAddress) {
  // Chrome saves a canvas by asking the renderer for its pixels, so it is
  // saved and copied but its address -- it has none -- is not copied.
  content::ContextMenuParams params;
  params.media_type = ContextMenuDataMediaType::kCanvas;
  params.has_image_contents = true;

  EXPECT_TRUE(Offers(params, Action::kCopyImage));
  EXPECT_FALSE(Offers(params, Action::kCopyMediaAddress));
  EXPECT_TRUE(Offers(params, Action::kSaveMediaAs));
}

TEST(ContextMenuTest, AVideoBlinkCanFloatGoesIntoPictureInPicture) {
  content::ContextMenuParams params;
  params.src_url = GURL("https://example.test/film.webm");
  params.media_type = ContextMenuDataMediaType::kVideo;
  params.media_flags = blink::ContextMenuData::kMediaCanPictureInPicture;

  const mojom::WebViewContextMenuPtr menu =
      AsWebViewContextMenu(1, params, gfx::Point());
  EXPECT_TRUE(menu->can_picture_in_picture);
  EXPECT_FALSE(menu->in_picture_in_picture);
  EXPECT_TRUE(Offers(params, Action::kPictureInPicture));
}

TEST(ContextMenuTest, AVideoInPictureInPictureSaysSo) {
  content::ContextMenuParams params;
  params.media_type = ContextMenuDataMediaType::kVideo;
  params.media_flags = blink::ContextMenuData::kMediaCanPictureInPicture |
                       blink::ContextMenuData::kMediaPictureInPicture;

  EXPECT_TRUE(
      AsWebViewContextMenu(1, params, gfx::Point())->in_picture_in_picture);
  EXPECT_TRUE(Offers(params, Action::kPictureInPicture));
}

TEST(ContextMenuTest, OnlyAVideoBlinkCanFloatGoesIntoPictureInPicture) {
  content::ContextMenuParams video;
  video.media_type = ContextMenuDataMediaType::kVideo;
  // An image's flags are never a video's, whatever they say.
  content::ContextMenuParams image = OverAnImageInALink();
  image.media_flags = blink::ContextMenuData::kMediaCanPictureInPicture;

  EXPECT_FALSE(
      AsWebViewContextMenu(1, video, gfx::Point())->can_picture_in_picture);
  EXPECT_FALSE(Offers(video, Action::kPictureInPicture));
  EXPECT_FALSE(Offers(image, Action::kPictureInPicture));
}

}  // namespace
}  // namespace domicile

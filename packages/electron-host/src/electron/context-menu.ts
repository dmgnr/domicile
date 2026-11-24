/**
 * A page's context menu as Electron's webContents `context-menu` hands it to
 * the app.
 *
 * @module
 */

import type { WindowEvent } from "../engine";

/** A context menu the user asked for over a page, as the engine says it. */
export type ContextMenuAsked = Extract<WindowEvent, { type: "context_menu" }>;

/**
 * Electron's `context-menu` params for `menu`, with `frame` the frame it was
 * over: the main frame's, or null for a subframe's, which the engine doesn't
 * name. The engine doesn't say how the menu was asked for, or what kind of
 * field or selection it was over, so those read as a mouse's over none.
 */
export const contextMenuParams = <Frame>(
  menu: ContextMenuAsked,
  mainFrame: Frame,
) => ({
  altText: menu.alt_text,
  dictionarySuggestions: menu.dictionary_suggestions,
  editFlags: {
    canCopy: menu.edit_flags.can_copy,
    canCut: menu.edit_flags.can_cut,
    canDelete: menu.edit_flags.can_delete,
    canEditRichly: menu.edit_flags.can_edit_richly,
    canPaste: menu.edit_flags.can_paste,
    canRedo: menu.edit_flags.can_redo,
    canSelectAll: menu.edit_flags.can_select_all,
    canUndo: menu.edit_flags.can_undo,
  },
  formControlType: "none",
  frame:
    menu.frame_url === "" || menu.frame_url === menu.page_url
      ? mainFrame
      : null,
  frameCharset: menu.frame_charset,
  frameURL: menu.frame_url,
  hasImageContents: menu.has_image_contents,
  inputFieldType: "none",
  isEditable: menu.is_editable,
  linkText: menu.link_text,
  linkURL: menu.link_url,
  mediaFlags: {
    canLoop: menu.media_flags.can_loop,
    canPrint: menu.media_flags.can_print,
    canRotate: menu.media_flags.can_rotate,
    canSave: menu.media_flags.can_save,
    canShowPictureInPicture: menu.media_flags.can_show_picture_in_picture,
    canToggleControls: menu.media_flags.can_toggle_controls,
    hasAudio: menu.media_flags.has_audio,
    inError: menu.media_flags.in_error,
    isControlsVisible: menu.media_flags.is_controls_visible,
    isLooping: menu.media_flags.is_looping,
    isMuted: menu.media_flags.is_muted,
    isPaused: menu.media_flags.is_paused,
    isShowingPictureInPicture: menu.media_flags.is_showing_picture_in_picture,
  },
  mediaType: menu.media_type,
  menuSourceType: "mouse",
  misspelledWord: menu.misspelled_word,
  pageURL: menu.page_url,
  referrerPolicy: { policy: "default", url: "" },
  selectionRect: { height: 0, width: 0, x: 0, y: 0 },
  selectionStartOffset: 0,
  selectionText: menu.selection_text,
  spellcheckEnabled: menu.spellcheck_enabled,
  srcURL: menu.src_url,
  suggestedFilename: menu.suggested_filename,
  titleText: menu.title_text,
  x: menu.x,
  y: menu.y,
});

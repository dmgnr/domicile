// The stand-in for Electron's `TouchBar`, which only a MacBook's Touch Bar
// shows. Electron has it on Linux, showing nothing, so an app can build one
// without asking where it runs: each item keeps what the app gave it.

/** What every Touch Bar item is made from: the app's options, kept as given. */
class TouchBarItem {
  [option: string]: unknown;

  constructor(options: Readonly<Record<string, unknown>> = {}) {
    Object.assign(this, options);
  }
}

/** Electron's `TouchBar`, with its item classes. */
export class TouchBar {
  static readonly TouchBarButton = class TouchBarButton extends TouchBarItem {};
  static readonly TouchBarColorPicker =
    class TouchBarColorPicker extends TouchBarItem {};
  static readonly TouchBarGroup = class TouchBarGroup extends TouchBarItem {};
  static readonly TouchBarLabel = class TouchBarLabel extends TouchBarItem {};
  static readonly TouchBarOtherItemsProxy =
    class TouchBarOtherItemsProxy extends TouchBarItem {};
  static readonly TouchBarPopover =
    class TouchBarPopover extends TouchBarItem {};
  static readonly TouchBarScrubber =
    class TouchBarScrubber extends TouchBarItem {};
  static readonly TouchBarSegmentedControl =
    class TouchBarSegmentedControl extends TouchBarItem {};
  static readonly TouchBarSlider = class TouchBarSlider extends TouchBarItem {};
  static readonly TouchBarSpacer = class TouchBarSpacer extends TouchBarItem {};

  readonly items: readonly TouchBarItem[];
  escapeItem: TouchBarItem | null;

  constructor(options: {
    readonly items?: readonly TouchBarItem[];
    readonly escapeItem?: TouchBarItem | null;
  }) {
    this.items = options.items ?? [];
    this.escapeItem = options.escapeItem ?? null;
  }
}

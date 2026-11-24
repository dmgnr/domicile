import type { CastClaim } from "@domicile-desktop/sdk/cast";
import { CastClaimKind } from "@domicile-desktop/sdk/cast";
import type {
  Browser,
  BrowserWindow,
} from "@domicile-desktop/sdk/desktop/browser";
import type { Capture } from "@domicile-desktop/sdk/desktop/capture";
import type { Dbus } from "@domicile-desktop/sdk/desktop/dbus";
import type { Files } from "@domicile-desktop/sdk/desktop/files";
import type { Portals } from "@domicile-desktop/sdk/desktop/portals";
import type { Processes } from "@domicile-desktop/sdk/desktop/processes";
import type { GlobalShortcutsDesktop } from "@domicile-desktop/sdk/global-shortcuts";
import { fireGlobalShortcuts } from "@domicile-desktop/sdk/global-shortcuts";
import type { Capturing, PortalRequest } from "@domicile-desktop/sdk/portal";
import {
  CapturingKind,
  CastSourceKind,
  PortalAnswer,
  PortalKind,
  SHELL_APP_ID,
} from "@domicile-desktop/sdk/portal";
import { memo, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { Folders } from "../FilePicker/folders";
import { desktopFolders } from "../FilePicker/folders";
import { useLeavingRows } from "../LeavingRows/useLeavingRows";
import type { App } from "../useApps/useApps";
import { useApps } from "../useApps/useApps";
import { AccessDialog } from "./AccessDialog";
import { AccountDialog } from "./AccountDialog";
import { AgentDialog } from "./AgentDialog";
import { AppChooserDialog } from "./AppChooserDialog";
import { CapturingIndicator } from "./CapturingIndicator";
import { FileChooserDialog } from "./FileChooserDialog";
import { GlobalShortcutsDialog } from "./GlobalShortcutsDialog";
import { InputCaptureDialog } from "./InputCaptureDialog";
import { LauncherDialog } from "./LauncherDialog";
import { PickColorDialog } from "./PickColorDialog";
import { PrintDialog } from "./PrintDialog";
import { pageIcon } from "./page-icon";
import type { Presence } from "./presence";
import type { Recording } from "./RecordingToolbar";
import { RecordingToolbar } from "./RecordingToolbar";
import { RemoteDesktopDialog } from "./RemoteDesktopDialog";
import { ScreenCastDialog } from "./ScreenCastDialog";
import { ScreenshotDialog } from "./ScreenshotDialog";
import type { ShownWindow } from "./shown-windows";
import { drawnWindows } from "./shown-windows";
import { UsbDialog } from "./UsbDialog";
import { useCastClaims } from "./useCastClaims";
import { WallpaperDialog } from "./WallpaperDialog";
import "../stylesheet";

/** What the dialogs read and draw through. */
export type DialogDesktop = {
  readonly capture: Pick<Capture, "preview">;
  readonly dbus: Pick<Dbus, "call">;
  readonly files: Omit<Files, "search">;
  readonly processes: Pick<Processes, "run" | "spawn">;
};

/** What {@link PortalDialogs} needs of the desktop. */
export type PortalDialogsDesktop = DialogDesktop &
  GlobalShortcutsDesktop & {
    readonly browser: Pick<Browser, "windows">;
    readonly portals: Pick<
      Portals,
      | "answer"
      | "capturing"
      | "changeAgent"
      | "discardRecording"
      | "on"
      | "pauseRecording"
      | "requests"
      | "resumeRecording"
      | "stopCapturing"
    >;
  };

/** No chords or windows; one array, so the default is stable across renders. */
const NONE: readonly string[] = [];

type Props = {
  /** The desktop `Shell` is handed. */
  domicile: PortalDialogsDesktop;
  /**
   * The display to show a dialog on when it has no parent window. Needs a
   * `DisplayProvider`; without it, a dialog is centered on the whole page.
   */
  screen?: string | undefined;
  /**
   * Leave screen casts out of the capturing indicator, for a shell that shows
   * them itself.
   */
  omitScreenCasts?: boolean | undefined;
  /**
   * Leave agents out of the capturing indicator, for a shell that shows them
   * itself.
   */
  omitAgents?: boolean | undefined;
  /**
   * The browser windows the shell shows as closed, by the engine's id, such
   * as an inbox's kept running for its notifications. Pickers leave them out.
   */
  closedBrowsers?: readonly string[] | undefined;
  /**
   * The windows the shell draws on screen, with their whole frames. Without
   * it, the screenshot dialog reads the page's `<app>` and `<webview window>`
   * boxes. See {@link drawnWindows}.
   */
  shownWindows?: (() => readonly ShownWindow[]) | undefined;
  /**
   * The display showing the `<app>` with this id, for a dialog modal over
   * it. `undefined` uses `screen`.
   */
  screenOf?: ((appId: string) => string | undefined) | undefined;
  /** The shell's own chords, which a global shortcuts review flags. */
  shellChords?: readonly string[] | undefined;
  /**
   * Takes the keyboard off the windows while a dialog is up, until the
   * returned function is called. Without it, the window that had the keyboard
   * keeps it, and the engine sends it every key a dialog does not take.
   */
  holdKeyboard?: (() => () => void) | undefined;
};

/**
 * Every dialog applications ask for through `xdg-desktop-portal`, one at a
 * time, oldest first, with a screenshot, color pick or screen cast stacked
 * over it so the user can capture it, and an indicator for each session that
 * controls or captures input. The shell's own screen recording gets a toolbar
 * instead, left out of the recording. Requests of a kind it has no dialog for
 * are refused.
 * Inhibitors are not questions, so it leaves them be. It also fires the
 * chords applications hold through the GlobalShortcuts portal. See
 * docs/PORTALS.md.
 */
export const PortalDialogs = memo(
  ({
    closedBrowsers = NONE,
    domicile,
    holdKeyboard,
    omitScreenCasts = false,
    omitAgents = false,
    screen,
    screenOf,
    shellChords = NONE,
    shownWindows = drawnOnPage,
  }: Props) => {
    const [requests, setRequests] = useState<readonly PortalRequest[]>([]);
    const folders = useMemo(() => desktopFolders(domicile.files), [domicile]);
    const [sessions, setSessions] = useState<readonly Capturing[]>([]);
    const apps = useApps(domicile, [
      ...requests.flatMap(appIds),
      ...sessions.map((session) => session.appId),
      // App windows the pickers offer are named and drawn as their apps.
      ...(domicile.browser.windows ?? []).map((window) => window.appId),
    ]);

    const { portals } = domicile;
    const claims = useCastClaims(domicile, requests);

    useEffect(() => {
      const heard = () => {
        setRequests(portals.requests ?? []);
        setSessions(portals.capturing ?? []);
      };
      heard();
      return portals.on("change", heard);
    }, [portals]);
    useEffect(() => fireGlobalShortcuts(domicile), [domicile]);

    useEffect(() => {
      for (const request of requests) {
        if (request.kind === PortalKind.Unknown) {
          portals.answer(request.id, PortalAnswer.Refused());
        }
      }
    }, [portals, requests]);

    const dialogs = useMemo(
      () =>
        stacked(
          requests.filter(
            (request) =>
              claims.get(request.id)?.kind !== CastClaimKind.Answered,
          ),
        ),
      [claims, requests],
    );
    // A dialog stays, closed, until it has animated out. One a cast to a TV
    // answered never showed, so it goes at once, before paint.
    const { onLeft, rows } = useLeavingRows(dialogs, idOf, true);
    useLayoutEffect(() => {
      for (const { item, leaving } of rows) {
        if (
          leaving !== undefined &&
          claims.get(item.id)?.kind === CastClaimKind.Answered
        ) {
          onLeft(item.id);
        }
      }
    }, [claims, onLeft, rows]);
    const asking = dialogs.length > 0;
    useEffect(
      () => (asking ? holdKeyboard?.() : undefined),
      [asking, holdKeyboard],
    );

    const recordings = sessions.filter(isRecording);
    return (
      <>
        <CapturingIndicator
          apps={apps}
          change={(id) => {
            portals.changeAgent(id);
          }}
          screen={screen}
          sessions={sessions.filter(
            (session) =>
              !isRecording(session) &&
              !(omitScreenCasts && session.kind === CapturingKind.ScreenCast) &&
              !(omitAgents && session.kind === CapturingKind.Agent),
          )}
          stop={(id) => {
            portals.stopCapturing(id);
          }}
        />
        {recordings.map((recording) => (
          <RecordingToolbar
            discard={() => {
              portals.discardRecording(recording.id);
            }}
            key={recording.id}
            pause={() => {
              portals.pauseRecording(recording.id);
            }}
            recording={recording}
            resume={() => {
              portals.resumeRecording(recording.id);
            }}
            screen={screen}
            stop={() => {
              portals.stopCapturing(recording.id);
            }}
          />
        ))}
        {rows.map(({ item: shown, leaving }) => (
          <Dialog
            answer={(answer) => {
              portals.answer(shown.id, answer);
            }}
            apps={apps}
            asker={apps(shown.appId).name}
            browserWindows={(domicile.browser.windows ?? []).filter(
              ({ id }) => !closedBrowsers.includes(id),
            )}
            claim={claims.get(shown.id)}
            domicile={domicile}
            folders={folders}
            key={shown.id}
            presence={{
              onOpenChangeComplete: (open) => {
                if (!open) {
                  onLeft(shown.id);
                }
              },
              open: leaving === undefined,
            }}
            request={shown}
            screen={screenFor(shown, screen, screenOf)}
            shellChords={shellChords}
            shownWindows={shownWindows}
          />
        ))}
      </>
    );
  },
);

const idOf = (request: PortalRequest): number => request.id;

/** The windows this page draws. */
const drawnOnPage = () => drawnWindows(document);

/** A browser window's page icon, from its view on this page. */
const pageIconOnPage = (id: string) => pageIcon(document, id);

const isRecording = (session: Capturing): session is Recording =>
  session.kind === CapturingKind.Recording;

/** The dialog for `request`'s kind. */
const Dialog = ({
  answer,
  apps,
  asker,
  browserWindows,
  claim,
  folders,
  presence,
  request,
  screen,
  shellChords,
  shownWindows,
  domicile,
}: {
  answer: (answer: PortalAnswer) => void;
  apps: (appId: string) => App;
  asker: string;
  browserWindows: readonly BrowserWindow[];
  /** What a cast to a TV that asked for `request` makes of it. */
  claim: CastClaim | undefined;
  folders: Folders;
  presence: Presence;
  request: PortalRequest;
  screen: string | undefined;
  shellChords: readonly string[];
  shownWindows: () => readonly ShownWindow[];
  domicile: DialogDesktop;
}) => {
  switch (request.kind) {
    case PortalKind.Access:
      return (
        <AccessDialog
          answer={answer}
          asker={request.appId === SHELL_APP_ID ? undefined : asker}
          body={request.body}
          presence={presence}
          screen={screen}
        />
      );
    case PortalKind.RemoteDesktop:
      return (
        <RemoteDesktopDialog
          answer={answer}
          asker={asker}
          body={request.body}
          presence={presence}
          screen={screen}
        />
      );
    case PortalKind.InputCapture:
      return (
        <InputCaptureDialog
          answer={answer}
          asker={asker}
          body={request.body}
          presence={presence}
          screen={screen}
        />
      );
    case PortalKind.AppChooser:
      return (
        <AppChooserDialog
          answer={answer}
          asker={asker}
          body={request.body}
          domicile={domicile}
          presence={presence}
          screen={screen}
        />
      );
    case PortalKind.FileChooser:
      return (
        <FileChooserDialog
          answer={answer}
          body={request.body}
          folders={folders}
          presence={presence}
          screen={screen}
        />
      );
    case PortalKind.Account:
      return (
        <AccountDialog
          answer={answer}
          asker={asker}
          body={request.body}
          files={domicile.files}
          presence={presence}
          screen={screen}
        />
      );
    case PortalKind.GlobalShortcuts:
      return (
        <GlobalShortcutsDialog
          answer={answer}
          apps={apps}
          asker={asker}
          body={request.body}
          presence={presence}
          screen={screen}
          shellChords={shellChords}
        />
      );
    case PortalKind.Wallpaper:
      return (
        <WallpaperDialog
          answer={answer}
          asker={asker}
          body={request.body}
          files={domicile.files}
          presence={presence}
          screen={screen}
        />
      );
    case PortalKind.DynamicLauncher:
      return (
        <LauncherDialog
          answer={answer}
          asker={asker}
          body={request.body}
          presence={presence}
          screen={screen}
        />
      );
    case PortalKind.Usb:
      return (
        <UsbDialog
          answer={answer}
          asker={asker}
          body={request.body}
          presence={presence}
          screen={screen}
        />
      );
    case PortalKind.ScreenCast:
      return (
        <ScreenCastDialog
          answer={answer}
          apps={apps}
          asker={asker}
          body={request.body}
          browserWindows={browserWindows}
          castTo={claim?.kind === CastClaimKind.Pick ? claim.to : undefined}
          pageIcon={pageIconOnPage}
          presence={presence}
          previewWindow={domicile.capture.preview}
          record={request.appId === SHELL_APP_ID}
          screen={screen}
          shownWindows={shownWindows}
        />
      );
    case PortalKind.Print:
      return (
        <PrintDialog
          answer={answer}
          asker={asker}
          body={request.body}
          folders={folders}
          presence={presence}
          screen={screen}
        />
      );
    case PortalKind.Screenshot:
      return (
        <ScreenshotDialog
          answer={answer}
          apps={apps}
          asker={request.appId === SHELL_APP_ID ? undefined : asker}
          body={request.body}
          browserWindows={browserWindows}
          pageIcon={pageIconOnPage}
          presence={presence}
          previewWindow={domicile.capture.preview}
          screen={screen}
          shownWindows={shownWindows}
        />
      );
    case PortalKind.PickColor:
      return (
        <PickColorDialog
          answer={answer}
          asker={asker}
          body={request.body}
          presence={presence}
          screen={screen}
        />
      );
    case PortalKind.Agent:
      return (
        <AgentDialog
          answer={answer}
          apps={apps}
          body={request.body}
          presence={presence}
          screen={screen}
        />
      );
    case PortalKind.Inhibit:
    case PortalKind.Unknown:
      return undefined;
  }
};

/** The display for `request`: its parent window's, else `screen`. */
const screenFor = (
  request: PortalRequest,
  screen: string | undefined,
  screenOf: Props["screenOf"],
): string | undefined => {
  const parents =
    request.parentAppId === undefined
      ? undefined
      : screenOf?.(request.parentAppId);
  return parents ?? screen;
};

/**
 * The applications `request` names: who asks, the windows it offers, and who
 * holds the chords it asks for.
 */
const appIds = (request: PortalRequest): string[] => [
  request.appId,
  ...otherAppIds(request),
];

/**
 * The applications of the windows `request` offers to record or shoot, or
 * that hold chords it asks for.
 */
const otherAppIds = (request: PortalRequest): string[] => {
  switch (request.kind) {
    case PortalKind.ScreenCast:
      return request.body.sources.flatMap((source) =>
        source.kind === CastSourceKind.Window ? [source.appId] : [],
      );
    case PortalKind.Screenshot:
      return request.body.windows.map((window) => window.appId);
    case PortalKind.GlobalShortcuts:
      return request.body.taken.map((held) => held.appId);
    case PortalKind.Access:
    case PortalKind.AppChooser:
    case PortalKind.FileChooser:
    case PortalKind.RemoteDesktop:
    case PortalKind.InputCapture:
    case PortalKind.DynamicLauncher:
    case PortalKind.Usb:
    case PortalKind.Account:
    case PortalKind.Wallpaper:
    case PortalKind.Print:
    case PortalKind.PickColor:
    case PortalKind.Inhibit:
    case PortalKind.Unknown:
      return [];
    case PortalKind.Agent:
      return request.body.windows.flatMap((window) =>
        !window.browser && window.app !== undefined ? [window.app] : [],
      );
  }
};

/**
 * The dialogs to draw, bottom first: the oldest question and, over it, the
 * oldest capture after it, so the user can capture the dialog under it.
 * Anything asked after a capture waits for it.
 */
const stacked = (requests: readonly PortalRequest[]): PortalRequest[] => {
  const asked = requests.filter(isAsked);
  const capture = asked.find(isCapture);
  return capture === undefined || capture === asked[0]
    ? asked.slice(0, 1)
    : [...asked.slice(0, 1), capture];
};

/** Whether `request` captures the desk, so it can capture other dialogs. */
const isCapture = (request: PortalRequest): boolean => {
  switch (request.kind) {
    case PortalKind.Screenshot:
    case PortalKind.PickColor:
    case PortalKind.ScreenCast:
      return true;
    case PortalKind.Access:
    case PortalKind.AppChooser:
    case PortalKind.FileChooser:
    case PortalKind.RemoteDesktop:
    case PortalKind.InputCapture:
    case PortalKind.DynamicLauncher:
    case PortalKind.Usb:
    case PortalKind.Account:
    case PortalKind.GlobalShortcuts:
    case PortalKind.Wallpaper:
    case PortalKind.Print:
    case PortalKind.Agent:
    case PortalKind.Inhibit:
    case PortalKind.Unknown:
      return false;
  }
};

/** Whether `request` is a question this draws a dialog for. */
const isAsked = (request: PortalRequest): boolean => {
  switch (request.kind) {
    case PortalKind.Access:
    case PortalKind.AppChooser:
    case PortalKind.FileChooser:
    case PortalKind.RemoteDesktop:
    case PortalKind.InputCapture:
    case PortalKind.DynamicLauncher:
    case PortalKind.Usb:
    case PortalKind.Account:
    case PortalKind.GlobalShortcuts:
    case PortalKind.Wallpaper:
    case PortalKind.ScreenCast:
    case PortalKind.Print:
    case PortalKind.Screenshot:
    case PortalKind.PickColor:
    case PortalKind.Agent:
      return true;
    case PortalKind.Inhibit:
    case PortalKind.Unknown:
      return false;
  }
};

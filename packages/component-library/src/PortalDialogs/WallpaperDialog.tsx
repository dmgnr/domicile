import type { Files } from "@domicile-desktop/sdk/desktop/files";
import type { PortalAnswer, WallpaperBody } from "@domicile-desktop/sdk/portal";
import {
  PortalAnswer as Answer,
  WallpaperTarget,
} from "@domicile-desktop/sdk/portal";
import { css } from "../../styled-system/css";
import { Button } from "../Button/Button";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import { usePictureUrl } from "../usePictureUrl/usePictureUrl";
import type { Presence } from "./presence";

type Props = {
  answer: (answer: PortalAnswer) => void;
  /** Who asks, as the dialog names them. */
  asker: string;
  body: WallpaperBody;
  files: Pick<Files, "read">;
  /** Whether it is up; see {@link Presence}. */
  presence: Presence;
  screen: string | undefined;
};

/**
 * A picture an application would set as the wallpaper. Dismissing it keeps the
 * old one.
 */
export const WallpaperDialog = ({
  answer,
  asker,
  body,
  files,
  presence,
  screen,
}: Props) => {
  const url = usePictureUrl(files, body.path);
  return (
    <ModalDialog
      closeButton={false}
      footer={
        <>
          <Button
            onClick={() => {
              answer(Answer.Canceled());
            }}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              answer(Answer.Access());
            }}
          >
            Set
          </Button>
        </>
      }
      onOpenChange={(open) => {
        if (!open) {
          answer(Answer.Canceled());
        }
      }}
      {...presence}
      screen={screen}
      title={`${asker} wants to change the wallpaper`}
    >
      <p className={targetStyles}>{targetName(body.setOn)}</p>
      {url !== undefined && (
        <img alt="The new wallpaper" className={previewStyles} src={url} />
      )}
    </ModalDialog>
  );
};

const targetStyles = css({ color: "muted", fontSize: "sm", margin: 0 });

const previewStyles = css({
  aspectRatio: "16 / 9",
  borderRadius: "md",
  inlineSize: "100%",
  objectFit: "cover",
});

/** Where the picture goes, as the dialog says it. */
const targetName = (target: WallpaperTarget): string => {
  switch (target) {
    case WallpaperTarget.Background:
      return "Desktop";
    case WallpaperTarget.Lockscreen:
      return "Lock screen";
    case WallpaperTarget.Both:
      return "Desktop and lock screen";
  }
};

import type { Files } from "@domicile-desktop/sdk/desktop/files";
import type { AccountBody, PortalAnswer } from "@domicile-desktop/sdk/portal";
import { PortalAnswer as Answer } from "@domicile-desktop/sdk/portal";
import { css } from "../../styled-system/css";
import { hstack } from "../../styled-system/patterns";
import { Button } from "../Button/Button";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import { usePictureUrl } from "../usePictureUrl/usePictureUrl";
import type { Presence } from "./presence";

type Props = {
  answer: (answer: PortalAnswer) => void;
  /** Who asks, as the dialog names them. */
  asker: string;
  body: AccountBody;
  /** Reads the user's picture. */
  files: Pick<Files, "read">;
  /** Whether it is up; see {@link Presence}. */
  presence: Presence;
  screen: string | undefined;
};

/**
 * Whether an application may have the user's name and picture, showing both.
 * Dismissing it keeps them.
 */
export const AccountDialog = ({
  answer,
  asker,
  body,
  files,
  presence,
  screen,
}: Props) => {
  const picture = usePictureUrl(files, body.image);
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
            Don't share
          </Button>
          <Button
            onClick={() => {
              answer(Answer.Access());
            }}
          >
            Share
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
      title="Share your name and picture?"
    >
      <p className={askerStyles}>{`${asker} asks`}</p>
      {body.reason !== undefined && <p className={textStyles}>{body.reason}</p>}
      <div className={userStyles}>
        {picture !== undefined && (
          <img alt={body.name} className={pictureStyles} src={picture} />
        )}
        <span className={textStyles}>{body.name}</span>
      </div>
    </ModalDialog>
  );
};

const askerStyles = css({ color: "muted", fontSize: "sm", margin: 0 });

const textStyles = css({ color: "foreground", margin: 0 });

const userStyles = hstack({ gap: 3, marginBlockStart: 3 });

const pictureStyles = css({
  blockSize: 10,
  borderRadius: "full",
  inlineSize: 10,
  objectFit: "cover",
});

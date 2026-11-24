import { useDomicile } from "@domicile-desktop/react/domicile-provider";
import { AppReuse } from "@domicile-desktop/sdk/desktop/browser";
import { gmailAppId } from "./addresses";
import type { GoogleClient } from "./consent";
import { deskInbox } from "./desk-inbox";
import { Gmail as Account } from "./Gmail";

type Props = {
  /** The Google account, such as `me@gmail.com`. */
  email: string;
  /** The account's name on the bar, such as `Work`. */
  nickname: string;
  /** The Google Cloud OAuth client (Desktop app) it signs in with. */
  client: GoogleClient;
  /**
   * The id of the browser profile its Gmail window and sign-in open in, such
   * as `work`. By default, the one Gmail's site opens in.
   */
  profile?: string;
};

/**
 * One Gmail account's inbox count, read with the Gmail API. A press opens
 * the account's Gmail window, or brings it up. Not in the default bar.
 */
export const Gmail = ({ client, email, nickname, profile }: Props) => {
  const domicile = useDomicile();
  const account = deskInbox(domicile)(email, client, nickname, profile);
  return (
    <Account
      email={email}
      inbox={account.inbox}
      nickname={nickname}
      onOpen={(url) => {
        domicile.browser.openApp(url, {
          id: gmailAppId(email),
          reuse: AppReuse.Focus,
          ...(profile === undefined ? {} : { profile }),
        });
      }}
      onSignIn={account.signIn}
    />
  );
};

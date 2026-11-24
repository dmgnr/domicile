import { AnimatedLockIcon } from "@domicile-desktop/component-library/AnimatedLockIcon";
import { Button } from "@domicile-desktop/component-library/Button";
import { Popover } from "@domicile-desktop/component-library/Popover";
import { ConnectionSafety } from "@domicile-desktop/manganese-address/connection-safety";
import { InfoIcon } from "@phosphor-icons/react/dist/ssr/Info";
import { QuestionIcon } from "@phosphor-icons/react/dist/ssr/Question";
import { WarningIcon } from "@phosphor-icons/react/dist/ssr/Warning";
import { WarningOctagonIcon } from "@phosphor-icons/react/dist/ssr/WarningOctagon";
import type { ReactElement } from "react";
import { css } from "../../styled-system/css";

type Props = {
  /** The browser's security state for the shown page. */
  security: ConnectionSafety;
  /**
   * The page's address.
   *
   * Must come from the same report as `security` (see `useShownPage`), or the
   * panel could name a host the state does not describe.
   */
  url: string;
};

/**
 * The security icon in the address bar, with a popover explaining it.
 *
 * Only displays the engine's state, computed by
 * `security_state::GetSecurityLevel` as for Chrome's omnibox. It never infers
 * security from the URL.
 */
export const ConnectionIndicator = ({ security, url }: Props) => {
  const { body, mark, title } = INDICATORS[security];
  const host = hostOf(url);
  return (
    <Popover
      align="start"
      side="bottom"
      title={title}
      trigger={
        <Button
          // The icon is all a sighted user sees, so the label matches the
          // panel title.
          label={title}
          size="sm"
          variant="ghost"
        >
          {mark}
        </Button>
      }
    >
      {host === undefined ? undefined : (
        <span className={hostStyles}>{host}</span>
      )}
      <span>{body}</span>
    </Popover>
  );
};

// One class per icon color, used by `INDICATORS`. A secure connection is
// gray, so color only ever means something is wrong.
const neutralMarkStyles = css({
  alignItems: "center",
  color: "muted",
  display: "inline-flex",
});

const warningMarkStyles = css({
  alignItems: "center",
  color: "warning",
  display: "inline-flex",
});

const dangerousMarkStyles = css({
  alignItems: "center",
  color: "danger",
  display: "inline-flex",
});

/**
 * The icon, title and explanation for each security state.
 *
 * A `Record`, so a new {@link ConnectionSafety} variant is a compile error.
 * Declared after the styles because it is evaluated at module load; see
 * /docs/guidelines/FILES.md.
 */
const INDICATORS: Readonly<
  Record<ConnectionSafety, { body: string; mark: ReactElement; title: string }>
> = {
  [ConnectionSafety.Dangerous]: {
    body: "The browser could not establish a private connection to this site. Its certificate did not validate, or the page is running content that undoes the encryption. You should not enter anything sensitive here.",
    mark: (
      <span className={dangerousMarkStyles}>
        <WarningOctagonIcon size={14} />
      </span>
    ),
    title: "Connection is not private",
  },
  [ConnectionSafety.Neutral]: {
    body: "This address is not a network connection, so there is nothing to encrypt. The page comes from this machine or from the browser itself.",
    mark: (
      <span className={neutralMarkStyles}>
        <InfoIcon size={14} />
      </span>
    ),
    title: "Connection is local",
  },
  [ConnectionSafety.Secure]: {
    body: "The browser validated this site's certificate, and what passes between here and it is encrypted. That is a statement about the connection and not about the site: a page can be reached securely and still not be worth trusting.",
    mark: (
      <span className={neutralMarkStyles}>
        <AnimatedLockIcon size={14} />
      </span>
    ),
    title: "Connection is secure",
  },
  // No report yet, e.g. before the first commit. Must look distinct and must
  // not fall back to guessing from the URL scheme.
  [ConnectionSafety.Unstated]: {
    body: "The browser has not reported on this page's connection. Until it does, nothing here is a statement about whether the page is encrypted or whether its certificate is valid.",
    mark: (
      <span className={neutralMarkStyles}>
        <QuestionIcon size={14} />
      </span>
    ),
    title: "Connection is not known",
  },
  [ConnectionSafety.Warning]: {
    body: "This page was not reached over an encrypted connection, so anything sent to or from it can be read and changed by anything on the path between here and the site.",
    mark: (
      <span className={warningMarkStyles}>
        <WarningIcon size={14} />
      </span>
    ),
    title: "Connection is not secure",
  },
};

const hostStyles = css({
  color: "foreground",
  fontFamily: "mono",
  fontSize: "xs",
  overflowWrap: "anywhere",
});

/**
 * The host of `url`, if it has one.
 *
 * Uses `URL.parse`, which does not throw: the engine may report an address
 * this code cannot parse, and throwing in render would crash the shell.
 */
const hostOf = (url: string): string | undefined => {
  const parsed = URL.parse(url);
  return parsed === null || parsed.host === "" ? undefined : parsed.host;
};

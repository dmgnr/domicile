import { Avatar } from "@domicile-desktop/component-library/Avatar";
import { Button } from "@domicile-desktop/component-library/Button";
import { IconButton } from "@domicile-desktop/component-library/IconButton";
import { Loading } from "@domicile-desktop/component-library/Loading";
import type {
  WebViewIdentityAccount,
  WebViewIdentityField,
  WebViewIdentityProvider,
  WebViewIdentityPurpose,
} from "@domicile-desktop/sdk/webview-element";
import { XIcon } from "@phosphor-icons/react/dist/ssr/X";
import type { ReactNode, RefCallback } from "react";
import { useId } from "react";

import { css } from "../styled-system/css";
import { flex, hstack, vstack } from "../styled-system/patterns";
import { PageModal } from "./PageModal";
import type { IdentityRequest } from "./useIdentityRequest";

type Props = {
  /** Opens a link the step shows, such as the site's privacy policy. */
  onOpenLink: (url: string) => void;
  /**
   * Gets the element to focus: the step's first answer. Only after the
   * page's own button: a step the site offers unasked takes no focus.
   */
  ref?: RefCallback<HTMLElement> | undefined;
  request: IdentityRequest;
};

/**
 * A site's "Sign in with" step: the accounts to sign in with, signed out of
 * the provider, signing in, or the provider's refusal.
 *
 * After the page's own sign-in button it asks over the page, as a
 * `PageModal`: Escape cancels. Offered unasked, as a site does on load, it
 * sits in the page's top corner without dimming it, and ✕ closes it.
 */
export const IdentityAsk = ({ onOpenLink, ref, request }: Props) => {
  const step = stepFor(request, onOpenLink, request.button ? ref : undefined);
  return request.button ? (
    <PageModal
      footer={
        <>
          {step.extra}
          {step.dismiss !== undefined && (
            <Button
              onClick={request.dismiss}
              ref={step.dismiss.focused ? ref : undefined}
              variant={step.dismiss.primary ? "accent" : "outline"}
            >
              {step.dismiss.label}
            </Button>
          )}
          {step.primary}
        </>
      }
      message={step.message}
      note={step.note}
      onDismiss={step.dismiss === undefined ? () => undefined : request.dismiss}
      onSubmit={step.submit}
      title={<StepTitle icon={step.icon} title={step.title} />}
    >
      {step.body}
    </PageModal>
  ) : (
    <CornerCard
      footer={
        <>
          {step.extra}
          {step.dismiss?.primary === true && (
            <Button onClick={request.dismiss} size="sm" variant="accent">
              {step.dismiss.label}
            </Button>
          )}
          {step.primary}
        </>
      }
      hasFooter={
        step.extra !== undefined ||
        step.primary !== undefined ||
        step.dismiss?.primary === true
      }
      message={step.message}
      note={step.note}
      onClose={
        step.dismiss === undefined || step.dismiss.primary
          ? undefined
          : request.dismiss
      }
      title={<StepTitle icon={step.icon} title={step.title} />}
    >
      {step.body}
    </CornerCard>
  );
};

/** What a step shows, laid out over the page or in its corner. */
type Step = {
  /** The provider's icon, drawn before the title. */
  icon: WebViewIdentityProvider | undefined;
  title: string;
  message?: string | undefined;
  body?: ReactNode;
  note?: ReactNode;
  /** The answer Enter gives, as its button. */
  primary?: ReactNode;
  submit: () => void;
  /** Answers beside it, such as "Use another account". */
  extra?: ReactNode;
  /**
   * The button that dismisses: Cancel, or OK where dismissing is the answer.
   * `focused` where it is the step's first answer, so it takes the keyboard.
   * None where the step takes no answer.
   */
  dismiss: { label: string; primary: boolean; focused: boolean } | undefined;
};

/** The step's words and answers. */
const stepFor = (
  request: IdentityRequest,
  onOpenLink: (url: string) => void,
  ref: RefCallback<HTMLElement> | undefined,
): Step => {
  const provider = providerAt(request, 0);
  const providerName = provider.name;
  switch (request.step) {
    case "loading":
      return {
        body: (
          <span className={waitingStyles}>
            <Loading layout="glyph">Finding your accounts…</Loading>
            <span aria-hidden>Finding your accounts…</span>
          </span>
        ),
        dismiss: { focused: true, label: "Cancel", primary: false },
        icon: provider,
        submit: () => undefined,
        title: titleFor(request),
      };
    case "accounts":
      return accountsStep(request, onOpenLink, ref);
    case "signed-out":
      return {
        dismiss: { focused: false, label: "Cancel", primary: false },
        icon: provider,
        message: `You're not signed in to ${providerName}. Sign in there, then come back to pick your account.`,
        primary: (
          <AnswerButton
            answer={() => {
              request.signInToProvider(0);
            }}
            modal={request.button}
            ref={ref}
          >
            {`Sign in to ${providerName}`}
          </AnswerButton>
        ),
        submit: () => {
          request.signInToProvider(0);
        },
        title: titleFor(request),
      };
    case "verifying":
      return {
        body: request.accounts.map((account) => (
          <span className={verifyingStyles} key={account.identifier}>
            <AccountLabel account={account} />
            <Loading layout="glyph">Signing in</Loading>
          </span>
        )),
        dismiss: undefined,
        icon: provider,
        submit: () => undefined,
        title: `Signing you in to ${request.site}`,
      };
    case "error":
      return {
        dismiss: { focused: true, label: "OK", primary: true },
        extra:
          request.errorUrl === "" ? undefined : (
            <Button
              onClick={request.moreDetails}
              size={request.button ? "md" : "sm"}
              variant="outline"
            >
              More details
            </Button>
          ),
        icon: provider,
        message: `${providerName} didn't let ${request.site} sign you in. Try again later, or use the site's own sign-in.`,
        submit: request.dismiss,
        title: `Can't sign in with ${providerName}`,
      };
  }
};

/**
 * The accounts: one to continue as, or several to pick from, with what
 * signing in shares the first time.
 */
const accountsStep = (
  request: IdentityRequest,
  onOpenLink: (url: string) => void,
  ref: RefCallback<HTMLElement> | undefined,
): Step => {
  const size = request.button ? "md" : "sm";
  const only = request.accounts.length === 1 ? request.accounts[0] : undefined;
  const sharing = request.accounts.find(({ shared }) => shared.length > 0);
  const adders = request.providers.flatMap((provider, index) =>
    provider.addAccount ? [{ index, provider }] : [],
  );
  return {
    body:
      only === undefined ? (
        <ul aria-label="Accounts" className={accountsStyles}>
          {request.accounts.map((account, index) => (
            <li key={`${account.provider}\n${account.identifier}`}>
              <button
                className={accountButtonStyles}
                onClick={() => {
                  request.choose(index);
                }}
                ref={index === 0 ? ref : undefined}
                type="button"
              >
                <AccountLabel account={account} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <span className={onlyAccountStyles}>
          <AccountLabel account={only} />
        </span>
      ),
    dismiss: { focused: false, label: "Cancel", primary: false },
    extra:
      adders.length === 0
        ? undefined
        : adders.map(({ index, provider }) => (
            <Button
              key={provider.name}
              onClick={() => {
                request.signInToProvider(index);
              }}
              size={size}
              variant="outline"
            >
              {adders.length === 1 && request.providers.length === 1
                ? "Use another account"
                : `Use another ${provider.name} account`}
            </Button>
          )),
    icon: request.providers.length === 1 ? request.providers[0] : undefined,
    note:
      sharing === undefined ? undefined : (
        <Disclosure
          account={sharing}
          onOpenLink={onOpenLink}
          provider={providerAt(request, sharing.provider)}
          site={request.site}
        />
      ),
    primary:
      only === undefined ? undefined : (
        <AnswerButton
          answer={() => {
            request.choose(0);
          }}
          modal={request.button}
          ref={ref}
        >
          {`Continue as ${firstNameOf(only.name)}`}
        </AnswerButton>
      ),
    submit:
      only === undefined
        ? () => undefined
        : () => {
            request.choose(0);
          },
    title: titleFor(request),
  };
};

/**
 * The step's answer. Over the page it submits the `PageModal`, whose submit
 * answers, so Enter does too; in the corner it answers on its own.
 */
const AnswerButton = ({
  answer,
  children,
  modal,
  ref,
}: {
  answer: () => void;
  children: string;
  modal: boolean;
  ref: RefCallback<HTMLElement> | undefined;
}) =>
  modal ? (
    <Button ref={ref} type="submit" variant="accent">
      {children}
    </Button>
  ) : (
    <Button onClick={answer} size="sm" variant="accent">
      {children}
    </Button>
  );

/**
 * The provider at `index`. The engine sends every step its provider and every
 * account its provider's index, so a missing one is the engine's bug.
 */
const providerAt = (
  request: IdentityRequest,
  index: number,
): WebViewIdentityProvider => {
  const provider = request.providers[index];
  if (provider === undefined) {
    throw new Error(
      `"Sign in with" ${request.step} step has no provider ${index}`,
    );
  } else {
    return provider;
  }
};

/** "Sign in to medium.com with google.com", by what the site signs in for. */
const titleFor = (request: IdentityRequest): string => {
  const verb = PURPOSE_VERBS[request.purpose];
  const provider = request.providers[0];
  return request.providers.length === 1 && provider !== undefined
    ? `${verb} ${request.site} with ${provider.name}`
    : `${verb} ${request.site}`;
};

const PURPOSE_VERBS: Record<WebViewIdentityPurpose, string> = {
  continue: "Continue to",
  "sign-in": "Sign in to",
  "sign-up": "Sign up to",
  use: "Use",
};

/** The name to greet an account by: its first word. */
const firstNameOf = (name: string): string => name.split(/\s+/u)[0] ?? name;

/** The title, after the provider's icon. */
const StepTitle = ({
  icon,
  title,
}: {
  icon: WebViewIdentityProvider | undefined;
  title: string;
}) => (
  <>
    {icon !== undefined && (
      // The title names the provider; its icon only shows it.
      <span aria-hidden className={iconStyles}>
        <Avatar
          name={icon.name}
          size="xs"
          src={icon.icon === "" ? undefined : icon.icon}
        />
      </span>
    )}
    {title}
  </>
);

/** An account's picture, name and email. */
const AccountLabel = ({ account }: { account: WebViewIdentityAccount }) => (
  <span className={accountStyles}>
    <span aria-hidden className={iconStyles}>
      <Avatar
        name={account.name}
        size="sm"
        src={account.picture === "" ? undefined : account.picture}
      />
    </span>
    <span className={whoStyles}>
      <span className={nameStyles}>{account.name}</span>{" "}
      <span className={identifierStyles}>{account.identifier}</span>
    </span>
  </span>
);

/**
 * What signing in with `account` shares with the site, and the site's
 * privacy policy and terms of service as its provider lists them.
 */
const Disclosure = ({
  account,
  onOpenLink,
  provider,
  site,
}: {
  account: WebViewIdentityAccount;
  onOpenLink: (url: string) => void;
  provider: WebViewIdentityProvider;
  site: string;
}) => {
  const links = [
    { label: "privacy policy", url: provider.privacyPolicy },
    { label: "terms of service", url: provider.termsOfService },
  ].filter(({ url }) => url !== "");
  return (
    <>
      {`To continue, ${provider.name} will share your ${listOf(account.shared.map((field) => FIELD_NAMES[field]))} with this site.`}
      {links.length > 0 && ` See ${site}'s `}
      {links.map(({ label, url }, index) => (
        <span key={label}>
          {index > 0 && " and "}
          <a
            className={linkStyles}
            href={url}
            onClick={(event) => {
              event.preventDefault();
              onOpenLink(url);
            }}
          >
            {label}
          </a>
        </span>
      ))}
      {links.length > 0 && "."}
    </>
  );
};

const FIELD_NAMES: Record<WebViewIdentityField, string> = {
  email: "email address",
  name: "name",
  "phone-number": "phone number",
  picture: "profile picture",
  username: "username",
};

/** "a", "a and b", "a, b and c". */
const listOf = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;

/**
 * A step the site offered unasked, in the page's top corner: the page stays
 * usable and keeps the keyboard.
 */
const CornerCard = ({
  children,
  footer,
  hasFooter,
  message,
  note,
  onClose,
  title,
}: {
  children?: ReactNode;
  footer: ReactNode;
  hasFooter: boolean;
  message?: string | undefined;
  note?: ReactNode;
  /** ✕, as Cancel. None where the step has no Cancel. */
  onClose: (() => void) | undefined;
  title: ReactNode;
}) => {
  const titleId = useId();
  const messageId = useId();
  return (
    <section
      aria-describedby={message === undefined ? undefined : messageId}
      aria-labelledby={titleId}
      className={cornerStyles}
      role="dialog"
    >
      <div className={cornerCardStyles}>
        <header className={cornerHeadStyles}>
          <h2 className={cornerTitleStyles} id={titleId}>
            {title}
          </h2>
          {onClose !== undefined && (
            <IconButton label="Close" onClick={onClose} size="sm">
              <XIcon />
            </IconButton>
          )}
        </header>
        {message !== undefined && (
          <p className={cornerMessageStyles} id={messageId}>
            {message}
          </p>
        )}
        {children}
        {note !== undefined && <p className={cornerNoteStyles}>{note}</p>}
        {hasFooter && <footer className={cornerFooterStyles}>{footer}</footer>}
      </div>
    </section>
  );
};

const iconStyles = flex({ flexShrink: 0 });

const waitingStyles = hstack({
  color: "muted",
  fontSize: "sm",
  gap: 2,
});

const verifyingStyles = hstack({
  gap: 3,
  justifyContent: "space-between",
});

const accountsStyles = vstack({
  alignItems: "stretch",
  gap: 0.5,
  listStyle: "none",
  margin: 0,
  maxBlockSize: 60,
  overflowY: "auto",
  padding: 0,
});

const accountButtonStyles = css({
  _focusVisible: {
    outline: "2px solid {colors.accent}",
    outlineOffset: "-2px",
  },
  _hover: {
    backgroundColor: "color-mix(in oklab, {colors.accent} 12%, {colors.card})",
  },
  backgroundColor: "transparent",
  border: "none",
  borderRadius: "md",
  color: "foreground",
  cursor: "pointer",
  display: "flex",
  inlineSize: "100%",
  padding: 2,
  textAlign: "start",
});

const onlyAccountStyles = flex({ paddingInline: 2 });

const accountStyles = hstack({ gap: 2.5, minInlineSize: 0 });

const whoStyles = vstack({
  alignItems: "flex-start",
  gap: 0,
  minInlineSize: 0,
});

const nameStyles = css({
  color: "foreground",
  fontSize: "sm",
  fontWeight: "medium",
});

const identifierStyles = css({
  color: "muted",
  fontSize: "xs",
  maxInlineSize: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const linkStyles = css({
  _hover: { textDecoration: "underline" },
  color: "accent",
  textDecoration: "none",
});

// The top corner, clear of the page's own header, as Chrome places it.
const cornerStyles = flex({
  insetBlockStart: 2,
  insetInline: 2,
  justifyContent: "flex-end",
  pointerEvents: "none",
  position: "absolute",
});

// `PageModal`'s popup, smaller.
const cornerCardStyles = vstack({
  _starting: {
    opacity: 0,
    transform: "translateY({spacing.3}) scale(0.96)",
  },
  alignItems: "stretch",
  backgroundColor: "card",
  border: "1px solid {colors.border}",
  borderRadius: "lg",
  boxShadow: "modal",
  gap: 3,
  inlineSize: "min({spacing.84}, 100%)",
  opacity: 1,
  padding: 3.5,
  pointerEvents: "auto",
  transform: "translateY(0) scale(1)",
  transition:
    "opacity {durations.normal} {easings.out}, transform {durations.normal} {easings.out}",
});

const cornerHeadStyles = flex({ alignItems: "flex-start", gap: 2 });

const cornerTitleStyles = css({
  alignItems: "center",
  color: "foreground",
  display: "flex",
  flex: 1,
  fontSize: "sm",
  fontWeight: "semibold",
  gap: 2.5,
  lineHeight: "snug",
  margin: 0,
  overflowWrap: "anywhere",
});

const cornerMessageStyles = css({
  color: "foreground",
  fontSize: "sm",
  margin: 0,
});

const cornerNoteStyles = css({
  color: "muted",
  fontSize: "xs",
  margin: 0,
});

const cornerFooterStyles = flex({
  gap: 2,
  justifyContent: "flex-end",
  wrap: "wrap",
});

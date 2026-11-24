import type { ReactNode } from "react";

import { css } from "../../styled-system/css";
import { flex } from "../../styled-system/patterns";
import { COMMUNITY, CommunityIcon } from "./community";

type Props = {
  /** What the footer says beside its links. */
  children: ReactNode;
  links: readonly { label: string; href: string }[];
};

/** Every page's policies, which Google's sign-in review looks for. */
const POLICIES = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
];

/** A landing page's foot. */
export const SiteFooter = ({ children, links }: Props) => (
  <footer className={footerStyles}>
    <div className={innerStyles}>
      {children}
      <div className={linksStyles}>
        {COMMUNITY.map((link) => (
          <a className={communityStyles} href={link.href} key={link.href}>
            <CommunityIcon icon={link.icon} />
            {link.label}
          </a>
        ))}
        {[...links, ...POLICIES].map((link) => (
          <a className={linkStyles} href={link.href} key={link.label}>
            {link.label}
          </a>
        ))}
      </div>
    </div>
  </footer>
);

const footerStyles = css({ borderBlockStart: "1px solid {colors.border}" });

const innerStyles = flex({
  color: "muted",
  fontSize: "sm",
  gap: 6,
  justify: "space-between",
  marginInline: "auto",
  maxInlineSize: "6xl",
  paddingBlockEnd: 14,
  paddingBlockStart: 10,
  paddingInline: 6,
  wrap: "wrap",
});

const linksStyles = flex({ align: "center", gap: 5, wrap: "wrap" });

const linkStyles = css({ _hover: { color: "foreground" }, color: "muted" });

const communityStyles = flex({
  _hover: { color: "foreground" },
  align: "center",
  color: "muted",
  gap: 1.5,
});

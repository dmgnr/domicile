import { LegalPage } from "../../legal/LegalPage";
import { shared } from "../../page/shared";

export const metadata = shared({
  description:
    "What Domicile and manganese do with your data, including Gmail: it stays on your computer.",
  path: "/privacy",
  title: "Domicile privacy policy",
});

/** domicile-desktop.com/privacy. */
const PrivacyPage = () => (
  <LegalPage source="packages/site/src/legal/PRIVACY.md" />
);

export default PrivacyPage;

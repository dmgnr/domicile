import { LegalPage } from "../../legal/LegalPage";
import { shared } from "../../page/shared";

export const metadata = shared({
  description:
    "Domicile and manganese are free, open-source software under the MIT license, provided as is.",
  path: "/terms",
  title: "Domicile terms of service",
});

/** domicile-desktop.com/terms. */
const TermsPage = () => <LegalPage source="packages/site/src/legal/TERMS.md" />;

export default TermsPage;

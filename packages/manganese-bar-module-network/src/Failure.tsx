import { PanelNote } from "@domicile-desktop/component-library/PanelNote";
import type { SystemError } from "@domicile-desktop/sdk/system";
import type { ReactNode } from "react";

/** What failed, in plain words, with the service's in its tooltip. */
export const Failure = ({
  children,
  error,
}: {
  children: ReactNode;
  error: SystemError | undefined;
}) =>
  error !== undefined && (
    <PanelNote detail={error.message} tone="warning">
      {children}
    </PanelNote>
  );

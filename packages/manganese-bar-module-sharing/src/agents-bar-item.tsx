import { useDomicile } from "@domicile-desktop/react/domicile-provider";
import { Agents as Pills } from "./Agents";

/**
 * Shown while an agent is in control: one pill for every session, with what
 * each reaches and did last, and buttons to change what it reaches and stop it.
 */
export const Agents = () => {
  const domicile = useDomicile();
  return <Pills domicile={domicile} />;
};

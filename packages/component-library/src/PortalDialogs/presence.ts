/**
 * Whether a portal dialog is up, as base-ui's dialog root takes it. Once it
 * is not, the dialog animates out, then calls `onOpenChangeComplete(false)`.
 */
export type Presence = {
  open: boolean;
  onOpenChangeComplete: (open: boolean) => void;
};

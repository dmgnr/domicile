import { useEffect, useState } from "react";

import { Layer, layerStyles } from "./layer";
import { sourceSet } from "./photos";

/** Wait before the first retry of a photograph that failed to load. */
const FIRST_RETRY_MS = 1000;

/**
 * Longest wait between retries. The network can be down, or up with no route
 * to the internet, for any length of time, so retries never stop.
 */
const MAX_RETRY_MS = 60_000;

type Props = {
  layer: Layer;
  /** Called on each failed attempt. */
  onError: () => void;
  /** How wide it shows, as an `<img sizes>`, to pick a file from `src`'s. */
  sizes: string;
  src: string;
};

/**
 * A photograph in the rotation in role `layer`. It stays transparent until it
 * loads, and retries with a doubling wait while it fails. A Commons
 * photograph comes at the smallest width that covers `sizes`.
 */
export const Photo = ({ layer, onError, sizes, src }: Props) => {
  // Failed attempts so far. Keys the `<img>`, so each retry is a new element
  // and a new request.
  const [failures, setFailures] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!failed) {
      return;
    }
    const timer = setTimeout(() => {
      setFailures((previous) => previous + 1);
      setFailed(false);
    }, retryDelay(failures));
    return () => {
      clearTimeout(timer);
    };
  }, [failed, failures]);

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: load and error are the image's network events, not user interactions
    <img
      alt=""
      className={layerStyles}
      data-wallpaper={loaded ? layer : Layer.Waiting}
      key={failures}
      onError={() => {
        setFailed(true);
        onError();
      }}
      onLoad={() => {
        setLoaded(true);
      }}
      sizes={sizes}
      src={src}
      srcSet={sourceSet(src)}
    />
  );
};

/** The wait before retrying after `failures` earlier failed retries. */
const retryDelay = (failures: number): number =>
  Math.min(FIRST_RETRY_MS * 2 ** failures, MAX_RETRY_MS);

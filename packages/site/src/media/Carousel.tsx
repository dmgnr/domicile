"use client";

import { IconButton } from "@domicile-desktop/component-library/IconButton";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/ssr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/ssr/CaretRight";
import type { ReactNode } from "react";
import { useRef, useState } from "react";

import { css, cva } from "../../styled-system/css";

/** One picture in a carousel, and what it shows. */
export type Slide = { key: string; caption: string; media: ReactNode };

/**
 * Pictures one at a time, swiped or stepped through, with the shown one's
 * caption under them.
 */
export const Carousel = ({ slides }: { slides: readonly Slide[] }) => {
  const track = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const show = (index: number) => {
    const element = track.current;
    if (element === null) {
      throw new Error("a carousel's buttons work only once it is mounted");
    }
    element.scrollTo({ behavior: "smooth", left: index * element.clientWidth });
  };
  return (
    <div
      aria-roledescription="carousel"
      className={carouselStyles}
      role="group"
    >
      <div
        className={trackStyles}
        onScroll={(event) => {
          const { scrollLeft, clientWidth } = event.currentTarget;
          setAt(Math.round(scrollLeft / clientWidth));
        }}
        ref={track}
      >
        {slides.map((slide, index) => (
          <div
            aria-label={`${index + 1} of ${slides.length}`}
            aria-roledescription="slide"
            className={slideStyles}
            key={slide.key}
            role="group"
          >
            {slide.media}
          </div>
        ))}
      </div>
      <div className={controlsStyles}>
        <IconButton
          disabled={at === 0}
          label="Previous"
          onClick={() => {
            show(at - 1);
          }}
        >
          <CaretLeftIcon />
        </IconButton>
        <span aria-live="polite" className={captionStyles}>
          {slides[at]?.caption}
        </span>
        <span className={dotsStyles}>
          {slides.map((slide, index) => (
            <button
              aria-current={index === at ? "true" : undefined}
              aria-label={`Show ${index + 1} of ${slides.length}`}
              className={dotStyles({ current: index === at })}
              key={slide.key}
              onClick={() => {
                show(index);
              }}
              type="button"
            />
          ))}
        </span>
        <IconButton
          disabled={at === slides.length - 1}
          label="Next"
          onClick={() => {
            show(at + 1);
          }}
        >
          <CaretRightIcon />
        </IconButton>
      </div>
    </div>
  );
};

const carouselStyles = css({
  display: "flex",
  flexDirection: "column",
  gap: 2,
  marginBlock: 2,
});

const trackStyles = css({
  "&::-webkit-scrollbar": { display: "none" },
  display: "flex",
  overflowX: "auto",
  scrollbarWidth: "none",
  scrollSnapType: "x mandatory",
});

const slideStyles = css({
  flex: "0 0 100%",
  minWidth: 0,
  scrollSnapAlign: "start",
});

const controlsStyles = css({
  alignItems: "center",
  color: "muted",
  display: "flex",
  gap: 2,
});

const captionStyles = css({ flex: 1, fontSize: "sm", minWidth: 0 });

const dotsStyles = css({ display: "flex", gap: 1.5 });

const dotStyles = cva({
  base: {
    _focusVisible: { outline: "2px solid", outlineColor: "accent" },
    borderRadius: "full",
    cursor: "pointer",
    height: 2,
    transition: "background-color {durations.fast} {easings.out}",
    width: 2,
  },
  variants: {
    current: {
      false: {
        _hover: { backgroundColor: "muted" },
        backgroundColor: "borderStrong",
      },
      true: { backgroundColor: "accent" },
    },
  },
});

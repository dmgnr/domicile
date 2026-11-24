import type { ReactElement, ReactNode } from "react";

import { Button } from "../Button/Button";
import type { Size } from "../control-sizes";

import type { AnyComponent } from "./AnyComponent";

export const ADORNMENT_CONFIGS = [
  "plain",
  "prefix",
  "suffix-icon",
  "prefix-with-suffix-icon",
  "suffix-buttons",
  "clearable",
  "clearable-with-suffix-icon",
  "clearable-with-suffix-buttons",
  "both",
] as const;
export type AdornmentConfig = (typeof ADORNMENT_CONFIGS)[number];

export const adornmentLabel = (config: AdornmentConfig): string => {
  switch (config) {
    case "plain": {
      return "Plain";
    }
    case "prefix": {
      return "Prefix Icon";
    }
    case "suffix-icon": {
      return "Suffix Icon";
    }
    case "suffix-buttons": {
      return "Suffix Buttons";
    }
    case "clearable": {
      return "Clearable";
    }
    case "clearable-with-suffix-icon": {
      return "Clearable + Suffix Icon";
    }
    case "clearable-with-suffix-buttons": {
      return "Clearable + Suffix Buttons";
    }
    case "prefix-with-suffix-icon": {
      return "Prefix Icon + Suffix Icon";
    }
    case "both": {
      return "Prefix Icon + Suffix Buttons";
    }
  }
};

type Options = {
  Component: AnyComponent;
  prefixIcon: ReactNode;
  suffixIcon: ReactNode;
  suffixButtonIcons: { primary: ReactElement; secondary: ReactElement };
  primaryButtonLabel: string;
};

/**
 * Builds a `renderVariation(size, config, props)` function for the Input and
 * Textarea variation stories.
 */
export const createRenderVariation = <
  P extends { rounded?: boolean | undefined },
>(
  options: Options,
) => {
  const {
    Component,
    prefixIcon,
    suffixIcon,
    suffixButtonIcons,
    primaryButtonLabel,
  } = options;

  const exampleSuffixButtons = (size: Size, rounded: boolean): ReactNode => (
    <>
      <Button
        label={primaryButtonLabel}
        rounded={rounded}
        size={innerButtonSize(size)}
        variant="outline"
      >
        {suffixButtonIcons.primary}
      </Button>
      <Button
        label="Submit"
        rounded={rounded}
        size={innerButtonSize(size)}
        variant="solid"
      >
        {suffixButtonIcons.secondary}
      </Button>
    </>
  );

  return (size: Size, config: AdornmentConfig, props: P) => {
    switch (config) {
      case "plain": {
        return <Component {...props} size={size} />;
      }
      case "prefix": {
        return <Component {...props} prefixIcon={prefixIcon} size={size} />;
      }
      case "suffix-icon": {
        return <Component {...props} size={size} suffixIcon={suffixIcon} />;
      }
      case "suffix-buttons": {
        return (
          <Component
            {...props}
            size={size}
            suffixButtons={exampleSuffixButtons(size, props.rounded === true)}
          />
        );
      }
      case "clearable": {
        return (
          <Component {...props} clearable defaultValue="Clear me" size={size} />
        );
      }
      case "clearable-with-suffix-icon": {
        return (
          <Component
            {...props}
            clearable
            defaultValue="Clear me"
            size={size}
            suffixIcon={suffixIcon}
          />
        );
      }
      case "clearable-with-suffix-buttons": {
        return (
          <Component
            {...props}
            clearable
            defaultValue="Clear me"
            size={size}
            suffixButtons={exampleSuffixButtons(size, props.rounded === true)}
          />
        );
      }
      case "prefix-with-suffix-icon": {
        return (
          <Component
            {...props}
            prefixIcon={prefixIcon}
            size={size}
            suffixIcon={suffixIcon}
          />
        );
      }
      case "both": {
        return (
          <Component
            {...props}
            prefixIcon={prefixIcon}
            size={size}
            suffixButtons={exampleSuffixButtons(size, props.rounded === true)}
          />
        );
      }
    }
  };
};

/** A Button size one step smaller than the control, for suffix buttons. */
const innerButtonSize = (size: Size): Size => {
  switch (size) {
    case "xs":
    case "sm": {
      return "xs";
    }
    case "md": {
      return "sm";
    }
    case "lg": {
      return "md";
    }
    case "xl": {
      return "lg";
    }
    case "2xl": {
      return "xl";
    }
    case "3xl": {
      return "2xl";
    }
    case "4xl": {
      return "3xl";
    }
  }
};

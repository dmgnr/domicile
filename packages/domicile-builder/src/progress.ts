// The builder's progress output: one JSON line per step on stdout, which
// `domicile` shows as a progress bar.

/** The kind of step a line reports. */
export enum StepKind {
  Resolving,
  Installing,
  Bundling,
  Built,
  Evaluated,
  Serving,
  Failed,
}

export const Step = {
  /** The entry is built; the engine serves `module` from `root`. */
  Built: (root: string, module: string, cached: boolean) => ({
    cached,
    kind: StepKind.Built as const,
    module,
    root,
  }),
  /** Bundling the entry against Domicile's packages. */
  Bundling: () => ({ kind: StepKind.Bundling as const }),
  /** The config is evaluated; its sections are JSON at `config`. */
  Evaluated: (config: string, cached: boolean) => ({
    cached,
    config,
    kind: StepKind.Evaluated as const,
  }),
  /** The build failed, with the reason. */
  Failed: (why: string) => ({ kind: StepKind.Failed as const, why }),
  /** Installing the packages the entry imports that the project lacks. */
  Installing: (packages: readonly string[]) => ({
    kind: StepKind.Installing as const,
    packages,
  }),
  /** Reading what the entry imports. */
  Resolving: () => ({ kind: StepKind.Resolving as const }),
  /**
   * The entry is served with hot module replacement; the engine serves
   * `module` from the dev server listening on `socket`.
   */
  Serving: (socket: string, module: string) => ({
    kind: StepKind.Serving as const,
    module,
    socket,
  }),
};

export type Step = ReturnType<(typeof Step)[keyof typeof Step]>;

/**
 * Serialize `step` as the line `domicile` reads, like `{"step":"built",...}`.
 * This is the only place that defines the wire format.
 */
export const line = (step: Step): string => {
  switch (step.kind) {
    case StepKind.Resolving: {
      return JSON.stringify({ step: "resolving" });
    }
    case StepKind.Installing: {
      return JSON.stringify({ packages: step.packages, step: "installing" });
    }
    case StepKind.Bundling: {
      return JSON.stringify({ step: "bundling" });
    }
    case StepKind.Built: {
      return JSON.stringify({
        cached: step.cached,
        module: step.module,
        root: step.root,
        step: "built",
      });
    }
    case StepKind.Evaluated: {
      return JSON.stringify({
        cached: step.cached,
        config: step.config,
        step: "evaluated",
      });
    }
    case StepKind.Serving: {
      return JSON.stringify({
        module: step.module,
        socket: step.socket,
        step: "serving",
      });
    }
    case StepKind.Failed: {
      return JSON.stringify({ step: "failed", why: step.why });
    }
  }
};

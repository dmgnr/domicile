import { z } from "zod";

/**
 * What the host reads beside each sample when the VM draws on its GPU:
 * QEMU's CPU ticks and its share of the card.
 */
const hostSampleSchema = z.object({
  gpuMib: z.number(),
  gpuPercent: z.number(),
  qemuTicks: z.number(),
  seconds: z.number(),
});

/** One reading the VM takes every few seconds of the measured window. */
const sampleSchema = z.object({
  busyTicks: z.number(),
  host: hostSampleSchema.optional(),
  load1: z.number(),
  // Every process's memory: never none.
  pssKib: z.number().positive(),
  sessionPssKib: z.number(),
  /** Time the host gave its other work; not in `busyTicks`. */
  stealTicks: z.number().optional(),
  totalTicks: z.number(),
  usedKib: z.number(),
});

/** What one boot of one desktop under one workload measured. */
const runSchema = z.object({
  cores: z.number().int().positive(),
  desktop: z.string(),
  hostTicksPerSecond: z.number().positive().optional(),
  run: z.number().int(),
  samples: z.array(sampleSchema).min(2),
  /** The busiest threads over the window, as % of one core. */
  threads: z
    .array(z.object({ cpuPercent: z.number(), name: z.string() }))
    .optional(),
  top: z.array(z.object({ name: z.string(), pssKib: z.number() })),
  workload: z.string(),
});

export type Run = z.infer<typeof runSchema>;

/** The median of a measure across runs, and its lowest and highest run. */
type Spread = { max: number; median: number; min: number };

/** A desktop under a workload, across its runs. */
export type Row = {
  cpuPercent: Spread;
  desktop: string;
  /** Read on the host, for runs on its GPU. */
  host?: { gpuMib: Spread; gpuPercent: Spread; qemuCpuPercent: Spread };
  load1: Spread;
  runs: number;
  sessionPssMib: Spread;
  /** CPU the host took for its other work, for runs that read it. */
  stealPercent?: Spread;
  usedMib: Spread;
  workload: string;
};

/** Parses a run's JSON as the VM wrote it. */
export const parseRun = (json: string): Run =>
  runSchema.parse(JSON.parse(json));

/** The value at `index`, which the caller knows is in range. */
const at = (values: readonly number[], index: number): number => {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`no value at ${String(index)} of ${String(values.length)}`);
  }
  return value;
};

/** The middle value, or the mean of the middle two. */
const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (at(sorted, middle - 1) + at(sorted, middle)) / 2
    : at(sorted, middle);
};

/** The median and range of a measure across runs. */
const spread = (values: readonly number[]): Spread => ({
  max: Math.max(...values),
  median: median(values),
  min: Math.min(...values),
});

/** KiB as whole MiB. */
const mib = (kib: number): number => Math.round(kib / 1024);

/** Cores kept busy over the window, as a percentage of one core. */
const cpuPercent = (run: Run): number => {
  const first = run.samples[0];
  const last = run.samples.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error(`${run.desktop}/${run.workload} has no samples`);
  }
  const busy =
    (last.busyTicks - first.busyTicks) / (last.totalTicks - first.totalTicks);
  return Math.round(busy * run.cores * 100);
};

/** CPU the host took for its other work, as a percentage of one core. */
const stealPercent = (run: Run): number | undefined => {
  const first = run.samples[0];
  const last = run.samples.at(-1);
  if (first?.stealTicks === undefined || last?.stealTicks === undefined) {
    return undefined;
  }
  const stolen =
    (last.stealTicks - first.stealTicks) / (last.totalTicks - first.totalTicks);
  return Math.round(stolen * run.cores * 100);
};

/** The host's readings, which a run has on every sample or on none. */
const hostSamples = (run: Run) => {
  const host = run.samples.flatMap((sample) =>
    sample.host === undefined ? [] : [sample.host],
  );
  if (host.length === 0) {
    return undefined;
  }
  if (host.length !== run.samples.length) {
    throw new Error(
      `${run.desktop}/${run.workload} has host readings on some samples only`,
    );
  }
  return host;
};

/** QEMU's CPU, its GPU share and its GPU memory over the window. */
const hostMeasures = (run: Run) => {
  const host = hostSamples(run);
  if (host === undefined) {
    return undefined;
  }
  if (run.hostTicksPerSecond === undefined) {
    throw new Error(
      `${run.desktop}/${run.workload} has host readings but no tick rate`,
    );
  }
  const first = at(
    host.map((h) => h.qemuTicks),
    0,
  );
  const last = at(
    host.map((h) => h.qemuTicks),
    host.length - 1,
  );
  const seconds =
    at(
      host.map((h) => h.seconds),
      host.length - 1,
    ) -
    at(
      host.map((h) => h.seconds),
      0,
    );
  return {
    gpuMib: median(host.map((h) => h.gpuMib)),
    gpuPercent: median(host.map((h) => h.gpuPercent)),
    qemuCpuPercent: Math.round(
      ((last - first) / run.hostTicksPerSecond / seconds) * 100,
    ),
  };
};

/** The host's measures across a group's runs: on every run, or on none. */
const hostSpread = (
  measured: readonly ReturnType<typeof hostMeasures>[],
  name: string,
): Row["host"] => {
  const present = measured.flatMap((m) => (m === undefined ? [] : [m]));
  if (present.length === 0) {
    return undefined;
  }
  if (present.length !== measured.length) {
    throw new Error(`${name} mixes runs with and without host readings`);
  }
  return {
    gpuMib: spread(present.map((m) => m.gpuMib)),
    gpuPercent: spread(present.map((m) => m.gpuPercent)),
    qemuCpuPercent: spread(present.map((m) => m.qemuCpuPercent)),
  };
};

/** One run's measures: medians over its window, and its CPU. */
const perRun = (run: Run) => ({
  cpuPercent: cpuPercent(run),
  host: hostMeasures(run),
  load1: median(run.samples.map((sample) => sample.load1)),
  sessionPssMib: mib(median(run.samples.map((s) => s.sessionPssKib))),
  stealPercent: stealPercent(run),
  usedMib: mib(median(run.samples.map((sample) => sample.usedKib))),
});

/** Steal across a group's runs, when every run read it. */
const stealSpread = (
  stolen: readonly (number | undefined)[],
): Pick<Row, "stealPercent"> => {
  const read = stolen.flatMap((s) => (s === undefined ? [] : [s]));
  return read.length === stolen.length && read.length > 0
    ? { stealPercent: spread(read) }
    : {};
};

/** Groups runs by desktop and workload, in the order each first appears. */
export const summarize = (runs: readonly Run[]): Row[] =>
  Map.groupBy(runs, (run) => `${run.desktop}\0${run.workload}`)
    .values()
    .map((group) => {
      const measured = group.map(perRun);
      const [first] = group;
      if (first === undefined) {
        throw new Error("a group with no runs");
      }
      const host = hostSpread(
        measured.map((m) => m.host),
        `${first.desktop}/${first.workload}`,
      );
      return {
        cpuPercent: spread(measured.map((m) => m.cpuPercent)),
        desktop: first.desktop,
        ...(host === undefined ? {} : { host }),
        load1: spread(measured.map((m) => m.load1)),
        runs: measured.length,
        sessionPssMib: spread(measured.map((m) => m.sessionPssMib)),
        ...stealSpread(measured.map((m) => m.stealPercent)),
        usedMib: spread(measured.map((m) => m.usedMib)),
        workload: first.workload,
      };
    })
    .toArray();

/** One measure as a table: a row per desktop, a column per workload. */
const table = (
  rows: readonly Row[],
  title: string,
  cell: (row: Row) => string,
): string => {
  const desktops = [...new Set(rows.map((row) => row.desktop))];
  const workloads = [...new Set(rows.map((row) => row.workload))];
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [
    `### ${title}`,
    "",
    line(["Desktop", ...workloads]),
    line(["---", ...workloads.map(() => "---")]),
    ...desktops.map((desktop) =>
      line([
        desktop,
        ...workloads.map((workload) => {
          const row = rows.find(
            (r) => r.desktop === desktop && r.workload === workload,
          );
          return row === undefined ? "–" : cell(row);
        }),
      ]),
    ),
  ].join("\n");
};

/** The median run, then its range. */
const ranged = (value: Spread, unit: string): string =>
  `${String(value.median)}${unit} (${String(value.min)}–${String(value.max)})`;

/** A row's host measure, for a table of them. */
const hostCell =
  (measure: keyof NonNullable<Row["host"]>, unit: string) =>
  (row: Row): string =>
    row.host === undefined ? "–" : ranged(row.host[measure], unit);

/** The summary as markdown tables: the median run, then its range. */
export const markdown = (rows: readonly Row[]): string =>
  [
    table(rows, "Memory in use (whole VM)", (row) =>
      ranged(row.usedMib, " MiB"),
    ),
    table(rows, "Session processes (PSS)", (row) =>
      ranged(row.sessionPssMib, " MiB"),
    ),
    table(rows, "CPU (% of one core)", (row) => ranged(row.cpuPercent, "%")),
    table(rows, "Load average (1 min)", (row) => ranged(row.load1, "")),
    ...(rows.some((row) => row.stealPercent !== undefined)
      ? [
          table(
            rows,
            "CPU the host took for its other work (steal, % of one core)",
            (row) =>
              row.stealPercent === undefined
                ? "–"
                : ranged(row.stealPercent, "%"),
          ),
        ]
      : []),
    ...(rows.some((row) => row.host !== undefined)
      ? [
          table(
            rows,
            "GPU (% busy, read on the host)",
            hostCell("gpuPercent", "%"),
          ),
          table(
            rows,
            "GPU memory (read on the host)",
            hostCell("gpuMib", " MiB"),
          ),
          table(
            rows,
            "QEMU's CPU on the host (% of one core)",
            hostCell("qemuCpuPercent", "%"),
          ),
        ]
      : []),
  ].join("\n\n");

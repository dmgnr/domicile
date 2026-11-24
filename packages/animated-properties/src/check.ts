import { readFileSync } from "node:fs";

import { EXEMPTION, mainThreadAnimations } from "./main-thread-animations";

/**
 * Prints every main-thread animation in the repository's tracked TypeScript,
 * tests aside, and exits nonzero if there is one.
 */
const files = Bun.spawnSync(["git", "ls-files", "*.ts", "*.tsx"], {
  stderr: "inherit",
})
  .stdout.toString()
  .split("\n")
  .filter((file) => file !== "" && !/\.test\.tsx?$/.test(file));

const findings = files.flatMap((file) =>
  mainThreadAnimations(readFileSync(file, "utf8"), file).map(
    ({ line, property }) => `${file}:${String(line)}: animates ${property}`,
  ),
);

if (findings.length > 0) {
  // biome-ignore lint/suspicious/noConsole: the check's verdict
  console.error(
    [
      ...findings,
      "",
      "These run on the main thread every frame. Animate transform, translate, scale, rotate, opacity or filter instead,",
      `or say why it must be this property in a "// ${EXEMPTION} <reason>" comment above it.`,
    ].join("\n"),
  );
  process.exit(1);
} else {
  // biome-ignore lint/suspicious/noConsole: the check's verdict
  console.log(
    `PASS: ${String(files.length)} modules animate only compositor properties and colors, or say why not`,
  );
}

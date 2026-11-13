/** Tiny helpers that keep each script's entry point to one line. */

/** The value after `--flag`, or the fallback. */
export function argValue(argv: readonly string[], flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  return i > -1 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
}

export const hasFlag = (argv: readonly string[], flag: string) => argv.includes(flag);

/** True when the module at `moduleUrl` is the script node was asked to run. */
export const isMain = (moduleUrl: string, argv: readonly string[] = process.argv) => moduleUrl === `file://${argv[1]}`;

/** Counts occurrences of each key; a key function may return several keys per item. */
export function countBy<T>(items: readonly T[], key: (item: T) => string | readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    for (const k of [key(item)].flat()) counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

// Fork-only: the node_exporter list as the settings text shows it, one "name url" per line.
import type { ForkNodeExporter } from "@t3tools/contracts";

export function formatNodeExporters(exporters: ReadonlyArray<ForkNodeExporter>): string {
  return exporters.map((exporter) => `${exporter.name} ${exporter.url}`).join("\n");
}

/** Lines that are not a name followed by a URL come back as `invalid`, so nothing is dropped silently. */
export function parseNodeExporters(text: string): {
  readonly exporters: ReadonlyArray<ForkNodeExporter>;
  readonly invalid: ReadonlyArray<string>;
} {
  const exporters: ForkNodeExporter[] = [];
  const invalid: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = /^(\S+)\s+(\S+)$/.exec(trimmed);
    if (match === null) invalid.push(trimmed);
    else exporters.push({ name: match[1]!, url: match[2]! });
  }
  return { exporters, invalid };
}

import { describe, expect, it } from "vite-plus/test";

import { formatNodeExporters, parseNodeExporters } from "./forkNodeExportersRow.logic";

describe("parseNodeExporters", () => {
  it("reads a name and a URL per line and keeps lines it cannot read", () => {
    expect(
      parseNodeExporters(
        "prod-cx43 http://100.96.210.49:9100/metrics\n\n  nas   http://nas.tail0.ts.net:9100/metrics \njust-a-name\n",
      ),
    ).toEqual({
      exporters: [
        { name: "prod-cx43", url: "http://100.96.210.49:9100/metrics" },
        { name: "nas", url: "http://nas.tail0.ts.net:9100/metrics" },
      ],
      invalid: ["just-a-name"],
    });
  });

  it("round-trips the saved list", () => {
    const exporters = [{ name: "prod-cx43", url: "http://100.96.210.49:9100/metrics" }];
    expect(parseNodeExporters(formatNodeExporters(exporters)).exporters).toEqual(exporters);
  });
});

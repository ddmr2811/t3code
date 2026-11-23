import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AgentMarkdown } from "./AgentMarkdown.tsx";

const render = (text: string) => renderToStaticMarkup(<AgentMarkdown text={text} />);

describe("AgentMarkdown", () => {
  it("renders hostile agent Markdown inert", () => {
    const html = render(
      [
        "Hola <script>alert(1)</script>",
        "",
        '<img src="x" onerror="alert(1)">',
        "",
        "[x](javascript:alert(1)) [y](JAVASCRIPT:alert(1)) [z](data:text/html,<script>alert(1)</script>)",
        "",
        '<a href="javascript:alert(1)" onclick="alert(1)">w</a>',
        "",
        '<iframe src="https://example.com"></iframe><svg onload="alert(1)"></svg>',
      ].join("\n"),
    );
    expect(html).not.toMatch(/<script|<iframe|<svg|<img/i);
    expect(html).not.toMatch(/\son\w+=/i);
    expect(html).not.toMatch(/javascript:|data:text/i);
    expect(html).toContain("Hola");
  });

  it("opens web links apart from the ADE", () => {
    expect(render("[docs](https://example.com/a)")).toContain(
      '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">docs</a>',
    );
  });
});

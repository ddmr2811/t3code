import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { memo } from "react";
import Markdown, { type Components, defaultUrlTransform } from "react-markdown";

import { MarkdownMedia } from "./Media.tsx";

// A pure splitter shared with the web chat: completed blocks keep their text while a reply streams.
import { splitMarkdownBlocks } from "../../../web/src/components/chat/markdownStreamBlocks.ts";

const OPENS_ELSEWHERE = /^(?:https?:|mailto:)/i;

// The pipeline sanitizes; these only decide what a surviving link or image does here. Links
// that are not web or mail (files, threads, relative paths) mean nothing in the ADE: text only.
// Images and videos named by path come from the machine; any other shows its alt text.
const COMPONENTS: Components = {
  a: ({ href, children }) =>
    href !== undefined && OPENS_ELSEWHERE.test(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span className="ade-md-link">{children}</span>
    ),
  img: ({ src, alt }) => (
    <MarkdownMedia src={typeof src === "string" ? src : undefined} alt={alt ?? ""} />
  ),
};

const MarkdownBlock = memo(function MarkdownBlock(props: { text: string }) {
  return (
    <Markdown
      remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
      components={COMPONENTS}
      urlTransform={defaultUrlTransform}
    >
      {props.text}
    </Markdown>
  );
});

/** The agent's Markdown. Only the last block parses again as streamed text grows. */
export function AgentMarkdown(props: { text: string }) {
  const blocks = splitMarkdownBlocks(props.text) ?? [props.text];
  return (
    <div className="ade-md">
      {blocks.map((block, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Blocks only grow at the end, so a block keeps its index.
        <MarkdownBlock key={index} text={block} />
      ))}
    </div>
  );
}

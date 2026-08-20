import { memo } from "react";
import { cn } from "../../lib/shared/utils";
import { Markdown, type MarkdownProps } from "../Markdown";

export type DocumentMarkdownProps = MarkdownProps;

/**
 * Markdown typography for files, documentation, and long-form previews.
 * Chat messages deliberately keep their denser conversational typography.
 */
export const DocumentMarkdown = memo(function DocumentMarkdown(props: DocumentMarkdownProps) {
  const { className, ...markdownProps } = props;
  return <Markdown {...markdownProps} className={cn("document-markdown", className)} />;
});

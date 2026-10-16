import { useMemo } from 'react';
import { renderMarkdown } from '../lib/markdown';

/** Assistant text, rendered from Markdown and sanitized. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`lm-md ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

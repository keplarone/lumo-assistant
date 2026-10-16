/**
 * Assistant Markdown → sanitized HTML. Model output is untrusted: DOMPurify removes scripts, event
 * handlers, styles and anything that is not plain formatting; links open in the browser, never in
 * the webview, and only http(s) and mailto links are kept.
 */
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const marked = new Marked({ gfm: true, breaks: false, async: false });

let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      if (!/^(https?:|mailto:)/i.test(href)) {
        node.removeAttribute('href');
      } else {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noreferrer noopener');
      }
    }
    if (node.tagName === 'IMG') {
      // Remote images would be blocked by the CSP anyway; drop them so nothing loads silently.
      const src = node.getAttribute('src') ?? '';
      if (!/^data:image\//i.test(src)) node.removeAttribute('src');
    }
  });
}

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'input',
  'span',
];

export function renderMarkdown(src: string): string {
  hook();
  const html = marked.parse(src) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'type', 'checked', 'disabled', 'align', 'start'],
    ALLOW_DATA_ATTR: false,
  });
}

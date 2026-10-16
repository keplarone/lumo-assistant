/** CodeMirror 6 editor themed with Lumo's tokens. Loaded lazily with the project workspace. */
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import {
  bracketMatching,
  defaultHighlightStyle,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

export function languageFor(path: string): Extension {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'html':
    case 'htm':
      return html();
    case 'css':
      return css();
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'ts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'json':
      return json();
    case 'md':
    case 'markdown':
      return markdown();
    default:
      return [];
  }
}

const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--lu-bg-sunken)',
    color: 'var(--lu-text)',
    fontSize: 'var(--lu-text-sm)',
  },
  '.cm-scroller': { fontFamily: 'var(--lu-font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--lu-focus)', padding: 'var(--lu-space-2) 0' },
  '.cm-gutters': { backgroundColor: 'var(--lu-bg-sunken)', color: 'var(--lu-text-tertiary)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--lu-line-subtle)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--lu-text-secondary)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--lu-focus)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--lu-accent-subtle-hover) !important',
  },
  '.cm-matchingBracket': { backgroundColor: 'var(--lu-accent-subtle)', outline: 'none' },
});

/** Syntax colors from the status and accent tokens, so both themes stay in contrast. */
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--lu-accent-text)' },
  { tag: [tags.string, tags.special(tags.string), tags.attributeValue], color: 'var(--lu-success)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--lu-warning)' },
  { tag: [tags.comment, tags.meta], color: 'var(--lu-text-tertiary)', fontStyle: 'italic' },
  { tag: [tags.tagName, tags.typeName, tags.className], color: 'var(--lu-danger-text)' },
  { tag: [tags.attributeName, tags.propertyName], color: 'var(--lu-text-secondary)' },
  { tag: [tags.heading], fontWeight: '600', color: 'var(--lu-text)' },
  { tag: [tags.link, tags.url], color: 'var(--lu-accent-text)', textDecoration: 'underline' },
]);

export interface CodeEditorProps {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  readOnly?: boolean;
}

export default function CodeEditor({ path, value, onChange, onSave, readOnly }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const ro = useRef(new Compartment());
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(highlight),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (cb.current.onSave(), true) },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          theme,
          EditorView.lineWrapping,
          lang.current.of(languageFor(path)),
          ro.current.of(EditorState.readOnly.of(!!readOnly)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ 'aria-label': `Editing ${path}` }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // The editor is created once per file; see the effects below for updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value)
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure(EditorState.readOnly.of(!!readOnly)) });
  }, [readOnly]);

  return <div className="lm-editor" ref={host} />;
}

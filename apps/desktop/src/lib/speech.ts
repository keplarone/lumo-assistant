/**
 * Read-aloud with the webview's speechSynthesis (the operating system's voices; nothing leaves the
 * device). Markdown is reduced to plain sentences first.
 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

type Listener = (speaking: boolean) => void;
const listeners = new Set<Listener>();
let speaking = false;
const set = (v: boolean) => {
  speaking = v;
  listeners.forEach((l) => l(v));
};

export const speech = {
  available: () => typeof window !== 'undefined' && 'speechSynthesis' in window,
  speak(markdown: string) {
    if (!speech.available()) return;
    const text = stripMarkdown(markdown);
    if (!text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.onend = () => set(false);
    u.onerror = () => set(false);
    set(true);
    window.speechSynthesis.speak(u);
  },
  stop() {
    if (speech.available()) window.speechSynthesis.cancel();
    set(false);
  },
  isSpeaking: () => speaking,
  subscribe(l: Listener) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

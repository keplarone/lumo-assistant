/**
 * Read-aloud with the webview's speechSynthesis, using only the operating system's on-device voices
 * (voices marked as online services are skipped, so nothing leaves the computer). Markdown is
 * reduced to plain sentences first. The "lumo" style is the mascot's voice: a light voice, pitched
 * up and a touch quicker, so it sounds small and cute while staying easy to understand.
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

export type VoiceStyle = 'lumo' | 'system';

/** Lighter voices that pitch up well, best first, per platform. Matched by name prefix. */
const LIGHT_VOICES = [
  'Samantha', // macOS
  'Karen',
  'Moira',
  'Tessa',
  'Microsoft Aria', // Windows
  'Microsoft Jenny',
  'Microsoft Zira',
  'Microsoft Hazel',
  'Female', // Linux (speech-dispatcher / eSpeak variants)
];

export interface VoiceChoice {
  voice: SpeechSynthesisVoice | null;
  pitch: number;
  rate: number;
}

/** Pick the voice and its pitch and rate for a style. Pure, so it is unit tested. */
export function chooseVoice(style: VoiceStyle, voices: SpeechSynthesisVoice[], lang = 'en'): VoiceChoice {
  const local = voices.filter((v) => v.localService);
  const sameLang = local.filter((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase().slice(0, 2)));
  const pool = sameLang.length ? sameLang : local;
  if (style === 'system') return { voice: pool.find((v) => v.default) ?? pool[0] ?? null, pitch: 1, rate: 1 };
  const light = LIGHT_VOICES.map((n) => pool.find((v) => v.name.startsWith(n))).find(Boolean);
  return { voice: light ?? pool.find((v) => v.default) ?? pool[0] ?? null, pitch: 1.6, rate: 1.08 };
}

let style: VoiceStyle = 'lumo';

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
    const choice = chooseVoice(style, window.speechSynthesis.getVoices(), navigator.language || 'en');
    // With no on-device voice listed yet (some systems load them late), the engine picks its default.
    if (choice.voice) u.voice = choice.voice;
    u.pitch = choice.pitch;
    u.rate = choice.rate;
    u.onend = () => set(false);
    u.onerror = () => set(false);
    set(true);
    window.speechSynthesis.speak(u);
  },
  /** The voice for replies (from Settings → Voice). */
  setStyle(s: VoiceStyle) {
    style = s;
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

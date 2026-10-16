// Vercel function: POST /api/chat, an OpenAI-style chat request streamed back from OpenRouter (see gateway.js).
import { chat } from '../gateway.js';
import { redisStore } from '../store.js';

export function POST(request) {
  return chat(request, process.env, { store: redisStore(process.env) });
}

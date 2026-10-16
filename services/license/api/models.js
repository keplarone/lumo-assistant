// Vercel function: GET /api/models -> every plan's models, for the app's model picker (see catalog.js).
import { models } from '../gateway.js';

export function GET() {
  return models(process.env);
}

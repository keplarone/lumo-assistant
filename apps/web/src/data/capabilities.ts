/**
 * The single source of truth for what Lumo can do, and how far along each capability is.
 *
 * Honesty rule for the website: a capability may only be described as something Lumo does today when
 * its status here is `available`. Everything else renders with an "In development" or "Planned" badge,
 * and copy around it uses future or conditional phrasing. The release process updates this file; pages
 * read it through `capability()` so a status change updates every mention at once.
 */

export type CapabilityStatus = 'available' | 'in-development' | 'planned';

export type CapabilityId =
  | 'conversations'
  | 'files'
  | 'web-research'
  | 'project-workspace'
  | 'mascot'
  | 'memory'
  | 'automations'
  | 'floating-assistant'
  | 'restaurant-finder'
  | 'shopping-research'
  | 'computer-use'
  | 'voice'
  | 'google'
  | 'github'
  | 'netlify'
  | 'direct-food-ordering'
  | 'custom-agents';

export interface Capability {
  id: CapabilityId;
  name: string;
  status: CapabilityStatus;
  /** One sentence, written so it stays true whatever the status (the badge carries the status). */
  summary: string;
  /** Optional caveat shown next to the capability, e.g. what Lumo does not do. */
  note?: string;
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'conversations',
    name: 'Conversations with Claude models',
    status: 'in-development',
    summary: 'Ask in plain language and get answers, plans and finished work from Claude models.',
  },
  {
    id: 'files',
    name: 'File organization',
    status: 'in-development',
    summary: 'Sort, rename and tidy files, but only inside folders you explicitly grant. Every move is previewed and can be undone.',
  },
  {
    id: 'web-research',
    name: 'Web research',
    status: 'in-development',
    summary: 'Search the web, read pages and come back with a short, sourced answer.',
  },
  {
    id: 'project-workspace',
    name: 'Project workspace',
    status: 'in-development',
    summary: 'Build a website from a request: conversation, files and a live preview side by side, with every change versioned.',
  },
  {
    id: 'mascot',
    name: 'Lumo, the companion',
    status: 'in-development',
    summary: 'A small owl of light that shows what Lumo is doing: listening, thinking, working, celebrating or resting.',
  },
  {
    id: 'memory',
    name: 'Memory controls',
    status: 'in-development',
    summary: 'Lumo can remember preferences you choose to keep. Every memory is visible, editable and deletable, and memory can be turned off.',
  },
  {
    id: 'automations',
    name: 'Automations',
    status: 'in-development',
    summary: 'Recurring tasks that run on a schedule with read-only tools, and ask you before doing anything more.',
  },
  {
    id: 'floating-assistant',
    name: 'Floating assistant and global shortcut',
    status: 'in-development',
    summary: 'A compact window that opens over any app with a keyboard shortcut (Alt+Space or Option+Space, configurable).',
  },
  {
    id: 'restaurant-finder',
    name: 'Restaurant finder',
    status: 'in-development',
    summary: 'Find places that match what you are in the mood for, then hand off to DoorDash, Uber Eats or the restaurant’s own site to order.',
    note: 'You complete checkout with the provider. Lumo does not place orders.',
  },
  {
    id: 'shopping-research',
    name: 'Shopping research',
    status: 'in-development',
    summary: 'Compare products against what matters to you, then open the merchant’s page so you can buy there.',
    note: 'Lumo does not check out or pay for you.',
  },
  {
    id: 'computer-use',
    name: 'Computer use',
    status: 'in-development',
    summary: 'With your permission, see the screen and use mouse and keyboard to finish tasks in other apps, with a visible indicator and a stop shortcut.',
  },
  {
    id: 'voice',
    name: 'Voice',
    status: 'in-development',
    summary: 'Speak a request instead of typing it, using a speech-to-text service you choose.',
  },
  {
    id: 'google',
    name: 'Google Calendar, Gmail and Drive',
    status: 'planned',
    summary: 'Read your schedule, draft email and find documents after you connect your Google account.',
  },
  {
    id: 'github',
    name: 'GitHub',
    status: 'in-development',
    summary: 'Publish a project to a new GitHub repository after you connect your account and confirm.',
  },
  {
    id: 'netlify',
    name: 'Deploy to Netlify',
    status: 'in-development',
    summary: 'Publish a finished website to Netlify after you connect your account and confirm the deploy.',
  },
  {
    id: 'direct-food-ordering',
    name: 'Direct food ordering',
    status: 'planned',
    summary: 'Placing an order inside Lumo through a delivery provider’s official program (DoorDash dd-cli beta, Uber Consumer Delivery early access).',
    note: 'Pending approval from the providers. Until then, Lumo hands off to the provider to complete checkout.',
  },
  {
    id: 'custom-agents',
    name: 'Custom agents',
    status: 'planned',
    summary: 'Save your own specialised assistants, each with its own instructions and the tools you allow it.',
  },
];

export const STATUS_LABEL: Record<CapabilityStatus, string> = {
  available: 'Available',
  'in-development': 'In development',
  planned: 'Planned',
};

export function capability(id: CapabilityId): Capability {
  const c = CAPABILITIES.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown capability: ${id}`);
  return c;
}

export function isAvailable(id: CapabilityId): boolean {
  return capability(id).status === 'available';
}

export const anyAvailable = CAPABILITIES.some((c) => c.status === 'available');

import * as RT from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { Kbd } from './Display';

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <RT.Provider delayDuration={450} skipDelayDuration={250}>
    {children}
  </RT.Provider>
);

export interface TooltipProps {
  content: ReactNode;
  shortcut?: string[];
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: ReactNode;
}

export function Tooltip({ content, shortcut, side = 'bottom', children }: TooltipProps) {
  return (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content className="lu-tooltip" side={side} sideOffset={6} collisionPadding={8}>
          {content}
          {shortcut && <Kbd keys={shortcut} />}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}

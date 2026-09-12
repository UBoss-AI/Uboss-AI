'use client';

import type { MouseEvent, ReactNode } from 'react';
import { useId } from 'react';

import { cn } from '../lib/class-names';
import { useFocusTrap } from '../lib/use-focus-trap';
import { Icon } from './Icon';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Footer actions, right-aligned. */
  footer?: ReactNode;
  /** Wider variant for review and comparison content. */
  wide?: boolean;
  className?: string;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
  className,
}: ModalProps) {
  const titleId = useId();
  const containerRef = useFocusTrap(open, onClose);

  if (!open) {
    return null;
  }

  const handleOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
    // Only a click on the backdrop itself dismisses; clicks inside the panel must not.
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="uboss-overlay" onClick={handleOverlayClick}>
      <div
        ref={containerRef}
        className={cn('uboss-modal', wide && 'uboss-modal--wide', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="uboss-overlay-head">
          <h3 id={titleId}>{title}</h3>
          <button
            type="button"
            className="uboss-overlay-close"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="uboss-overlay-body">{children}</div>
        {footer ? <div className="uboss-overlay-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

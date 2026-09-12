import { cn } from '../lib/class-names';

export interface SkeletonProps {
  /** CSS width, e.g. `'70%'` or `160`. */
  width?: string | number;
  /** CSS height. Defaults to a text line. */
  height?: string | number;
  /** Render as a circle, for avatar placeholders. */
  circle?: boolean;
  className?: string;
}

export function Skeleton({
  width = '100%',
  height = 16,
  circle = false,
  className,
}: SkeletonProps) {
  return (
    <div
      className={cn('uboss-skeleton', className)}
      style={{ width, height, borderRadius: circle ? '50%' : undefined }}
      // The container announces loading; individual bars are decorative.
      aria-hidden="true"
    />
  );
}

export interface SkeletonTextProps {
  /** Number of placeholder lines. */
  lines?: number;
  className?: string;
}

/**
 * A multi-line loading placeholder. Wrap in an element with `aria-busy="true"` and an
 * accessible label so screen-reader users are told the region is loading.
 */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  const widths = ['70%', '90%', '50%', '80%', '60%'];

  return (
    <div
      className={cn(className)}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading"
    >
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} width={widths[index % widths.length] ?? '100%'} height={16} />
      ))}
    </div>
  );
}

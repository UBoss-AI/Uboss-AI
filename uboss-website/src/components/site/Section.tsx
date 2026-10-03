import type { ReactNode } from 'react';

import { Reveal } from './Reveal';

/**
 * The shape every section of this site takes.
 *
 * ## Why the site needs one
 *
 * Before this, each section invented its own heading block — some had an eyebrow, some did not,
 * the gaps between a title and its lead varied by a few pixels in each file, and the widths did
 * not agree. Nothing was wrong enough to point at, which is exactly what makes a site read as a
 * template: the eye notices that nothing lines up long before the reader can say why.
 *
 * One component means the rhythm is a decision made once. A section that needs to look different
 * says so by the props it passes, not by re-implementing the block.
 *
 * ## The kicker is not decoration
 *
 * It answers "where am I" for somebody who arrived mid-page from a nav link or a search result,
 * which is most visitors. It is set in the accent and in caps because it has to be read *before*
 * the title without competing with it.
 */
export function Section({
  id,
  kicker,
  title,
  lead,
  children,
  /** A darker band, for the sections that should feel like a floor under the one above. */
  tone = 'plain',
  /** Centre the heading block. Right for a section whose content is a grid rather than a column. */
  align = 'left',
}: {
  id?: string;
  kicker?: string;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  tone?: 'plain' | 'sunk';
  align?: 'left' | 'center';
}): React.JSX.Element {
  return (
    <section
      id={id}
      className={`sec ${tone === 'sunk' ? 'sec--sunk' : ''} ${align === 'center' ? 'sec--center' : ''}`}
    >
      <div className="sec__inner">
        <Reveal className="sec__head">
          {kicker === undefined ? null : <p className="sec__kicker">{kicker}</p>}
          <h2 className="sec__title">{title}</h2>
          {lead === undefined ? null : <p className="sec__lead">{lead}</p>}
        </Reveal>

        {children}
      </div>
    </section>
  );
}

/**
 * A card.
 *
 * One border, one radius, one hover, everywhere on the site. The variants are the two jobs a card
 * has here — an ordinary one, and one that is the point of its section.
 */
export function Card({
  children,
  index = 0,
  featured = false,
  className,
  as = 'div',
}: {
  children: ReactNode;
  index?: number;
  featured?: boolean;
  className?: string | undefined;
  as?: 'div' | 'li' | 'article';
}): React.JSX.Element {
  return (
    <Reveal
      as={as}
      index={index}
      className={`card ${featured ? 'card--lit' : ''} ${className ?? ''}`.trim()}
    >
      {children}
    </Reveal>
  );
}

/**
 * A grid of cards.
 *
 * `auto-fit` with a floor rather than a fixed column count: a three-column grid written as three
 * columns becomes three squashed columns on a tablet, and every section here holds a different
 * number of cards.
 */
export function CardGrid({
  children,
  min = 300,
  className,
  as = 'div',
}: {
  children: ReactNode;
  /** The narrowest a card may get before the grid drops a column. */
  min?: number;
  className?: string | undefined;
  as?: 'div' | 'ul';
}): React.JSX.Element {
  const Tag = as;
  return (
    <Tag
      className={`card-grid ${className ?? ''}`.trim()}
      style={{ ['--card-min' as string]: `${min}px` }}
    >
      {children}
    </Tag>
  );
}

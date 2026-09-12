import { describe, expect, it } from 'vitest';

import { cn } from './class-names';

// Runtime-valued flags, so the conditions below mirror real component usage rather than
// constant expressions the compiler could fold away.
const flags: Record<string, boolean> = { primary: false, small: true };

describe('cn', () => {
  it('joins plain class names', () => {
    expect(cn('btn', 'btn-primary')).toBe('btn btn-primary');
  });

  it('drops falsy values so inline conditions are safe', () => {
    expect(cn('btn', false, null, undefined, '')).toBe('btn');
    expect(cn('btn', flags.primary && 'btn-primary')).toBe('btn');
  });

  it('keeps a class when its condition is true', () => {
    expect(cn('btn', flags.small && 'btn-sm')).toBe('btn btn-sm');
  });

  it('flattens nested arrays', () => {
    expect(cn(['card', ['card-p', false]], 'tbl')).toBe('card card-p tbl');
  });

  it('normalises whitespace in multi-class strings', () => {
    expect(cn('  btn   btn-sm  ')).toBe('btn btn-sm');
  });

  it('de-duplicates repeated classes', () => {
    expect(cn('btn', 'btn', ['btn-sm', 'btn'])).toBe('btn btn-sm');
  });

  it('returns an empty string when nothing is truthy', () => {
    expect(cn()).toBe('');
    expect(cn(false, null, undefined)).toBe('');
  });
});

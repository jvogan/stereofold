import type { z } from 'zod';

/** Enforce inline authoring budgets without publishing array-size keywords. */
export const arrayAtMost = (maximum: number) => (value: unknown[], ctx: z.RefinementCtx) => {
  if (value.length > maximum) ctx.addIssue({ code: 'too_big', origin: 'array', maximum, inclusive: true });
};

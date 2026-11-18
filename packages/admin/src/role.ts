import type { AdminRole } from './types.ts';

const RANK: Record<AdminRole, number> = {
  viewer: 1,
  editor: 2,
  publisher: 3,
  owner: 4,
};

/** True when `role` is at least `min`; unknown roles never satisfy a minimum. */
export function roleAtLeast(role: string, min: AdminRole): boolean {
  const value = RANK[role as AdminRole];
  return value !== undefined && value >= RANK[min];
}

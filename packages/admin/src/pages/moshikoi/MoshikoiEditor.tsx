/**
 * Tab bodies for a moshikoi (もし恋) love event.
 *
 * The page keeps its own Settings tab, dirty tracking, Save draft and Validate
 * actions; this module only supplies the four documents the marathon editor has
 * no view for. Every panel reports edits through `onChange` with a new draft
 * object, so the page's `JSON.stringify` dirty check keeps working unchanged.
 */
import { MoshikoiCatalogTab } from './MoshikoiCatalogTab.tsx';
import { MoshikoiEndingsTab } from './MoshikoiEndingsTab.tsx';
import { MoshikoiJsonTab } from './MoshikoiJsonTab.tsx';
import { MoshikoiRoutesTab } from './MoshikoiRoutesTab.tsx';
import type { MoshikoiDraftShape } from './moshikoi.ts';
import type { ValidationIssue } from '../../types.ts';

/** The extra tabs a moshikoi event adds after Settings. */
export type MoshikoiTab = 'catalog' | 'routes' | 'endings' | 'json';

export const MOSHIKOI_TABS: { id: MoshikoiTab; label: string }[] = [
  { id: 'catalog', label: 'Catalog' },
  { id: 'routes', label: 'Routes' },
  { id: 'endings', label: 'Endings' },
  { id: 'json', label: 'JSON' },
];

export function isMoshikoiTab(tab: string): tab is MoshikoiTab {
  return MOSHIKOI_TABS.some((entry) => entry.id === tab);
}

export function MoshikoiTabContent({
  tab,
  draft,
  issues,
  canEdit,
  onChange,
}: {
  tab: MoshikoiTab;
  draft: MoshikoiDraftShape;
  issues: ValidationIssue[];
  canEdit: boolean;
  onChange: (next: MoshikoiDraftShape) => void;
}) {
  switch (tab) {
    case 'catalog':
      return (
        <MoshikoiCatalogTab draft={draft} issues={issues} canEdit={canEdit} onChange={onChange} />
      );
    case 'routes':
      return (
        <MoshikoiRoutesTab draft={draft} issues={issues} canEdit={canEdit} onChange={onChange} />
      );
    case 'endings':
      return (
        <MoshikoiEndingsTab draft={draft} issues={issues} canEdit={canEdit} onChange={onChange} />
      );
    case 'json':
      return (
        <MoshikoiJsonTab draft={draft} issues={issues} canEdit={canEdit} onChange={onChange} />
      );
  }
}

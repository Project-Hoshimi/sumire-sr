import badgeCss from '../styles.css?inline';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  ItemNameHint,
  LiveBonusGroupSummary,
  ResourceBadge,
  RewardSummary,
} from './ResourceBadge.tsx';
import type { LookupLiveBonusGroup, LookupReward, LookupRewardResource } from '../types.ts';

function resource(overrides: Partial<LookupRewardResource> = {}): LookupRewardResource {
  return {
    resourceType: 1,
    typeLabel: 'Item',
    resourceId: 'item-card_ability',
    amount: 100,
    name: 'エールパウダー',
    nameEn: 'Yell Powder',
    ...overrides,
  };
}

function reward(overrides: Partial<LookupReward> = {}): LookupReward {
  return {
    id: 'rd-basic',
    found: true,
    resources: [resource()],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('ResourceBadge', () => {
  it('shows the type, English name, muted Japanese and amount in that order', () => {
    const { container } = render(<ResourceBadge resource={resource()} />);

    const badge = container.querySelector('.resource-badge');
    expect(badge).not.toBeNull();
    const text = badge?.textContent ?? '';
    expect(text.indexOf('Item')).toBeLessThan(text.indexOf('Yell Powder'));
    expect(text.indexOf('Yell Powder')).toBeLessThan(text.indexOf('エールパウダー'));
    expect(text.indexOf('エールパウダー')).toBeLessThan(text.indexOf('×100'));
    expect(badge?.querySelector('.resource-name-jp')?.textContent).toBe('エールパウダー');
  });

  it('falls back to the resource id when no name exists', () => {
    render(
      <ResourceBadge
        resource={resource({ resourceType: 9, typeLabel: 'PvpMedal', resourceId: 'medal-1', name: null, nameEn: null, amount: 5 })}
      />,
    );

    expect(screen.getByText('PvpMedal')).toBeTruthy();
    expect(screen.getByText('medal-1')).toBeTruthy();
    expect(screen.getByText('×5')).toBeTruthy();
    expect(screen.queryByText('Yell Powder')).toBeNull();
  });

  it('draws the type as a rounded rectangle outlined in the type colour', () => {
    const { container } = render(<ResourceBadge resource={resource()} />);
    const type = container.querySelector('.resource-type') as HTMLElement;
    expect(type.className).toBe('resource-type');
    expect(type.style.color).not.toBe('');
    expect(type.style.borderColor).toBe(type.style.color);
    // No filled pill: the background stays transparent.
    expect(type.style.backgroundColor).toBe('');

    const css = badgeCss;
    const rule = css.match(/\.resource-type\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('background: transparent');
    expect(rule).toContain('border: 1px solid currentColor');
    expect(rule).toContain('border-radius: 4px');
    expect(rule).not.toContain('border-radius: 999');
  });
});

describe('RewardSummary', () => {
  it('renders every grant of a found reward', () => {
    render(
      <RewardSummary
        reward={reward({
          resources: [
            resource(),
            resource({ resourceType: 15, typeLabel: 'Stone', resourceId: '', name: null, nameEn: null, amount: 500 }),
          ],
        })}
        loading={false}
      />,
    );

    expect(screen.getByText('Item')).toBeTruthy();
    expect(screen.getByText('Stone')).toBeTruthy();
    expect(screen.getByText('×500')).toBeTruthy();
  });

  it('labels an unknown id without crashing', () => {
    render(<RewardSummary reward={undefined} loading={false} />);
    expect(screen.getByText('unknown id')).toBeTruthy();
  });

  it('shows an empty note for a found reward with no grants', () => {
    render(<RewardSummary reward={reward({ resources: [] })} loading={false} />);
    expect(screen.getByText('no resources')).toBeTruthy();
  });

  it('shows a muted note while a lookup with no previous row is loading', () => {
    const { container } = render(<RewardSummary reward={undefined} loading />);
    expect(container.textContent).toBe('resolving…');
    expect(container.querySelector('.resource-muted')).not.toBeNull();
  });

  it('keeps the previous badge while a new lookup is in flight', () => {
    render(<RewardSummary reward={reward()} loading />);
    expect(screen.getByText('Yell Powder')).toBeTruthy();
  });
});

describe('LiveBonusGroupSummary', () => {
  const group: LookupLiveBonusGroup = {
    groupId: 'live-bonus-group-box1-001',
    found: true,
    bonuses: [
      {
        liveBonusId: 'bonus-1',
        liveAbilityId: 'marathon-lba-vocal_add',
        level: 3,
        description: 'ボーカル1000上昇',
        descriptionEn: 'Vocal +1000',
        skills: [
          {
            skillId: 'sk-marathon-lba-vocal_add',
            name: 'ボーカル上昇',
            nameEn: 'Vocal Boost',
            level: 3,
            description: 'ボーカルが1000上昇',
            descriptionEn: 'Vocal increases by 1000',
          },
        ],
      },
    ],
  };

  it('shows the level and English description with muted Japanese', () => {
    const { container } = render(<LiveBonusGroupSummary group={group} loading={false} />);

    expect(screen.getByText('Live bonus')).toBeTruthy();
    expect(screen.getByText(/Lv\s*3/)).toBeTruthy();
    expect(screen.getByText('Vocal +1000')).toBeTruthy();
    expect(container.querySelector('.resource-name-jp')?.textContent).toBe('ボーカル1000上昇');
  });

  it('shows each resolved skill name and its level description', () => {
    const { container } = render(<LiveBonusGroupSummary group={group} loading={false} />);

    const skill = container.querySelector('.resource-skill');
    expect(skill).not.toBeNull();
    expect(skill?.textContent).toContain('Vocal Boost');
    expect(skill?.textContent).toContain('ボーカル上昇');
    expect(skill?.querySelector('.resource-skill-desc')?.textContent).toContain(
      'Vocal increases by 1000',
    );
    // The skill block sits below the bonus description.
    const text = container.textContent ?? '';
    expect(text.indexOf('Vocal +1000')).toBeLessThan(text.indexOf('Vocal Boost'));
  });

  it('labels an unknown group id and an empty group', () => {
    render(<LiveBonusGroupSummary group={undefined} loading={false} />);
    expect(screen.getByText('unknown id')).toBeTruthy();

    cleanup();
    render(
      <LiveBonusGroupSummary
        group={{ groupId: 'empty', found: true, bonuses: [] }}
        loading={false}
      />,
    );
    expect(screen.getByText('no live bonuses')).toBeTruthy();
  });

  it('keeps the previous group while a new lookup is in flight', () => {
    render(<LiveBonusGroupSummary group={group} loading />);
    expect(screen.getByText('Vocal +1000')).toBeTruthy();
  });
});

describe('ItemNameHint', () => {
  it('shows the resolved item name and Japanese translation', () => {
    render(
      <ItemNameHint
        id="stamina-item"
        items={[{ id: 'stamina-item', name: 'スタミナ回復薬', nameEn: 'Stamina Drink' }]}
      />,
    );

    expect(screen.getByText('Stamina Drink')).toBeTruthy();
    expect(screen.getByText('スタミナ回復薬')).toBeTruthy();
  });

  it('marks an id missing from the item list as unknown', () => {
    render(<ItemNameHint id="nope" items={[]} />);
    expect(screen.getByText('unknown id')).toBeTruthy();
  });

  it('stays empty before the item list arrives or when the id is empty', () => {
    const { container, rerender } = render(<ItemNameHint id="stamina-item" items={null} />);
    expect(container.textContent).toBe('');
    rerender(<ItemNameHint id="" items={null} />);
    expect(container.textContent).toBe('');
  });
});

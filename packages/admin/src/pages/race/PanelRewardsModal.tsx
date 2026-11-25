// Reward editor of one race board panel. The modal holds one shared
// `ResourceLookupPicker` per authored reward reference, so a panel can grant
// exactly the rewards the marathon box editor can author. Saving writes the
// list into `draft.panelRewards`; "Reset to master" drops the override again.
import { useEffect, useRef, useState } from 'react';
import { BrowseModal } from '../../components/BrowseModal.tsx';
import { ResourceLookupPicker } from '../../components/ResourceLookupPicker.tsx';

export interface PanelRewardsModalProps {
  open: boolean;
  /** Human label of the panel, e.g. `area race-area-005-01 panel 2`. */
  label: string;
  /** Reward references the modal opens with (override, else master). */
  rewards: readonly string[];
  /** True when `rewards` already comes from a draft override. */
  override: boolean;
  onSave: (rewards: string[]) => void;
  onReset: () => void;
  onClose: () => void;
}

/** Trimmed, non-empty references; the server drops empty entries anyway. */
function cleanedRewards(rewards: readonly string[]): string[] {
  return rewards.map((reward) => reward.trim()).filter((reward) => reward !== '');
}

export function PanelRewardsModal(props: PanelRewardsModalProps) {
  const { open, label, rewards, override, onSave, onReset, onClose } = props;
  const [rows, setRows] = useState<string[]>(() =>
    rewards.length === 0 ? [''] : [...rewards],
  );
  // Re-seed only when the dialog opens, so re-renders during an edit (a new
  // rewards array identity per parent render) never discard typed values.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setRows(rewards.length === 0 ? [''] : [...rewards]);
    wasOpen.current = open;
  }, [open, rewards]);

  const setRow = (index: number, value: string): void => {
    setRows((current) => current.map((entry, at) => (at === index ? value : entry)));
  };

  return (
    <BrowseModal
      open={open}
      title={`Panel rewards · ${label}`}
      ariaLabel="Panel rewards"
      onClose={onClose}
    >
      <div className="panel-rewards">
        <p className="muted">
          A panel with an override grants these rewards instead of the master panel reward.
        </p>
        {rows.map((value, index) => (
          <div className="panel-rewards-row" key={index}>
            <ResourceLookupPicker
              kind="rewards"
              value={value}
              ariaLabel={`Reward ${index + 1} for ${label}`}
              onChange={(next) => setRow(index, next)}
            />
            <button
              type="button"
              className="panel-rewards-remove"
              aria-label={`Remove reward ${index + 1}`}
              onClick={() =>
                setRows((current) => current.filter((_, at) => at !== index))
              }
            >
              Remove
            </button>
          </div>
        ))}
        <div className="panel-rewards-actions">
          <button type="button" onClick={() => setRows((current) => [...current, ''])}>
            Add reward
          </button>
        </div>
        <div className="panel-rewards-footer">
          {override ? (
            <button type="button" className="panel-rewards-reset" onClick={onReset}>
              Reset to master
            </button>
          ) : null}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="panel-rewards-save" onClick={() => onSave(cleanedRewards(rows))}>
            Save
          </button>
        </div>
      </div>
    </BrowseModal>
  );
}

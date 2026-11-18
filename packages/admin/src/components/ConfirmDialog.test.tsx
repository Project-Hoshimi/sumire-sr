/** In-page confirm dialog: labelling, callbacks, Escape and focus handling. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './ConfirmDialog.tsx';

afterEach(cleanup);

describe('ConfirmDialog', () => {
  it('renders the title and message and runs the button callbacks', async () => {
    const writer = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Publish version 3?"
        message="The previewed draft replaces the current published definition."
        confirmLabel="Publish version 3"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole('alertdialog', { name: 'Publish version 3?' })).toBeTruthy();
    expect(
      screen.getByText('The previewed draft replaces the current published definition.'),
    ).toBeTruthy();

    await writer.click(screen.getByRole('button', { name: 'Publish version 3' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    await writer.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape', async () => {
    const writer = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Discard unsaved changes?"
        message="Edits will be lost."
        confirmLabel="Discard"
        danger
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await writer.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('uses the danger class and disables both buttons while busy', () => {
    render(
      <ConfirmDialog
        open
        title="Delete box"
        message="Its items are removed."
        confirmLabel="Delete"
        danger
        busy
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const confirm = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    expect(confirm.className).toBe('danger');
    expect(confirm.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
  });

  it('focuses the confirm button on open and restores focus on close', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.append(trigger);
    trigger.focus();

    const props = {
      title: 'Discard unsaved changes?',
      message: 'Edits will be lost.',
      confirmLabel: 'Discard',
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
    const { rerender } = render(<ConfirmDialog open={false} {...props} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    rerender(<ConfirmDialog open {...props} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Discard' }));

    rerender(<ConfirmDialog open={false} {...props} />);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

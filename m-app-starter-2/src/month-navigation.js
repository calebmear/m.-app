import { monthLabel, validMonth } from './budget.js';

function monthAtOffset(month, offset) {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, number - 1 + offset, 1));
  const target = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return validMonth(target) ? target : '';
}

export function monthNavigationMarkup(month, disabled) {
  const arrow = (direction, offset, icon) => {
    const target = monthAtOffset(month, offset);
    return `<button type="button" data-month-direction="${direction}" data-month-target="${target}"
      aria-label="${direction === 'previous' ? 'Previous' : 'Next'} month${target ? `: ${monthLabel(target)}` : ''}"
      ${disabled || !target ? 'disabled' : ''}><span aria-hidden="true">${icon}</span></button>`;
  };

  return `<div class="month-heading month-navigation" data-month-navigation>
    ${arrow('previous', -1, '‹')}
    <h1>${monthLabel(month)}</h1>
    ${arrow('next', 1, '›')}
  </div>
  <p class="month-navigation-caption">Know what each paycheck covers.</p>`;
}

export function connectMonthNavigation(root, changeMonth) {
  let swipe = null;

  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-month-target]');
    if (!button || button.disabled) return;
    const { monthTarget, monthDirection } = button.dataset;
    const changed = await changeMonth(monthTarget);
    if (changed && event.detail === 0) {
      root.querySelector(`[data-month-direction="${monthDirection}"]:not(:disabled)`)?.focus({ preventScroll: true });
    }
  });

  root.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    const control = event.target.closest('[data-month-navigation]');
    swipe = event.isPrimary && control && !event.target.closest('button')
      ? { control, id: event.pointerId, x: event.clientX, y: event.clientY }
      : null;
  });

  root.addEventListener('pointercancel', () => { swipe = null; });
  root.addEventListener('pointerup', event => {
    if (!swipe || swipe.id !== event.pointerId) return;
    const { control, x, y } = swipe;
    swipe = null;
    const horizontal = event.clientX - x;
    const vertical = event.clientY - y;
    if (Math.abs(horizontal) < 48 || Math.abs(horizontal) < 1.5 * Math.abs(vertical)) return;
    const direction = horizontal < 0 ? 'next' : 'previous';
    if (!control.isConnected) return;
    const button = control.querySelector(`[data-month-direction="${direction}"]:not(:disabled)`);
    if (button) void changeMonth(button.dataset.monthTarget);
  });
}

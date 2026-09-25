// Tidepool chip (fictional). A toggle, so it should say whether it is on: it does not yet.
export function Chip({ label = 'Filter', size = 'M', icon = false, onClick }) {
  const cls = ['tp-chip', size === 'L' && 'tp-chip--l', icon && 'tp-chip--icon'].filter(Boolean).join(' ');
  return (
    <button className={cls} type="button" onClick={onClick}>
      <span className="tp-chip__icon" aria-hidden="true" />
      <span className="tp-chip__label">{label}</span>
    </button>
  );
}

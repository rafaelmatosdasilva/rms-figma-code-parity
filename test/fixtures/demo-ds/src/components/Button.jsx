// Tidepool button (fictional).
export function Button({ label = 'Save', disabled = false, onClick }) {
  return <button className="tp-button" type="button" disabled={disabled} onClick={onClick}>{label}</button>;
}

// Текст на весь экран — чтобы собеседник мог прочитать издалека.
// Закрывается касанием, кнопкой Esc или повторным показом другого текста.

const el = () => document.getElementById('bigText');

export function showBigText(text) {
  if (!text?.trim()) return;
  const box = el();
  const value = document.getElementById('bigTextValue');
  value.textContent = text;
  // Чем длиннее текст, тем мельче шрифт — чтобы влез на экран
  value.style.fontSize = `clamp(2.4rem, ${Math.max(4, 16 - text.length / 6)}vw, 9rem)`;
  box.hidden = false;
  box.focus?.();
}

export function hideBigText() {
  el().hidden = true;
}

document.getElementById('bigText').addEventListener('click', hideBigText);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideBigText();
});

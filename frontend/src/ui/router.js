// Простейшая навигация по адресу: #/ — «Тарҷума», #/train — «Омӯзиш», #/model — «Дар бораи ИИ».
// Панели с атрибутом data-view показываются только на своём экране.

const ROUTES = {
  '#/train': 'train',
  '#/model': 'model',
  '#/practice': 'practice',
  '#/admin': 'admin',
  '#/avatar': 'avatar',
  '#/profile': 'profile',
  '#/speech': 'speech',
};
const DEFAULT = 'translate';

export function currentRoute() {
  return ROUTES[location.hash] ?? DEFAULT;
}

/** @param {(route: string) => void} onChange */
export function initRouter(onChange) {
  const apply = () => {
    const route = currentRoute();
    document.body.dataset.route = route;
    document.querySelectorAll('[data-view]').forEach((el) => {
      el.hidden = el.dataset.view !== route;
    });
    document.querySelectorAll('[data-route]').forEach((link) => {
      if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    onChange(route);
  };
  window.addEventListener('hashchange', apply);
  apply();
}

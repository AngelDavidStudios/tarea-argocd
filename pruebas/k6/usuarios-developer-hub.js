// Prueba de carga con k6: usuarios virtuales que navegan Developer Hub por el NodePort.
// Uso: k6 run pruebas/k6/usuarios-developer-hub.js
//      BASE_URL=http://10.5.0.3:30700 PICO=200 k6 run pruebas/k6/usuarios-developer-hub.js
import http from 'k6/http';
import { check, group, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://10.5.0.3:30700';
const PICO = Number(__ENV.PICO || 200);

export const options = {
  scenarios: {
    usuarios: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },          // calentamiento
        { duration: '1m', target: PICO / 2 },     // llegan más usuarios
        { duration: '1m', target: PICO },         // hora pico
        { duration: '3m', target: PICO },         // se mantiene el pico
        { duration: '1m', target: 0 },            // los usuarios se van
      ],
      gracefulRampDown: '20s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],               // menos de 5 % de errores
    checks: ['rate>0.95'],
    'http_req_duration{grupo:api}': ['p(95)<3000'],
  },
};

// Cada usuario virtual entra como invitado una vez y reutiliza su token
let token = null;
function login() {
  const r = http.get(`${BASE}/api/auth/guest/refresh`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    tags: { grupo: 'login', name: 'login invitado' },
  });
  check(r, { 'login 200': (x) => x.status === 200 });
  token = r.status === 200 ? r.json('backstageIdentity.token') : null;
}

export default function () {
  if (!token) login();
  const api = { headers: { Authorization: `Bearer ${token}` }, tags: { grupo: 'api' } };

  group('abrir el catálogo', () => {
    const r = http.get(`${BASE}/catalog`, { tags: { grupo: 'web', name: 'GET /catalog' } });
    check(r, { 'página 200': (x) => x.status === 200 });
    const l = http.get(`${BASE}/api/catalog/entities/by-query?limit=20`, { ...api, tags: { ...api.tags, name: 'listar entidades' } });
    check(l, { 'listado 200': (x) => x.status === 200 });
    http.get(`${BASE}/api/catalog/entity-facets?facet=kind`, { ...api, tags: { ...api.tags, name: 'facetas' } });
  });
  sleep(Math.random() * 2 + 1);

  group('ver un componente', () => {
    const r = http.get(`${BASE}/api/catalog/entities/by-name/component/default/developer-hub`, { ...api, tags: { ...api.tags, name: 'ver componente' } });
    check(r, { 'componente 200': (x) => x.status === 200 });
    if (r.status === 401) token = null;           // token caducado: volver a entrar
  });
  sleep(Math.random() * 2 + 1);

  group('buscar', () => {
    const r = http.get(`${BASE}/api/search/query?term=argo`, { ...api, tags: { ...api.tags, name: 'buscar' } });
    check(r, { 'búsqueda 200': (x) => x.status === 200 });
  });
  sleep(Math.random() * 2 + 1);
}

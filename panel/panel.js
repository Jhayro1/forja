// Panel de Forja. Sin dependencias ni paso de compilación.
// Seguridad: el DOM se construye sólo con textContent (nunca innerHTML), así
// que ningún texto de un agente, log o diff puede inyectar HTML o scripts.
'use strict';

const state = { csrf: null, modules: [], view: 'resumen', data: null, taskOpen: null, taskTab: 'detalle', lastFetch: 0 };

/** h('div', { class: 'x', onclick }, 'texto', child) */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    // CSSOM, not the style attribute: the CSP forbids inline style attributes.
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(text, ms = 4000) {
  const t = document.getElementById('aviso');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

async function api(method, path, body) {
  const headers = {};
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-Forja-CSRF'] = state.csrf || '';
    headers['Idempotency-Key'] = crypto.randomUUID();
  }
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : method === 'GET' ? undefined : '{}', credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.mensaje) || `error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function mutate(method, path, body, okText) {
  try {
    const r = await api(method, path, body);
    toast(r.mensaje || okText || 'Listo');
    await refresh(true);
    return r;
  } catch (e) {
    toast(`✘ ${e.message}`, 7000);
    return null;
  }
}

// ---------- sesión ----------

async function login() {
  const match = /(?:^|&)codigo=([^&]+)/.exec(location.hash.slice(1));
  if (match) {
    // El código viaja en el fragmento (nunca llega al servidor ni a los logs) y se borra de la barra.
    history.replaceState(null, '', location.pathname);
    try {
      const r = await api('POST', '/v1/sesion', { codigo: decodeURIComponent(match[1]) });
      state.csrf = r.csrf;
      return true;
    } catch (e) {
      showLogin(e.message);
      return false;
    }
  }
  try {
    state.csrf = (await api('GET', '/v1/sesion')).csrf;
    return true;
  } catch {
    showLogin();
    return false;
  }
}

function showLogin(message) {
  const app = document.getElementById('app');
  const input = h('input', { type: 'password', 'aria-label': 'Código de acceso', autocomplete: 'off' });
  app.replaceChildren(
    h('div', { class: 'card login' },
      h('h1', {}, 'Entrar al panel'),
      h('p', { class: 'muted' }, 'Abre el enlace que muestra ', h('span', { class: 'mono' }, 'forja ui'), ' en tu terminal, o pega aquí su código.'),
      message ? h('p', { class: 's-bloqueada' }, message) : null,
      input,
      h('button', { class: 'act', onclick: () => { location.hash = `codigo=${encodeURIComponent(input.value.trim())}`; location.reload(); } }, 'Entrar'),
    ),
  );
}

// ---------- vistas ----------

const PHASES = [['descubrir', 'Descubrir'], ['especificar', 'Especificar'], ['dividir', 'Plan'], ['aprobar', 'Aprobar'], ['ejecutar', 'Ejecutar'], ['entregado', 'Entregado']];
const LABEL = {
  pendiente: 'espera dependencias', lista: 'lista', reservada: 'reservada', ejecutando: 'agente trabajando', verificando: 'verificando',
  verificada: 'verificada', integrando: 'integrando', integrada: 'integrada', esperando_respuesta: 'pregunta para ti', pausada: 'pausada',
  bloqueada: 'bloqueada', invalidada: 'invalidada', cancelada: 'cancelada',
};

function elapsed(iso) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
}
const tokens = (n) => (n === null || n === undefined ? '?' : n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);

function activityText(t) {
  if (t.estado === 'ejecutando' || t.estado === 'reservada') {
    const a = t.actividad || {};
    return `${elapsed(a.startedAt)} · ${tokens(a.tokens)} tok · ${a.current || 'arrancando'}`;
  }
  if (t.estado === 'esperando_respuesta') return t.pregunta || '';
  if (t.estado === 'bloqueada') return t.error || '';
  return t.error && t.estado === 'lista' ? `reintento: ${t.error}` : '';
}

function pendingCard(p) {
  const bad = p.kind === 'tarea_bloqueada';
  const body = h('div', { class: `card pending${bad ? ' bad' : ''}` },
    h('strong', {}, `${p.id} · ${{ pregunta_tarea: 'pregunta de un agente', tarea_bloqueada: 'tarea bloqueada', pregunta_spec: 'pregunta de la especificación', aprobacion: 'aprobación' }[p.kind] || p.kind}`),
    h('p', {}, p.text),
  );
  if (p.kind === 'pregunta_tarea') {
    const area = h('textarea', { rows: 2, 'aria-label': `Respuesta para ${p.id}` });
    body.append(area, h('button', { class: 'act', onclick: async (ev) => {
      if (!area.value.trim()) return toast('Escribe una respuesta');
      ev.target.disabled = true;
      await mutate('POST', `/v1/tareas/${p.id}/respuesta`, { respuesta: area.value.trim() });
      ev.target.disabled = false;
    } }, 'Responder'));
  } else if (bad) {
    const note = h('input', { type: 'text', placeholder: 'Nota para el agente (opcional)', 'aria-label': `Nota para reintentar ${p.id}` });
    body.append(note, h('button', { class: 'act', onclick: () => mutate('POST', `/v1/tareas/${p.id}/reintentar`, { nota: note.value.trim() }) }, 'Reintentar'));
  } else if (p.kind === 'aprobacion') {
    body.append(h('button', { class: 'act', onclick: () => confirm('¿Aprobar exactamente este plan, esta especificación y esta política?') && mutate('POST', '/v1/plan/aprobar') }, 'Aprobar plan'));
  } else {
    body.append(h('p', { class: 'muted mono' }, p.action));
  }
  return body;
}

function renderResumen(d) {
  if (!d.cambio) return [h('div', { class: 'card' }, h('h1', {}, 'Sin cambios todavía'), h('p', {}, 'Empieza en la terminal con ', h('span', { class: 'mono' }, 'forja planear "lo que quieres construir"')))];
  const phaseIdx = PHASES.findIndex(([p]) => p === d.cambio.fase);
  const pct = d.progreso.total ? Math.round((100 * d.progreso.integradas) / d.progreso.total) : 0;
  const agents = d.tareas.filter((t) => t.estado === 'ejecutando' || t.estado === 'reservada');
  const out = [
    h('div', { class: 'card' },
      h('h1', {}, d.cambio.titulo),
      h('div', { class: 'phases' }, PHASES.map(([p, label], i) => h('span', { class: `phase${d.cambio.fase === 'entregado' || i < phaseIdx ? ' done' : i === phaseIdx ? ' now' : ''}` }, label))),
      d.run ? h('div', {},
        h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { style: `width:${pct}%` })),
        h('span', {}, `${d.progreso.integradas}/${d.progreso.total} integradas · run ${d.run.estado}${d.run.activo ? ' (en ejecución)' : ''}`),
        d.run.detalle ? h('div', { class: 'muted' }, d.run.detalle) : null,
        d.run.activo ? h('button', { class: 'sec', onclick: () => confirm('¿Detener el run? Los agentes en curso terminan su tarea.') && mutate('POST', '/v1/run/detener') }, 'Detener run') : null,
      ) : null,
      h('p', { class: 'muted' }, 'Siguiente paso: ', h('span', { class: 'mono' }, d.siguiente)),
      d.entrega ? h('p', {}, 'Entregado en ', h('span', { class: 'mono' }, d.entrega)) : null,
    ),
  ];
  if (d.pendientes.length) out.push(h('h2', {}, `Pendiente de ti (${d.pendientes.length})`), h('div', { class: 'grid' }, d.pendientes.map(pendingCard)));
  out.push(h('h2', {}, `Agentes (${agents.length})`));
  out.push(agents.length
    ? h('div', { class: 'grid' }, agents.map((t) => h('div', { class: 'card' }, h('strong', {}, `${t.id} · ${t.titulo}`), h('div', { class: 'muted mono' }, t.modelo || ''), h('div', {}, activityText(t)))))
    : h('p', { class: 'muted' }, d.run && d.run.activo ? 'Ningún agente trabajando en este momento.' : 'Nadie ejecutando: lanza o retoma con forja run.'));
  if (d.tareas.length) {
    out.push(h('h2', {}, `Tareas (${d.tareas.length})`));
    out.push(h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Tarea'), h('th', {}, 'Estado'), h('th', { class: 'hide-sm' }, 'Modelo'), h('th', { class: 'hide-sm' }, 'Intento'), h('th', {}, 'Actividad'))),
      h('tbody', {}, d.tareas.map((t) => h('tr', { tabindex: 0, onclick: () => openTask(t.id), onkeydown: (e) => e.key === 'Enter' && openTask(t.id) },
        h('td', {}, h('strong', {}, t.id), ' ', t.titulo),
        h('td', { class: `state s-${t.estado}` }, LABEL[t.estado] || t.estado),
        h('td', { class: 'mono hide-sm' }, t.modelo || '—'),
        h('td', { class: 'hide-sm' }, String(t.intento)),
        h('td', {}, activityText(t)),
      ))),
    ));
  }
  if (d.registro && d.registro.length) out.push(h('h2', {}, 'Registro'), h('pre', {}, d.registro.slice(-30).join('\n')));
  out.push(h('h2', {}, 'Consumo'));
  out.push(d.consumo.length
    ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Rol'), h('th', {}, 'Llamadas'), h('th', {}, 'Tokens'), h('th', {}, 'Costo equivalente'))),
      h('tbody', {}, d.consumo.map((u) => h('tr', {}, h('td', {}, u.role), h('td', {}, String(u.calls)), h('td', {}, u.tokens === null ? 'desconocido' : tokens(u.tokens)), h('td', {}, u.costMicro === null ? 'desconocido' : `US$ ${(u.costMicro / 1e6).toFixed(2)} (medido)`)))))
    : h('p', { class: 'muted' }, 'Sin consumo registrado en este run.'));
  return out;
}

function diffPre(lines) {
  return h('pre', {}, lines.map((l) => h('div', { class: l.startsWith('+') && !l.startsWith('+++') ? 'diff-add' : l.startsWith('-') && !l.startsWith('---') ? 'diff-del' : l.startsWith('@@') ? 'diff-hunk' : '' }, l || ' ')));
}

async function openTask(id, tab) {
  state.taskOpen = id;
  if (tab) state.taskTab = tab;
  const drawer = document.getElementById('detalle');
  drawer.hidden = false;
  let body;
  try {
    if (state.taskTab === 'diff') body = diffPre((await api('GET', `/v1/tareas/${id}/diff`)).diff);
    else {
      const t = (await api('GET', `/v1/tareas/${id}`)).tarea;
      body = h('pre', {}, (t[state.taskTab] || []).join('\n'));
    }
  } catch (e) {
    body = h('p', { class: 's-bloqueada' }, e.message);
  }
  const tabs = [['detalle', 'Detalle'], ['registro', 'Registro del agente'], ['diff', 'Diferencias'], ['instrucciones', 'Instrucciones']];
  drawer.replaceChildren(
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, h('h1', {}, id), h('button', { class: 'sec', onclick: closeTask, 'aria-label': 'Cerrar detalle' }, 'Cerrar')),
    h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, label]) => h('button', { role: 'tab', 'aria-selected': state.taskTab === k ? 'true' : 'false', onclick: () => openTask(id, k) }, label))),
    body,
  );
}

function closeTask() {
  state.taskOpen = null;
  document.getElementById('detalle').hidden = true;
}

// Módulos opcionales (M5/M6) registran su vista aquí; el menú sólo muestra los que el servidor tiene.
const VIEWS = [{ id: 'resumen', title: 'Flujo', module: 'runs', path: '/v1/estado', key: 'estado', render: renderResumen }];
window.forjaViews = VIEWS;

function renderNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(...VIEWS.filter((v) => state.modules.includes(v.module)).map((v) => h('button', { 'aria-current': state.view === v.id ? 'page' : 'false', onclick: () => { state.view = v.id; renderNav(); refresh(true); } }, v.title)));
}

async function refresh(force) {
  if (!force && Date.now() - state.lastFetch < 250) return;
  state.lastFetch = Date.now();
  const view = VIEWS.find((v) => v.id === state.view) || VIEWS[0];
  try {
    const data = await api('GET', view.path);
    const app = document.getElementById('app');
    app.replaceChildren(...view.render(data[view.key], data));
    if (state.taskOpen && view.id === 'resumen' && state.taskTab === 'registro') openTask(state.taskOpen);
  } catch (e) {
    if (e.status === 401) return showLogin('La sesión venció.');
    toast(`✘ ${e.message}`);
  }
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(true), 300);
}

function connectEvents() {
  const status = document.getElementById('conexion');
  const es = new EventSource('/v1/eventos');
  es.addEventListener('open', () => (status.textContent = '● en vivo'));
  es.addEventListener('error', () => (status.textContent = '○ reconectando…'));
  es.addEventListener('snapshot', scheduleRefresh);
  es.addEventListener('evento', scheduleRefresh);
}

async function main() {
  if (!(await login())) return;
  state.modules = (await api('GET', '/v1/modulos')).modulos;
  renderNav();
  await refresh(true);
  connectEvents();
  // Activity of working agents is not a domain event: refresh it every few seconds.
  setInterval(() => refresh(false), 5000);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeTask());
}

main();

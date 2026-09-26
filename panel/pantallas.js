// Pantallas de inicio de Forja: el flujo guiado (Inicio), Proyectos y Configuración.
// Usa las utilidades de panel.js (h, api, mutate, toast, go, onProjectChanged, state, T, VIEWS).
// Igual que panel.js: el DOM se arma sólo con textContent, nunca con innerHTML.

// ---------- utilidades ----------

const cache = new Map();

/** GET con ETag: si nada cambió, devuelve lo último que se leyó. */
async function read(path) {
  const r = await api('GET', path);
  if (r.sinCambios && cache.has(path)) return cache.get(path);
  if (r.sinCambios) {
    etags.delete(path);
    return read(path);
  }
  cache.set(path, r);
  return r;
}

function card(...children) {
  return h('div', { class: 'card stack' }, ...children);
}

function btn(text, onclick, primary = true, disabled = false) {
  return h('button', { class: primary ? 'act' : 'sec', onclick, disabled }, text);
}

function field(label, input, help) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, help ? h('span', { class: 'muted small' }, help) : null);
}

/** Sólo enlaces https reales (vienen de la salida de un CLI). */
function safeLink(url, text) {
  return typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url) ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'act link' }, text) : null;
}

async function startJob(tipo, pregunta) {
  if (pregunta && !confirm(pregunta)) return null;
  return mutate('POST', '/v1/trabajos', { tipo });
}

const JOB_STATE = { corriendo: 'en curso…', ok: 'terminó bien', error: 'falló', cancelado: 'cancelado', interrumpido: 'se interrumpió' };

/** Tarjeta del último trabajo (especificar, dividir, run, instalar…), con su salida. */
function jobCard(job, salida, base) {
  if (!job) return null;
  const open = job.estado === 'corriendo' || job.estado === 'error' || state.showJob === job.id;
  return card(
    h('div', { class: 'row' }, h('strong', {}, job.titulo), h('span', { class: `badge b-${job.estado}` }, JOB_STATE[job.estado] || job.estado)),
    open && salida ? h('pre', { class: 'log' }, salida.length ? salida.join('\n') : 'Esperando la primera línea…') : job.ultima_linea ? h('p', { class: 'muted small mono' }, job.ultima_linea) : null,
    h(
      'div',
      { class: 'row' },
      job.estado !== 'corriendo'
        ? btn(
            open ? 'Ocultar salida' : 'Ver salida',
            () => {
              state.showJob = open ? null : job.id;
              void refresh(true);
            },
            false,
          )
        : null,
      job.estado === 'corriendo'
        ? btn(
            state.cancelAsked === job.id ? 'Forzar la cancelación' : 'Cancelar',
            async () => {
              const force = state.cancelAsked === job.id;
              state.cancelAsked = job.id;
              await mutate('POST', `${base}/${job.id}/cancelar`, { forzar: force });
            },
            false,
          )
        : null,
    ),
  );
}

// ---------- Inicio: el flujo guiado ----------

async function loadInicio() {
  const [pl, est, tr] = await Promise.all([read('/v1/planeacion'), read('/v1/estado'), read('/v1/trabajos')]);
  const job = tr.trabajos[0] || null;
  let salida = null;
  if (job && (job.estado === 'corriendo' || job.estado === 'error' || state.showJob === job.id)) salida = (await read(`/v1/trabajos/${job.id}`)).salida.slice(-40);
  const planeacion = pl.planeacion;
  state.fastPoll = Boolean(planeacion.chat?.pensando) || job?.estado === 'corriendo';
  return { pl: planeacion, est: est.estado, job, salida, nuevo: state.nuevo === true };
}

function stepper(fase) {
  const order = T.fases.map(([id]) => id);
  const now = order.indexOf(fase);
  return h(
    'ol',
    { class: 'steps', 'aria-label': 'Pasos' },
    ...T.fases.map(([, label], i) => h('li', { class: now < 0 ? '' : i < now || fase === 'entregado' ? 'done' : i === now ? 'now' : '', 'aria-current': i === now ? 'step' : null }, label)),
  );
}

function bubble(who, text, meta) {
  return h('div', { class: `msg ${who}` }, h('div', { class: 'msg-text' }, text), meta ? h('div', { class: 'msg-meta' }, meta) : null);
}

function chatView(pl, isNew) {
  const chat = pl.chat || {};
  const turns = isNew ? [] : pl.conversacion || [];
  const disc = isNew ? null : pl.descubrimiento;
  const thinking = chat.pensando;
  const input = h('textarea', {
    rows: 3,
    placeholder: turns.length ? 'Responde o agrega detalles…' : 'Ej.: Quiero que el ERP permita registrar pagos parciales de facturas y ver el saldo de cada cliente.',
    oninput: (e) => (state.draft = e.target.value),
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void sendChat(isNew);
    },
    disabled: Boolean(thinking),
    'aria-label': 'Mensaje para el planeador',
  });
  input.value = state.draft || '';
  const msgs = [];
  if (!turns.length && !thinking)
    msgs.push(
      bubble(
        'ia',
        'Cuéntame qué quieres construir o mejorar en este proyecto. Te haré preguntas hasta que todo quede claro; después Forja escribe la especificación, la divide en tareas y la programa en paralelo.',
        `planeador: ${chat.planeador || '?'} · usa tu cuenta`,
      ),
    );
  // The first idea is stored as the change's title, not as the first turn's text.
  if (turns.length && !turns[0].usuario && pl.cambio) msgs.push(bubble('yo', pl.cambio.titulo));
  for (const t of turns) {
    if (t.usuario) msgs.push(bubble('yo', t.usuario));
    msgs.push(bubble('ia', t.planeador, t.modelo));
  }
  if (thinking) {
    msgs.push(bubble('yo', thinking.texto));
    msgs.push(bubble('ia pensando', 'Pensando…', `${chat.planeador || ''} · puede tardar unos minutos`));
  }
  const blockers = disc ? disc.bloqueos : [];
  const side = disc
    ? card(
        h('h3', {}, 'Lo acordado hasta ahora'),
        disc.resumen ? h('p', {}, disc.resumen) : h('p', { class: 'muted' }, 'Todavía no hay resumen.'),
        disc.preguntas_abiertas.length ? h('h4', {}, 'Preguntas abiertas') : null,
        disc.preguntas_abiertas.length ? h('ul', {}, ...disc.preguntas_abiertas.map((q) => h('li', {}, `${q.texto}${q.recomendacion ? ` (sugiero: ${q.recomendacion})` : ''}`))) : null,
        disc.decisiones.length ? h('h4', {}, 'Decisiones') : null,
        disc.decisiones.length ? h('ul', {}, ...disc.decisiones.map((x) => h('li', {}, `${x.estado === 'aceptada' ? '✔' : '?'} ${x.contenido}`))) : null,
        blockers.length ? h('h4', {}, 'Falta para seguir') : null,
        blockers.length ? h('ul', { class: 'muted' }, ...blockers.map((b) => h('li', {}, b))) : null,
        h(
          'div',
          { class: 'row' },
          btn('Aprobar y seguir →', () => mutate('POST', '/v1/planeacion/descubrimiento/aprobar'), true, blockers.length > 0 || Boolean(thinking)),
          turns.length ? btn('Cerrar la conversación', () => mutate('POST', '/v1/planeacion/mensaje', { cerrar: true }), false, Boolean(thinking)) : null,
        ),
        blockers.length ? h('p', { class: 'muted small' }, 'Cuando no quede nada pendiente podrás aprobar. «Cerrar la conversación» le pide al planeador que prepare el resumen final.') : null,
      )
    : null;
  return h(
    'div',
    { class: side ? 'split' : '' },
    h(
      'div',
      { class: 'chat card' },
      h('div', { class: 'msgs' }, ...msgs),
      chat.error ? h('p', { class: 's-bloqueada' }, `✘ ${chat.error}`) : null,
      input,
      h(
        'div',
        { class: 'row' },
        btn(thinking ? 'Esperando respuesta…' : 'Enviar', () => sendChat(isNew), true, Boolean(thinking)),
        h('span', { class: 'muted small' }, 'Ctrl+Enter para enviar'),
      ),
    ),
    side,
  );
}

async function sendChat(isNew) {
  const texto = (state.draft || '').trim();
  if (!texto) return toast('Escribe un mensaje');
  const r = await mutate('POST', '/v1/planeacion/mensaje', { texto, nuevo: isNew });
  if (r) {
    state.draft = '';
    state.nuevo = false;
    state.rendered = '';
    void refresh(true);
  }
}

function specView(pl) {
  const e = pl.especificacion;
  const planner = pl.chat?.planeador || 'el planeador';
  if (!e)
    return card(
      h('h3', {}, 'La conversación quedó aprobada'),
      h('p', {}, 'Ahora Forja convierte lo acordado en una especificación: casos de uso, criterios de aceptación y documentos en tu repositorio.'),
      btn('Escribir la especificación', () => startJob('especificar', `Esto usa ${planner} con tu cuenta y puede tardar unos minutos. ¿Seguir?`)),
    );
  const pending = e.preguntas.filter((q) => !q.respuesta);
  return card(
    h('h3', {}, `Especificación · revisión ${e.revision}`),
    h('p', {}, `${e.casos_uso.length} casos de uso · ${e.criterios} criterios de aceptación`),
    h('ul', {}, ...e.casos_uso.slice(0, 12).map((u) => h('li', {}, `${u.id} · ${u.nombre}`))),
    e.problemas.length ? h('p', { class: 's-bloqueada' }, `Hay ${e.problemas.length} problema(s): vuelve a escribir la especificación.`) : null,
    ...e.preguntas.map((q) => questionBox(q)),
    h(
      'div',
      { class: 'row' },
      btn(
        'Dividir en tareas →',
        () => startJob('dividir', `Esto usa ${planner} para dividir el trabajo en tareas con su estimación. ¿Seguir?`),
        true,
        pending.some((q) => q.bloquea?.length) || e.problemas.length > 0,
      ),
      btn('Volver a escribir la especificación', () => startJob('especificar', 'Se rehace la especificación con tus respuestas. ¿Seguir?'), false),
    ),
    pending.length ? h('p', { class: 'muted small' }, 'Responde las preguntas y vuelve a escribir la especificación para incorporarlas.') : null,
  );
}

function questionBox(q) {
  if (q.respuesta) return h('p', { class: 'muted small' }, `✔ ${q.id}: ${q.texto} → ${q.respuesta}`);
  const input = h('input', { type: 'text', placeholder: q.recomendacion ? `Sugerido: ${q.recomendacion}` : 'Tu respuesta', 'aria-label': q.texto });
  return h(
    'div',
    { class: 'pending card' },
    h('p', {}, `${q.id}: ${q.texto}`),
    input,
    btn(
      'Responder',
      () => {
        const v = input.value.trim() || q.recomendacion || '';
        if (!v) return toast('Escribe una respuesta');
        return mutate('POST', `/v1/planeacion/preguntas/${q.id}/respuesta`, { respuesta: v });
      },
      false,
    ),
  );
}

function estimateText(est) {
  if (!est || typeof est !== 'object') return null;
  const parts = [`~${est.minutos_en_paralelo} min con ${est.paralelo} agentes a la vez`, `~${tokens(est.tokens_total)} tokens`];
  if (est.costo_equivalente_usd !== null) parts.push(`~$${est.costo_equivalente_usd} equivalente`);
  return `Estimación (sin calibrar): ${parts.join(' · ')}`;
}

function planView(pl) {
  const p = pl.plan;
  if (!p) return specView(pl);
  const problems = p.problemas_para_aprobar || [];
  const profile = problems.some((x) => /perfil|l[ií]nea base/i.test(typeof x === 'string' ? x : JSON.stringify(x)));
  return card(
    h('h3', {}, `Plan · ${p.tareas.length} tareas en ${p.olas.length} olas`),
    estimateText(p.estimacion) ? h('p', {}, estimateText(p.estimacion)) : null,
    h('ol', {}, ...p.tareas.slice(0, 30).map((t) => h('li', {}, `${t.id} · ${t.titulo}`, h('span', { class: 'muted small' }, ` (${t.tipo}, ${t.complejidad})`)))),
    problems.length ? h('h4', {}, 'Antes de aprobar') : null,
    problems.length ? h('ul', { class: 's-bloqueada' }, ...problems.map((x) => h('li', {}, typeof x === 'string' ? x : x.mensaje || JSON.stringify(x)))) : null,
    profile
      ? h(
          'div',
          { class: 'row' },
          btn('Aprobar el perfil detectado', () => startJob('perfil-aprobar'), false),
          btn('Medir la línea base (build y tests)', () => startJob('linea-base', 'Corre la instalación, el build y los tests de tu proyecto dentro del sandbox. ¿Seguir?'), false),
        )
      : null,
    p.aprobado
      ? h(
          'div',
          { class: 'row' },
          btn('Ejecutar ▶', () => startJob('run', `Forja va a programar ${p.tareas.length} tareas con agentes en paralelo. ${estimateText(p.estimacion) || ''} ¿Empezar?`)),
        )
      : h(
          'div',
          { class: 'row' },
          btn('Aprobar el plan', () => mutate('POST', '/v1/plan/aprobar'), true, problems.length > 0),
          btn('Rehacer el plan', () => startJob('dividir', 'Se vuelve a dividir en tareas. ¿Seguir?'), false),
        ),
  );
}

function runView(est, job) {
  const run = est.run;
  const prog = est.progreso || { integradas: 0, total: 0 };
  const pct = prog.total ? Math.round((prog.integradas / prog.total) * 100) : 0;
  const busy = job && job.estado === 'corriendo';
  return card(
    h('h3', {}, `Ejecutando · ${prog.integradas} de ${prog.total} tareas integradas`),
    h('div', { class: 'progress' }, h('span', { style: `width:${pct}%` })),
    prog.minutos_restantes ? h('p', { class: 'muted' }, `Quedan ~${prog.minutos_restantes} min (estimado)`) : null,
    est.pendientes?.length ? h('h4', {}, `Necesita tu atención (${est.pendientes.length})`) : null,
    ...(est.pendientes || []).slice(0, 5).map((p) => h('div', { class: 'pending card' }, h('p', {}, `${p.id} · ${p.text}`), h('p', { class: 'muted small' }, p.action))),
    h(
      'div',
      { class: 'row' },
      btn('Ver las tareas en detalle', () => go('resumen'), false),
      run?.activo ? btn('Detener', () => confirm('¿Detener el run? Las tareas en curso terminan en orden.') && mutate('POST', '/v1/run/detener'), false) : null,
      !run?.activo && !busy ? btn('Continuar la ejecución ▶', () => startJob('run')) : null,
    ),
  );
}

function deliveredView(est) {
  return card(
    h('h3', {}, '✔ Entregado'),
    h('p', {}, 'Los cambios están en la rama ', h('strong', { class: 'mono' }, est.entrega || 'de entrega'), '. Tu rama principal no se tocó: revísala y mézclala cuando quieras.'),
    h(
      'div',
      { class: 'row' },
      btn('Ver el informe', () => startJob('informe'), false),
      btn('Empezar un cambio nuevo', () => {
        state.nuevo = true;
        state.draft = '';
        state.rendered = '';
        void refresh(true);
      }),
    ),
  );
}

function renderInicio(d) {
  const fase = d.nuevo ? null : d.pl.cambio?.fase || null;
  const title = d.pl.cambio && !d.nuevo ? d.pl.cambio.titulo : 'Nuevo cambio';
  let body;
  if (!fase || fase === 'cancelado' || fase === 'descubrir') body = chatView(d.pl, !fase || fase === 'cancelado');
  else if (fase === 'especificar' || fase === 'dividir') body = specView(d.pl);
  else if (fase === 'aprobar') body = planView(d.pl);
  else if (fase === 'ejecutar') body = runView(d.est, d.job);
  else if (fase === 'entregado') body = deliveredView(d.est);
  return [h('h1', {}, title), stepper(fase), body, jobCard(d.job, d.salida, '/v1/trabajos')];
}

// ---------- Proyectos ----------

async function loadProyectos() {
  const p = await read('/v1/proyectos');
  let carpetas = null;
  if (state.browse !== undefined && state.browse !== null) {
    try {
      carpetas = await read(`/v1/carpetas${state.browse ? `?ruta=${encodeURIComponent(state.browse)}` : ''}`);
    } catch (e) {
      carpetas = { error: e.message };
    }
  }
  return { p, carpetas };
}

async function importFolder(ruta) {
  if (!ruta.trim()) return toast('Pega la ruta de la carpeta de tu proyecto');
  let r = await mutate('POST', '/v1/proyectos/importar', { ruta });
  if (!r) return;
  if (r.requiere_confianza) {
    const where = r.ruta_windows || r.ruta;
    const ok = confirm(
      `Git no confía en esta carpeta porque sus archivos tienen otro dueño (es normal con carpetas de Windows abiertas desde WSL):\n\n${where}\n\n¿Es tu proyecto y confías en ella? Forja la marca como confiable para git (safe.directory) y sigue.`,
    );
    if (!ok) return;
    r = await mutate('POST', '/v1/proyectos/importar', { ruta, confiar: true });
    if (!r || r.requiere_confianza) return;
  }
  state.browse = null;
  state.importPath = '';
  if (r.bloqueos?.length) toast(`Importado, pero: ${r.bloqueos.join(' · ')}`, 10000);
  await onProjectChanged('inicio');
}

function browseTo(path) {
  state.browse = path;
  return refresh(true);
}

function browser(c) {
  if (!c) return null;
  if (c.error) return card(h('p', { class: 's-bloqueada' }, c.error));
  return card(
    h('div', { class: 'row' }, ...c.raices.map((r) => btn(r.nombre, () => browseTo(r.ruta), false))),
    h('p', { class: 'mono small' }, c.ruta_windows || c.ruta),
    h(
      'div',
      { class: 'row' },
      c.padre ? btn('⬆ Subir', () => browseTo(c.padre), false) : null,
      btn(c.repo ? 'Usar esta carpeta' : 'Usar esta carpeta (no es un repo git)', () => importFolder(c.ruta), true, !c.repo),
    ),
    c.carpetas.length
      ? h(
          'ul',
          { class: 'folders' },
          ...c.carpetas.map((f) => h('li', {}, h('button', { class: 'linklike', onclick: () => browseTo(f.ruta) }, `📁 ${f.nombre}`), f.repo ? h('span', { class: 'badge b-ok' }, 'git') : null)),
        )
      : h('p', { class: 'muted' }, 'No hay subcarpetas.'),
  );
}

function renderProyectos(d) {
  const list = d.p.proyectos || [];
  const pathInput = h('input', {
    type: 'text',
    placeholder: d.p.wsl ? 'C:\\Users\\tú\\Desktop\\mi-proyecto' : '/home/tú/mi-proyecto',
    oninput: (e) => (state.importPath = e.target.value),
    onkeydown: (e) => e.key === 'Enter' && importFolder(state.importPath || ''),
    'aria-label': 'Ruta de la carpeta',
  });
  pathInput.value = state.importPath || '';
  const nameInput = h('input', { type: 'text', placeholder: 'mi-proyecto', 'aria-label': 'Nombre del proyecto nuevo' });
  const parentInput = h('input', { type: 'text', placeholder: d.p.wsl ? 'C:\\Users\\tú\\Desktop (opcional)' : 'carpeta (opcional)', 'aria-label': 'Carpeta donde crearlo' });
  return [
    h('h1', {}, 'Proyectos'),
    list.length ? null : h('p', {}, 'Agrega la carpeta de tu proyecto para empezar. Tiene que ser un repositorio git.'),
    list.length
      ? h(
          'div',
          { class: 'grid' },
          ...list.map((p) =>
            card(
              h(
                'div',
                { class: 'row' },
                h('strong', {}, p.nombre),
                p.actual ? h('span', { class: 'badge b-ok' }, 'actual') : null,
                p.existe ? null : h('span', { class: 'badge b-error' }, 'la carpeta no existe'),
              ),
              h('p', { class: 'mono small muted' }, p.ruta_windows || p.ruta),
              h(
                'div',
                { class: 'row' },
                p.actual
                  ? btn('Ir al inicio →', () => go('inicio'))
                  : btn('Trabajar aquí', async () => {
                      const r = await mutate('POST', `/v1/proyectos/${p.id}/seleccionar`);
                      if (r) await onProjectChanged('inicio');
                    }),
                btn(
                  'Archivar',
                  async () => {
                    if (!confirm(`¿Archivar «${p.nombre}»? No se borra nada: sólo deja de aparecer aquí.`)) return;
                    const r = await mutate('POST', `/v1/proyectos/${p.id}/archivar`);
                    if (r) await onProjectChanged('proyectos');
                  },
                  false,
                ),
              ),
            ),
          ),
        )
      : null,
    h('h2', {}, 'Agregar un proyecto existente'),
    card(
      field('Carpeta del proyecto', pathInput, d.p.wsl ? 'Puedes pegar la ruta de Windows tal cual (clic derecho en la carpeta → «Copiar como ruta de acceso»).' : null),
      h(
        'div',
        { class: 'row' },
        btn('Importar', () => importFolder(state.importPath || '')),
        btn(
          state.browse !== undefined && state.browse !== null ? 'Ocultar carpetas' : 'Buscar la carpeta…',
          () => {
            state.browse = state.browse !== undefined && state.browse !== null ? null : '';
            void refresh(true);
          },
          false,
        ),
      ),
    ),
    browser(d.carpetas),
    h('h2', {}, 'Crear un proyecto nuevo'),
    card(
      field('Nombre', nameInput),
      field('Dónde', parentInput, 'Si lo dejas vacío, se crea en tu carpeta personal de Linux.'),
      btn('Crear', async () => {
        const nombre = nameInput.value.trim();
        if (!nombre) return toast('Escribe un nombre');
        const r = await mutate('POST', '/v1/proyectos/nuevo', { nombre, carpeta: parentInput.value.trim() || null });
        if (r) await onProjectChanged('inicio');
      }),
    ),
  ];
}

// ---------- Configuración ----------

async function loadConfiguracion() {
  const sys = (await read(state.refreshSystem ? '/v1/sistema?refrescar=1' : '/v1/sistema')).sistema;
  state.refreshSystem = false;
  const cfg = state.modules.includes('configuracion') ? (await read('/v1/configuracion')).configuracion : null;
  let salida = null;
  const job = sys.trabajo;
  if (job && (job.estado === 'corriendo' || job.estado === 'error' || state.showJob === job.id)) salida = (await read(`/v1/sistema/trabajos/${job.id}`)).salida.slice(-40);
  const sessions = Object.values(sys.sesiones || {}).filter(Boolean);
  state.fastPoll = job?.estado === 'corriendo' || sessions.some((s) => s.estado === 'iniciando' || s.estado === 'esperando');
  return { sys, cfg, salida, draft: state.cfgDraft || null };
}

const ICON = { ok: '✔', aviso: '!', error: '✘' };
const PROVIDER = { claude: 'Claude Code', codex: 'Codex' };

function loginBox(p, s) {
  if (!s) return null;
  if (s.estado === 'iniciando') return h('p', { class: 'muted' }, 'Abriendo el inicio de sesión…');
  if (s.estado === 'listo') return h('p', { class: 's-integrada' }, '✔ Sesión iniciada');
  if (s.estado === 'cancelado') return null;
  if (s.estado === 'error') return h('p', { class: 's-bloqueada' }, `✘ ${s.mensaje || 'no se pudo iniciar sesión'}`);
  const code = h('input', { type: 'text', placeholder: 'Pega aquí el código', 'aria-label': `Código de ${PROVIDER[p]}`, autocomplete: 'off' });
  const cancel = btn('Cancelar', () => mutate('POST', `/v1/sistema/proveedores/${p}/sesion/cancelar`), false);
  if (p === 'claude' && !s.pide_codigo) return h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Verificando el código…'), cancel);
  return h(
    'div',
    { class: 'stack' },
    h(
      'p',
      {},
      s.pide_codigo ? '1. Abre la página e inicia sesión con tu cuenta. 2. Copia el código que te muestra. 3. Pégalo aquí.' : 'Abre la página e inicia sesión con tu cuenta; esto se completa solo.',
    ),
    safeLink(s.url, 'Abrir la página para iniciar sesión ↗'),
    s.pide_codigo
      ? h(
          'div',
          { class: 'row' },
          code,
          btn('Enviar código', () => {
            if (!code.value.trim()) return toast('Pega el código');
            return mutate('POST', `/v1/sistema/proveedores/${p}/sesion/codigo`, { codigo: code.value.trim() });
          }),
        )
      : null,
    s.mensaje ? h('p', { class: s.pide_codigo ? 's-bloqueada small' : 'muted small' }, s.mensaje) : null,
    cancel,
  );
}

function providerCard(p, check, session) {
  const installed = check && !/no instalado/.test(check.detail);
  const ready = check && check.level === 'ok';
  const busy = session && (session.estado === 'iniciando' || session.estado === 'esperando');
  return card(
    h(
      'div',
      { class: 'row' },
      h('strong', {}, PROVIDER[p]),
      h('span', { class: `badge b-${ready ? 'ok' : installed ? 'corriendo' : 'error'}` }, ready ? 'listo' : installed ? 'falta iniciar sesión' : 'no instalado'),
    ),
    check ? h('p', { class: 'muted small' }, check.detail) : null,
    p === 'codex' && !ready ? h('p', { class: 'muted small' }, 'Opcional: con Claude ya puedes trabajar. Con los dos, Forja reparte el trabajo y uno revisa al otro.') : null,
    busy
      ? null
      : !installed
        ? btn(`Instalar ${PROVIDER[p]}`, () => mutate('POST', `/v1/sistema/proveedores/${p}/instalar`))
        : btn(ready ? 'Volver a iniciar sesión' : 'Iniciar sesión', () => mutate('POST', `/v1/sistema/proveedores/${p}/sesion`), !ready),
    loginBox(p, session),
  );
}

function modelsForm(cfg) {
  if (!cfg) return h('p', { class: 'muted' }, 'Elige un proyecto para configurar qué modelos usa cada rol.');
  state.cfgDraft ??= { roles: Object.fromEntries(cfg.roles.map((r) => [r.rol, [...r.modelos]])), paralelo: cfg.paralelo };
  const draft = state.cfgDraft;
  const set = (rol, i) => (e) => {
    draft.roles[rol][i] = e.target.value.trim();
  };
  const rows = cfg.roles.map((r) => {
    const a = h('input', { type: 'text', list: 'modelos', 'aria-label': `${r.rol}: principal`, oninput: set(r.rol, 0) });
    const b = h('input', { type: 'text', list: 'modelos', 'aria-label': `${r.rol}: respaldo`, placeholder: 'respaldo (opcional)', oninput: set(r.rol, 1) });
    a.value = draft.roles[r.rol][0] || '';
    b.value = draft.roles[r.rol][1] || '';
    return h('div', { class: 'role' }, h('div', {}, h('strong', {}, r.rol), h('p', { class: 'muted small' }, r.ayuda)), h('div', { class: 'stack' }, a, b));
  });
  const par = h('input', { type: 'number', min: 1, max: 16, 'aria-label': 'Agentes en paralelo', oninput: (e) => (draft.paralelo = Number(e.target.value)) });
  par.value = String(draft.paralelo);
  return card(
    h('datalist', { id: 'modelos' }, ...cfg.sugerencias.map((m) => h('option', { value: m }))),
    ...rows,
    field('Agentes trabajando a la vez', par, 'Más agentes terminan antes pero consumen tu cuota más rápido.'),
    h(
      'div',
      { class: 'row' },
      btn('Guardar', async () => {
        const roles = Object.fromEntries(Object.entries(draft.roles).map(([k, v]) => [k, v.filter(Boolean)]));
        const r = await mutate('POST', '/v1/configuracion', { roles, paralelo: draft.paralelo });
        if (r) {
          state.cfgDraft = null;
          await onProjectChanged('configuracion');
        }
      }),
      btn('Probar estos modelos', () => startJob('conformidad', 'Hace una llamada corta a cada modelo configurado para comprobar que funciona (consume poca cuota). ¿Seguir?'), false),
    ),
  );
}

function renderConfiguracion(d) {
  const checks = d.sys.checks || [];
  const byId = (id) => checks.find((c) => c.id === id);
  const others = checks.filter((c) => c.id !== 'claude' && c.id !== 'codex');
  const summary = { ok: 'Todo listo para trabajar.', aviso: 'Se puede trabajar, con avisos.', error: 'Falta algo para poder trabajar.' }[d.sys.estado];
  return [
    h('h1', {}, 'Configuración'),
    h('p', { class: `state s-${d.sys.estado === 'error' ? 'bloqueada' : d.sys.estado === 'ok' ? 'integrada' : 'esperando_respuesta'}` }, summary),
    h('h2', {}, 'Proveedores de IA'),
    h('div', { class: 'grid' }, providerCard('claude', byId('claude'), d.sys.sesiones?.claude), providerCard('codex', byId('codex'), d.sys.sesiones?.codex)),
    jobCard(d.sys.trabajo, d.salida, '/v1/sistema/trabajos'),
    h('h2', {}, 'Modelos de este proyecto'),
    modelsForm(d.cfg),
    h('h2', {}, 'Tu máquina'),
    card(
      ...others.map((c) =>
        h(
          'div',
          { class: 'check' },
          h('span', { class: `state s-${c.level === 'ok' ? 'integrada' : c.level === 'error' ? 'bloqueada' : 'esperando_respuesta'}` }, ICON[c.level]),
          h('strong', {}, c.title),
          h('span', { class: 'muted' }, c.detail),
          c.fix && c.level !== 'ok' ? h('div', { class: 'muted small' }, `→ ${c.fix}`) : null,
        ),
      ),
      btn(
        'Volver a revisar',
        () => {
          state.refreshSystem = true;
          void refresh(true);
        },
        false,
      ),
    ),
  ];
}

// ---------- registro de pantallas ----------

VIEWS.unshift(
  { id: 'inicio', title: 'Inicio', module: 'trabajos', load: loadInicio, render: renderInicio },
  { id: 'proyectos', title: 'Proyectos', module: 'proyectos', load: loadProyectos, render: renderProyectos },
  { id: 'configuracion', title: 'Configuración', module: 'sistema', load: loadConfiguracion, render: renderConfiguracion },
);

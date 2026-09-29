// Forma de las respuestas de /v1 que usa el panel (ver src/api/modules en el servidor).

export type Mutation = { ok?: boolean; mensaje?: string };

export type Textos = {
  estadoTarea: Record<string, string>;
  fases: [string, string][];
  pendiente: Record<string, string>;
  estadoAccion: Record<string, string>;
  origenDato: Record<string, string>;
  modoDemo: string;
};

export type Modulos = { modulos: string[]; proyecto: string | null };

// ---------- proyectos ----------

export type Proyecto = { id: string; nombre: string; ruta: string; ruta_windows: string | null; existe: boolean; usado: string | null; actual: boolean };
export type Proyectos = { actual: string | null; wsl: boolean; proyectos: Proyecto[] };
export type Carpeta = { nombre: string; ruta: string; ruta_windows: string | null; repo: boolean };
export type Carpetas = { ruta: string; ruta_windows: string | null; padre: string | null; repo: boolean; raices: Carpeta[]; carpetas: Carpeta[] };
export type Importado = Mutation & {
  requiere_confianza?: boolean;
  ruta?: string;
  ruta_windows?: string | null;
  proyecto?: { id: string; nombre: string };
  avisos?: string[];
  bloqueos?: string[];
};

// ---------- trabajos ----------

export type JobState = 'corriendo' | 'ok' | 'error' | 'cancelado' | 'interrumpido';
export type Trabajo = { id: string; tipo: string; titulo: string; estado: JobState; ultima_linea?: string | null };
export type Trabajos = { trabajos: Trabajo[]; tipos: string[] };
export type TrabajoDetalle = Trabajo & { salida: string[] };

// ---------- sistema y configuración ----------

export type Level = 'ok' | 'aviso' | 'error';
export type Check = { id: string; title: string; level: Level; detail: string; fix?: string };
export type LoginState = {
  estado: 'iniciando' | 'esperando' | 'listo' | 'error' | 'cancelado';
  url?: string | null;
  pide_codigo?: boolean;
  mensaje?: string | null;
  /** Last lines of the CLI (a device code for Codex on a server shows up here). */
  salida?: string[];
};
export type Sistema = {
  estado: Level;
  checks: Check[];
  trabajo: Trabajo | null;
  sesiones: { claude?: LoginState | null; codex?: LoginState | null };
};

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type CatalogModel = {
  ref: string;
  proveedor: 'claude' | 'codex';
  nombre: string;
  descripcion: string;
  esfuerzos: Effort[];
  nivel: 'tope' | 'alto' | 'medio' | 'economico';
  estado: 'actual' | 'anterior' | 'retirandose';
  alias: boolean;
  contexto: string | null;
  se_retira: string | null;
};
export type RoleName = 'planeador' | 'trabajador' | 'complejo' | 'revisor' | 'integrador' | 'auditor' | 'qa';
export type Configuracion = {
  roles: { rol: RoleName; modelos: string[]; esfuerzo: Effort | null; ayuda: string }[];
  paralelo: number;
  sugerencias: string[];
  catalogo: { modelos: CatalogModel[]; esfuerzos: { id: Effort; nombre: string }[] };
};

// ---------- planeación ----------

export type Pregunta = { id: string; texto: string; respuesta?: string | null; recomendacion?: string | null; bloquea?: string[] };
export type Turno = { usuario: string | null; planeador: string; modelo: string };
export type Descubrimiento = {
  revision: number;
  aprobado: boolean;
  resumen: string | null;
  alcance: { incluye: string[]; excluye: string[] };
  decisiones: { id: string; contenido: string; estado: string }[];
  preguntas_abiertas: { id: string; texto: string; recomendacion?: string | null }[];
  bloqueos: string[];
};
export type Estimacion = { minutos_en_paralelo: number; minutos_en_serie: number; paralelo: number; tokens_total: number; costo_equivalente_usd: number | null };
export type Comando = { executable: string; args: string[] };
export type PlanTarea = { id: string; titulo: string; tipo: string; complejidad: string; depende_de: string[]; escribe: string[] };
export type Plan = {
  revision: number;
  aprobado: boolean;
  tareas: PlanTarea[];
  olas: string[][];
  estimacion: Estimacion;
  perfil: { stack: string[]; comandos: Partial<Record<string, Comando>> };
  supuestos: string[];
  problemas_para_aprobar: (string | { mensaje?: string })[];
};
export type Especificacion = {
  revision: number;
  sistema: { objetivo: string };
  casos_uso: { id: string; nombre: string; objetivo: string }[];
  criterios: number;
  problemas: { message: string }[];
  preguntas: Pregunta[];
};
export type Planeacion = {
  cambio: { titulo: string; fase: string } | null;
  descubrimiento: Descubrimiento;
  conversacion: Turno[];
  especificacion: Especificacion | null;
  plan: Plan | null;
  chat?: { pensando: { texto: string } | null; error: string | null; planeador: string };
};

// ---------- ejecución ----------

export type Actividad = { startedAt?: string; tokens?: number | null; tokensKind?: 'medido' | 'estimado' | 'desconocido'; current?: string | null };
export type Tarea = {
  id: string;
  titulo: string;
  estado: string;
  modelo: string | null;
  intento: number;
  actividad?: Actividad;
  pregunta?: string | null;
  error?: string | null;
};
export type Pendiente = { id: string; kind: string; text: string; action: string };
export type Consumo = { role: string; calls: number; tokens: number | null; costMicro: number | null; costKind: string };
export type Estado = {
  cambio: { titulo: string; fase: string } | null;
  run: { estado: string; activo: boolean; detalle?: string | null } | null;
  progreso: { integradas: number; total: number; minutos_restantes?: number | null; factor_medido?: number | null };
  tareas: Tarea[];
  pendientes: Pendiente[];
  consumo: Consumo[];
  registro?: string[];
  siguiente: string;
  entrega: string | null;
  modo_demo?: boolean;
  proveedores_en_pausa?: { proveedor: string; hasta: string; motivo: string }[];
};
export type TareaDetalle = { detalle?: string[]; registro?: string[]; instrucciones?: string[] };

// ---------- conexiones, acciones y memoria ----------

export type Vinculo = { connection: string; active: boolean; version: number; operations: string[] };
export type Conexiones = {
  conexiones: { name: string; version: number; base_url: string; secret: string | null; idempotent: boolean }[];
  mcp: { name: string; version: number; declared_version: string; command: string; tools: string[] }[];
  vinculos: Vinculo[];
};
export type Accion = {
  action_id: string;
  type: string;
  connection: string;
  view_state: string;
  preview: Record<string, unknown>;
  origin: string;
  hash: string;
  result?: { detail?: string } | null;
};
export type Auditoria = { cuando: string; que: string; sobre: string; detalle: string };
export type Leccion = { lesson_id: string; state: string; text: string; evidence: unknown };
export type Memoria = {
  modo: 'simple' | 'grafo';
  construido: string | null;
  fuente: string | null;
  grafo: { nodos: Record<string, number>; aristas: Record<string, number>; posibles: number };
  lecciones: Leccion[];
};
export type Nodo = {
  id: string;
  kind: string;
  label: string;
  salen: { kind: string; dst: string; confidence: string }[];
  entran: { kind: string; src: string; confidence: string }[];
};

// ---------- v3: siguiente acción, agentes, cuentas, correo, historial y calidad ----------

export type SiguienteAccion = { accion: string; titulo: string; motivo: string; vista: 'sprint' | 'tablero' | 'calidad' | 'historial'; urgente: boolean };
export type TareaV3 = Tarea & { tipo?: string | null; depende_de?: string[]; rol?: string | null; cuenta?: string | null; resumen?: string | null; fallos_calidad?: number };
export type EstadoV3 = Omit<Estado, 'tareas'> & { tareas: TareaV3[]; siguiente_accion?: SiguienteAccion };

export type RolAgente = {
  id: 'orquestador' | 'implementador' | 'integrador' | 'revisor' | 'auditor' | 'qa';
  titulo: string;
  descripcion: string;
  roles_forja: string[];
  modelos: string[];
  esfuerzo: Effort | null;
  estado: 'activo' | 'inactivo';
  trabajando: { tarea: string; titulo: string; modelo: string | null; cuenta: string | null; desde: string | null; actividad: string | null }[];
  otra_actividad: string | null;
  llamadas: number;
  tokens: number | null;
};
export type CuentaAgentes = { proveedor: 'claude' | 'codex'; alias: string; activa: boolean; sesion: boolean; en_pausa: boolean; max_agentes: number | null; en_curso: number };
export type Agentes = { roles: RolAgente[]; cuentas: CuentaAgentes[] };

export type Cuenta = {
  proveedor: 'claude' | 'codex';
  alias: string;
  activa: boolean;
  max_agentes: number | null;
  principal: boolean;
  sesion_iniciada: boolean;
  carpeta: string;
  inicio_sesion: (LoginState & { cuenta?: string }) | null;
};

export type AvisoTipo = 'chat' | 'trabajos' | 'runs' | 'pendientes' | 'observaciones';
export type Correo = {
  activo: boolean;
  host: string;
  puerto: number;
  seguridad: 'tls' | 'starttls' | 'ninguna';
  usuario: string;
  remitente: string;
  nombre_remitente: string;
  destinatario: string;
  avisos: Partial<Record<AvisoTipo, boolean>>;
  clave_guardada: boolean;
  desde_entorno: boolean;
  avisos_disponibles: { id: AvisoTipo; texto: string }[];
};

export type Marca = 'unida' | 'en_curso' | 'pendiente' | 'bloqueada' | 'cancelada';
export type HistTarea = {
  id: string;
  titulo: string;
  estado: string;
  marca: Marca;
  rol: string | null;
  cuenta: string | null;
  inicio: string | null;
  fin: string | null;
  intentos: number;
  resumen: string | null;
};
export type HistHistoria = { id: string; titulo: string; tareas: HistTarea[]; hechas: number; total: number };
export type HistSprint = {
  id: string;
  titulo: string;
  fase: string;
  creado: string;
  entregado: string | null;
  prioridad: number;
  fecha_objetivo: string | null;
  retrasado: boolean;
  historias: HistHistoria[];
  hechas: number;
  total: number;
};
export type HistEpica = { id: string | null; titulo: string; objetivo: string; estado: string; fecha_objetivo: string | null; sprints: HistSprint[]; hechas: number; total: number };
export type EventoCalendario = {
  fecha: string;
  tipo: 'sprint_creado' | 'sprint_entregado' | 'tarea_iniciada' | 'tarea_unida' | 'tarea_bloqueada';
  sprint: string;
  tarea: string | null;
  titulo: string;
};
export type Historial = { epicas: HistEpica[]; calendario: EventoCalendario[] };
export type Epica = { epic_id: string; title: string; goal: string; state: string; target_date: string | null; created_at: string };

export type EstadoObs = 'abierta' | 'en_plan' | 'en_correccion' | 'resuelta' | 'descartada' | 'pospuesta';
export type Observacion = {
  obs_id: string;
  change_id: string;
  run_id: string | null;
  task_id: string | null;
  source: 'revisor' | 'auditor' | 'qa' | 'verificacion';
  severity: 'critica' | 'alta' | 'media' | 'baja';
  kind: 'defecto' | 'sugerencia' | 'requisito_nuevo';
  location: string;
  text: string;
  evidence: string | null;
  commit_sha: string | null;
  state: EstadoObs;
  reason: string | null;
  plan_change: string | null;
  created_at: string;
};
export type Observaciones = {
  lista: Observacion[];
  conteo: Record<EstadoObs, number>;
  validacion?: { id: string; commit: string; fecha: string; observaciones: number; comprobaciones: { paso: string; ok: boolean | null }[] } | null;
};

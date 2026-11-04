<script lang="ts">
  import './estilos/u1.css';
  import { onMount, tick } from 'svelte';
  import { spd } from './api.ts';
  import type { EstadoSistema, UsuarioPublico, EstadoCopias, PacienteResumen, MedicamentoDto } from '../servicios/api.ts';
  import { ruta, ir } from './router.ts';
  import { aplicarAspecto, leerAspecto, nombreRol, mensajeError, type Aspecto } from './componentes/util.ts';
  import { limpiarEfimero } from './lib/efimero.ts';
  import { pausasBloqueo } from './lib/inactividad.ts';
  import { aplicarEstado, type AvisoBasico } from '../dominio/avisos.ts';
  import { estadoAvisos, sacarAviso } from './lib/avisos.ts';
  import { get } from 'svelte/store';
  import Icono from './componentes/Icono.svelte';
  import Aviso from './componentes/Aviso.svelte';
  import Cargando from './componentes/Cargando.svelte';
  import Tostadas from './componentes/Tostadas.svelte';
  import InicioSesion from './componentes/InicioSesion.svelte';
  import PrimerUso from './pantallas/PrimerUso.svelte';
  import Desbloqueo from './pantallas/Desbloqueo.svelte';
  import Hoy from './pantallas/Hoy.svelte';
  import Pacientes from './pantallas/Pacientes.svelte';
  import FichaPaciente from './pantallas/FichaPaciente.svelte';
  import Ajustes from './pantallas/Ajustes.svelte';
  import Cajas from './pantallas/Cajas.svelte';
  import Preparar from './pantallas/Preparar.svelte';
  import Medicamentos from './pantallas/Medicamentos.svelte';
  import Auditoria from './pantallas/Auditoria.svelte';
  import NoEncontrado from './pantallas/NoEncontrado.svelte';

  let estado = $state<EstadoSistema | null>(null);
  let sinConexion = $state<string | null>(null);
  let primerUsoEnCurso = $state(false);
  let aspecto = $state<Aspecto>(leerAspecto());
  let copias = $state<EstadoCopias | null>(null);
  /** Distintivo informativo: se puede quitar (y se recuerda sólo su tipo, nunca datos de pacientes). */
  const AVISO_COPIA: AvisoBasico = { tipo: 'copia_atrasada', gravedad: 'atencion' };
  let version = $state(0); // sube cuando algo cambia fuera de la pantalla (p. ej. Ajustes)

  // Tema realmente aplicado (el «auto» sigue al sistema): el botón de la barra lo refleja al instante.
  let oscuro = $state(false);
  $effect(() => { aplicarAspecto(aspecto); oscuro = document.documentElement.dataset.tema === 'oscuro'; });
  $effect(() => {
    if (aspecto.tema !== 'auto' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const alCambiar = () => { aplicarAspecto(aspecto); oscuro = document.documentElement.dataset.tema === 'oscuro'; };
    mq.addEventListener?.('change', alCambiar);
    return () => mq.removeEventListener?.('change', alCambiar);
  });

  async function cargarEstado() {
    const r = await spd.estado();
    if (!r.ok) { sinConexion = mensajeError(r); return; }
    sinConexion = null; estado = r.datos;
    if (!r.datos.inicializado) primerUsoEnCurso = true;
    // Sin contraseña de arranque los datos se abren solos con el usuario de Windows (una vez; si falla, Desbloqueo explica y ofrece la clave de recuperación).
    if (r.datos.inicializado && !r.datos.desbloqueado && r.datos.modoAcceso === 'sistema' && !intentadoSistema) { intentadoSistema = true; void abrirConSistema(); }
  }
  let intentadoSistema = false;
  let abriendoSistema = $state(false); let errorSistema = $state<string | null>(null);
  async function abrirConSistema() {
    abriendoSistema = true; errorSistema = null;
    const r = await spd.desbloquearConSistema();
    abriendoSistema = false;
    if (r.ok) { estado = r.datos; await cargarEstado(); } else errorSistema = r.error;
  }
  onMount(() => {
    limpiarEfimero();   // restos de versiones anteriores que dejaban datos de pacientes en localStorage
    cargarEstado();
    // El proceso principal avisa (bloqueo por inactividad, menú «Bloquear»): se relee el estado.
    const alEstado = () => { void cargarEstado(); };
    window.addEventListener('spd:estado', alEstado);
    return () => window.removeEventListener('spd:estado', alEstado);
  });

  const NAV = [
    { id: 'hoy', texto: 'Hoy', icono: 'hoy' }, { id: 'pacientes', texto: 'Pacientes', icono: 'pacientes' },
    { id: 'cajas', texto: 'Cajas', icono: 'cajas' }, { id: 'preparar', texto: 'Preparar', icono: 'preparar' },
    { id: 'medicamentos', texto: 'Medicamentos', icono: 'medicamentos' }, { id: 'auditoria', texto: 'Auditoría', icono: 'auditoria' },
    { id: 'ajustes', texto: 'Ajustes', icono: 'ajustes' },
  ] as const;
  const activa = $derived(NAV.some(n => n.id === $ruta.nombre) ? $ruta.nombre : 'hoy');

  // ───── Título de la ventana y foco al cambiar de pantalla ─────
  const TITULOS: Record<string, string> = { hoy: 'Hoy', pacientes: 'Pacientes', cajas: 'Entrada de cajas', preparar: 'Preparar un blíster', medicamentos: 'Medicamentos', auditoria: 'Auditoría', ajustes: 'Ajustes' };
  const SECCIONES_AJUSTES: Record<string, string> = { farmacia: 'Farmacia', usuarios: 'Usuarios', momentos: 'Momentos de toma', validez: 'Validez del SPD', blister: 'Disposición del blíster', lector: 'Lector de códigos', impresoras: 'Impresoras', copias: 'Copias de seguridad', actualizaciones: 'Actualizaciones', seguridad: 'Seguridad', aspecto: 'Aspecto', acerca: 'Acerca de' };
  const tituloVentana = $derived.by(() => {
    if (sinConexion) return 'No se puede abrir SPD';
    if (!estado) return 'Abriendo SPD';
    if (primerUsoEnCurso) return 'Primer uso';
    if (!estado.desbloqueado) return 'Programa bloqueado';
    if (!estado.sesion) return '¿Quién eres?';
    if ($ruta.nombre === 'pacientes') return $ruta.id !== undefined ? 'Ficha del paciente' : $ruta.resto.length ? 'Paciente no encontrado' : 'Pacientes';
    if ($ruta.nombre === 'ajustes') return 'Ajustes' + (SECCIONES_AJUSTES[$ruta.resto[0] ?? ''] ? ' · ' + SECCIONES_AJUSTES[$ruta.resto[0]!] : '');
    return TITULOS[$ruta.nombre] ?? 'Hoy';
  });
  $effect(() => { document.title = tituloVentana + ' · SPD'; });
  // Al cambiar de pantalla el foco pasa al título (lo que ven y oyen quienes no usan el ratón). Si la pantalla ya ha puesto el foco en uno de sus
  // campos (p. ej. el de escaneo de cajas), no se le quita.
  let rutaAnterior: string | null = null;
  $effect(() => {
    const clave = $ruta.nombre + ':' + ($ruta.id ?? '');
    if (!enSesion) { rutaAnterior = null; return; }
    if (rutaAnterior === null) { rutaAnterior = clave; return; }
    if (rutaAnterior === clave) return;
    rutaAnterior = clave;
    void tick().then(() => setTimeout(() => {
      const act = document.activeElement;
      if (act && act !== document.body && document.getElementById('contenido')?.contains(act)) return;
      const h1 = document.querySelector<HTMLElement>('#contenido h1');
      if (h1) { h1.tabIndex = -1; h1.focus({ preventScroll: true }); } else document.getElementById('contenido')?.focus({ preventScroll: true });
    }, 60));
  });
  function saltarAlContenido() { const c = document.getElementById('contenido'); const h1 = c?.querySelector<HTMLElement>('h1'); if (h1) { h1.tabIndex = -1; h1.focus(); } else c?.focus(); }

  // ───── Copias y bloqueo por inactividad (sólo con sesión) ─────
  const enSesion = $derived(!!estado?.desbloqueado && !!estado.sesion);
  // Sin sesión (bloqueado, o cerrada) no queda nada de pacientes en la interfaz.
  $effect(() => { if (estado && !enSesion) limpiarEfimero(); });
  $effect(() => {
    if (!enSesion) return;
    void version;
    const cargar = () => spd.estadoCopias().then(r => { if (r.ok) copias = r.datos; });
    cargar(); const t = setInterval(cargar, 5 * 60_000); return () => clearInterval(t);
  });
  // Bloqueo por inactividad. El plazo (minutos) se relee cada vez que Ajustes lo cambia (`version`): no hace falta recargar.
  // Mientras algo no se pueda perder (la clave de recuperación nueva), no se cuenta inactividad (lib/inactividad.ts).
  const AVISO_SEG = 30;
  let minutosBloqueo = $state(0); let segundosParaBloqueo = $state<number | null>(null);
  let ultimoMovimiento = Date.now();
  $effect(() => {
    if (!enSesion) return;
    void version;
    let vigente = true;
    spd.obtenerAjustes().then(r => { if (vigente && r.ok) minutosBloqueo = r.datos.bloqueoMinutos; });
    return () => { vigente = false; };
  });
  $effect(() => {
    if (!enSesion) return;
    ultimoMovimiento = Date.now();
    const EVENTOS = ['mousemove', 'pointerdown', 'keydown', 'click', 'wheel', 'touchstart'];
    const mover = () => { ultimoMovimiento = Date.now(); };
    for (const ev of EVENTOS) window.addEventListener(ev, mover, { passive: true });
    return () => { for (const ev of EVENTOS) window.removeEventListener(ev, mover); };
  });
  $effect(() => {
    if (!enSesion) { segundosParaBloqueo = null; return; }
    const minutos = minutosBloqueo;
    const t = setInterval(() => {
      if (get(pausasBloqueo) > 0) { ultimoMovimiento = Date.now(); segundosParaBloqueo = null; return; }
      if (!(minutos > 0)) { segundosParaBloqueo = null; return; }
      const restante = minutos * 60_000 - (Date.now() - ultimoMovimiento);
      if (restante <= 0) { segundosParaBloqueo = null; void bloquear(); }
      else segundosParaBloqueo = restante <= AVISO_SEG * 1000 ? Math.ceil(restante / 1000) : null;
    }, 1000);
    return () => { clearInterval(t); segundosParaBloqueo = null; };
  });
  function seguirTrabajando() { ultimoMovimiento = Date.now(); segundosParaBloqueo = null; }
  async function bloquear() { limpiarEfimero(); await spd.bloquear(); await cargarEstado(); }
  async function alentrarUsuario(u: UsuarioPublico) { if (estado) estado = { ...estado, sesion: u }; await cargarEstado(); if (!location.hash) ir('hoy'); }

  // ───── Primer uso: al terminar entra directamente (la contraseña acaba de escribirse) ─────
  async function primerUsoTerminado(contrasena: string, pin: string) {
    primerUsoEnCurso = false;
    await cargarEstado();
    if (estado && !estado.desbloqueado) { const d = contrasena ? await spd.desbloquear(contrasena) : await spd.desbloquearConSistema(); if (d.ok) estado = d.datos; }
    if (estado?.desbloqueado && !estado.sesion) {
      const l = await spd.listarUsuarios();
      const t = l.ok ? (l.datos.find(u => u.rol === 'titular') ?? l.datos[0]) : undefined;
      if (t) await spd.iniciarSesion(t.id, pin);
    }
    await cargarEstado(); ir('hoy');
  }

  // ───── Buscador global (combobox ARIA 1.2: el foco se queda en el campo y aria-activedescendant señala la opción) ─────
  let texto = $state(''); let abierto = $state(false); let buscando = $state(false);
  let rPac = $state<PacienteResumen[]>([]); let rMed = $state<MedicamentoDto[]>([]); let sel = $state(0);
  let cajaBuscar: HTMLInputElement | undefined = $state();
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const lista = $derived([
    ...rPac.map(p => ({ clave: 'p' + p.id, etiqueta: p.nombreCompleto, detalle: p.centro ?? '', destino: `pacientes/${p.id}` })),
    ...rMed.map(m => ({ clave: 'm' + m.cn, etiqueta: m.nombre, detalle: 'CN ' + m.cn, destino: 'medicamentos' })),
  ]);
  const idOpcion = (i: number) => `res-opt-${i}`;
  // Texto para el lector de pantalla: cuántos resultados hay (o que no hay) cada vez que cambian.
  const anuncio = $derived(!abierto ? '' : buscando && !lista.length ? 'Buscando…'
    : !lista.length ? `Sin resultados para ${texto.trim()}.`
    : `${lista.length} ${lista.length === 1 ? 'resultado' : 'resultados'}: ${rPac.length} ${rPac.length === 1 ? 'paciente' : 'pacientes'} y ${rMed.length} ${rMed.length === 1 ? 'medicamento' : 'medicamentos'}. Usa las flechas arriba y abajo.`);
  $effect(() => { if (abierto && lista.length) document.getElementById(idOpcion(sel))?.scrollIntoView({ block: 'nearest' }); });
  function alEscribir() {
    clearTimeout(temporizador); sel = 0;
    const t = texto.trim();
    if (t.length < 2) { abierto = false; rPac = []; rMed = []; return; }
    buscando = true; abierto = true;
    temporizador = setTimeout(async () => {
      const [a, b] = await Promise.all([spd.listarPacientes({ texto: t, estado: 'todos' }), spd.buscarMedicamentos(t)]);
      rPac = a.ok ? a.datos.slice(0, 6) : []; rMed = b.ok ? b.datos.slice(0, 6) : []; buscando = false;
    }, 200);
  }
  function elegir(i: number) { const it = lista[i]; if (!it) return; ir(it.destino); texto = ''; abierto = false; rPac = []; rMed = []; cajaBuscar?.blur(); }
  function teclaBuscador(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!abierto && texto.trim().length >= 2) abierto = true; else sel = Math.min(sel + 1, lista.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); }
    else if (e.key === 'Enter') { if (abierto && lista.length) { e.preventDefault(); elegir(sel); } }
    else if (e.key === 'Escape') { if (abierto) { e.preventDefault(); abierto = false; } else texto = ''; }
  }
  function atajos(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    const escribiendo = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName);
    if ((e.ctrlKey && e.key.toLowerCase() === 'k') || (e.key === '/' && !escribiendo)) { e.preventDefault(); cajaBuscar?.focus(); }
  }
  function alternarTema() { aspecto = { ...aspecto, tema: oscuro ? 'claro' : 'oscuro' }; }
  function cambiaAspecto(a: Aspecto) { aspecto = a; }
</script>

<svelte:window onkeydown={atajos} />
<Tostadas />

{#if sinConexion}
  <div class="pantalla-central"><div class="caja tarjeta apilado">
    <h1>No se puede abrir SPD</h1><p>{sinConexion}</p>
    <button class="btn principal" onclick={cargarEstado}>Reintentar</button>
  </div></div>
{:else if !estado}
  <div class="pantalla-central"><Cargando texto="Abriendo SPD…" /></div>
{:else if primerUsoEnCurso}
  <PrimerUso onterminado={primerUsoTerminado} />
{:else if !estado.desbloqueado}
  <Desbloqueo {estado} {abriendoSistema} {errorSistema} reintentar={abrirConSistema} ondesbloqueado={(e) => { estado = e; cargarEstado(); }} />
{:else if !estado.sesion}
  <InicioSesion alentrar={alentrarUsuario} />
{:else}
  <button class="saltar" type="button" onclick={saltarAlContenido}>Saltar al contenido</button>
  {#if segundosParaBloqueo !== null}
    <div class="aviso-bloqueo">
      <div class="aviso atencion" role="alert">
        <span class="icono"><Icono n="alerta" tam={20} /></span>
        <div class="cuerpo"><strong>El programa se bloqueará en menos de 30 segundos por inactividad.</strong>
          Guarda lo que estés escribiendo: al bloquear se descartan los datos sin guardar.
          <div class="fila"><button class="btn principal" type="button" onclick={seguirTrabajando}>Seguir trabajando</button>
            <span class="suave" aria-hidden="true">Quedan {segundosParaBloqueo} s</span></div></div>
      </div>
    </div>
  {/if}
  <div class="app">
    <aside class="lateral" aria-label="Menú principal">
      <div class="marca">SPD</div>
      <nav class="apilado" style="display:flex;flex-direction:column;gap:.25rem">
        {#each NAV as n (n.id)}
          <a class="nav" class:activo={activa === n.id} href="#/{n.id}" aria-current={activa === n.id ? 'page' : undefined}><Icono n={n.icono} />{n.texto}</a>
        {/each}
      </nav>
      <div class="pie-lateral">Versión {estado.version}<br>Atajo de búsqueda: <kbd>/</kbd></div>
    </aside>
    <div class="principal">
      <header class="barra">
        <div class="buscador">
          <Icono n="buscar" tam={18} />
          <input type="search" bind:this={cajaBuscar} bind:value={texto} oninput={alEscribir} onkeydown={teclaBuscador} onblur={() => setTimeout(() => (abierto = false), 150)} onfocus={() => { if (texto.trim().length >= 2) abierto = true; }}
            placeholder="Buscar paciente o medicamento" aria-label="Buscar paciente o medicamento" role="combobox" aria-expanded={abierto && lista.length > 0} aria-haspopup="listbox"
            aria-controls="res-global" aria-autocomplete="list" aria-activedescendant={abierto && lista.length ? idOpcion(sel) : undefined} autocomplete="off" />
          <div class="solo-lectores" role="status" aria-live="polite">{anuncio}</div>
          {#if abierto}
            <div class="resultados" id="res-global" role={lista.length ? 'listbox' : undefined} aria-label={lista.length ? 'Resultados de la búsqueda' : undefined}>
              {#if buscando && !lista.length}<div class="vacio" style="padding:1rem">Buscando…</div>
              {:else if !lista.length}<div class="vacio" style="padding:1rem">No hay nada con «{texto.trim()}».</div>
              {:else}
                {#if rPac.length}
                  <div role="group" aria-labelledby="res-g-pac"><div class="tit" id="res-g-pac">Pacientes</div>
                    {#each rPac as _p, i (lista[i]!.clave)}
                      <button type="button" tabindex="-1" id={idOpcion(i)} role="option" aria-selected={i === sel} class:sel={i === sel} onmousedown={(e) => { e.preventDefault(); elegir(i); }}>
                        <strong>{lista[i]!.etiqueta}</strong> <span class="suave pequeno">{lista[i]!.detalle}</span></button>
                    {/each}</div>
                {/if}
                {#if rMed.length}
                  <div role="group" aria-labelledby="res-g-med"><div class="tit" id="res-g-med">Medicamentos</div>
                    {#each rMed as _m, j (lista[rPac.length + j]!.clave)}
                      {@const i = rPac.length + j}
                      <button type="button" tabindex="-1" id={idOpcion(i)} role="option" aria-selected={i === sel} class:sel={i === sel} onmousedown={(e) => { e.preventDefault(); elegir(i); }}>
                        <strong>{lista[i]!.etiqueta}</strong> <span class="suave pequeno">{lista[i]!.detalle}</span></button>
                    {/each}</div>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
        {#if copias?.atrasada && aplicarEstado([AVISO_COPIA], $estadoAvisos).visibles.length}
          <span class="fila" style="gap:.2rem">
            <a class="etiqueta atencion" href="#/ajustes/copias" style="text-decoration:none"><Icono n="alerta" tam={14} /> Copia de seguridad atrasada</a>
            <button class="btn enlace" type="button" onclick={() => sacarAviso(AVISO_COPIA)} aria-label="Quitar el aviso de copia de seguridad atrasada" title="Quitar este aviso"><Icono n="x" tam={14} /></button>
          </span>
        {/if}
        <span class="espacio"></span>
        <button class="btn enlace" onclick={alternarTema} aria-label={oscuro ? 'Tema oscuro activado. Cambiar a tema claro' : 'Tema claro activado. Cambiar a tema oscuro'} title={oscuro ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}><Icono n={oscuro ? 'sol' : 'luna'} /></button>
        <div class="usuario-barra">
          <span class="avatar" aria-hidden="true">{estado.sesion.iniciales}</span>
          <div style="line-height:1.2"><strong>{estado.sesion.nombre}</strong><br><span class="suave pequeno">{nombreRol(estado.sesion.rol)}</span></div>
          <button class="btn" onclick={bloquear}><Icono n="bloquear" tam={18} />{estado.modoAcceso === 'sistema' ? 'Cambiar de usuario' : 'Bloquear'}</button>
        </div>
      </header>
      {#if estado.avisoSeguridad}<Aviso tipo="bloqueo" titulo="Aviso de seguridad">{estado.avisoSeguridad}</Aviso>{/if}
      <main class="contenido" id="contenido" tabindex="-1">
        <div class="ancho">
          {#key $ruta.nombre + ':' + ($ruta.id ?? '')}
            {#if $ruta.nombre === 'pacientes' && $ruta.id !== undefined}<FichaPaciente id={$ruta.id} pestana={$ruta.resto[0]} rol={estado.sesion.rol} />
            {:else if $ruta.nombre === 'pacientes' && $ruta.resto.length}<NoEncontrado />
            {:else if $ruta.nombre === 'pacientes'}<Pacientes />
            {:else if $ruta.nombre === 'cajas'}<Cajas pacienteId={$ruta.id} />
            {:else if $ruta.nombre === 'preparar'}<Preparar pacienteId={$ruta.id} />
            {:else if $ruta.nombre === 'medicamentos'}<Medicamentos />
            {:else if $ruta.nombre === 'auditoria'}<Auditoria pacienteId={$ruta.id} />
            {:else if $ruta.nombre === 'ajustes'}<Ajustes rol={estado.sesion.rol} seccion={$ruta.resto[0]} {aspecto} {cambiaAspecto} alcambiar={() => version++} alcerrar={bloquear} />
            {:else}<Hoy />{/if}
          {/key}
        </div>
      </main>
    </div>
  </div>
{/if}

<script lang="ts">
  import './estilos/u1.css';
  import { onMount } from 'svelte';
  import { spd } from './api.ts';
  import type { EstadoSistema, UsuarioPublico, EstadoCopias, PacienteResumen, MedicamentoDto } from '../servicios/api.ts';
  import { ruta, ir } from './router.ts';
  import { aplicarAspecto, leerAspecto, nombreRol, mensajeError, type Aspecto } from './componentes/util.ts';
  import Icono from './componentes/Icono.svelte';
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

  let estado = $state<EstadoSistema | null>(null);
  let sinConexion = $state<string | null>(null);
  let primerUsoEnCurso = $state(false);
  let aspecto = $state<Aspecto>(leerAspecto());
  let copias = $state<EstadoCopias | null>(null);
  let version = $state(0); // sube cuando algo cambia fuera de la pantalla (p. ej. Ajustes)

  $effect(() => { aplicarAspecto(aspecto); });

  async function cargarEstado() {
    const r = await spd.estado();
    if (!r.ok) { sinConexion = mensajeError(r); return; }
    sinConexion = null; estado = r.datos;
    if (!r.datos.inicializado) primerUsoEnCurso = true;
  }
  onMount(() => { cargarEstado(); });

  const NAV = [
    { id: 'hoy', texto: 'Hoy', icono: 'hoy' }, { id: 'pacientes', texto: 'Pacientes', icono: 'pacientes' },
    { id: 'cajas', texto: 'Cajas', icono: 'cajas' }, { id: 'preparar', texto: 'Preparar', icono: 'preparar' },
    { id: 'medicamentos', texto: 'Medicamentos', icono: 'medicamentos' }, { id: 'auditoria', texto: 'Auditoría', icono: 'auditoria' },
    { id: 'ajustes', texto: 'Ajustes', icono: 'ajustes' },
  ] as const;
  const activa = $derived(NAV.some(n => n.id === $ruta.nombre) ? $ruta.nombre : 'hoy');

  // ───── Copias y bloqueo por inactividad (sólo con sesión) ─────
  const enSesion = $derived(!!estado?.desbloqueado && !!estado.sesion);
  $effect(() => {
    if (!enSesion) return;
    void version;
    const cargar = () => spd.estadoCopias().then(r => { if (r.ok) copias = r.datos; });
    cargar(); const t = setInterval(cargar, 5 * 60_000); return () => clearInterval(t);
  });
  $effect(() => {
    if (!enSesion) return;
    let minutos = 0; let ultimo = Date.now();
    spd.obtenerAjustes().then(r => { if (r.ok) minutos = r.datos.bloqueoMinutos; });
    const mover = () => { ultimo = Date.now(); };
    for (const ev of ['mousemove', 'keydown', 'click', 'touchstart']) window.addEventListener(ev, mover, { passive: true });
    const t = setInterval(() => { if (minutos > 0 && Date.now() - ultimo > minutos * 60_000) bloquear(); }, 15_000);
    return () => { clearInterval(t); for (const ev of ['mousemove', 'keydown', 'click', 'touchstart']) window.removeEventListener(ev, mover); };
  });
  async function bloquear() { await spd.bloquear(); await cargarEstado(); }
  async function alentrarUsuario(u: UsuarioPublico) { if (estado) estado = { ...estado, sesion: u }; await cargarEstado(); if (!location.hash) ir('hoy'); }

  // ───── Primer uso: al terminar entra directamente (la contraseña acaba de escribirse) ─────
  async function primerUsoTerminado(contrasena: string, pin: string) {
    primerUsoEnCurso = false;
    await cargarEstado();
    if (estado && !estado.desbloqueado) { const d = await spd.desbloquear(contrasena); if (d.ok) estado = d.datos; }
    if (estado?.desbloqueado && !estado.sesion) {
      const l = await spd.listarUsuarios();
      const t = l.ok ? (l.datos.find(u => u.rol === 'titular') ?? l.datos[0]) : undefined;
      if (t) await spd.iniciarSesion(t.id, pin);
    }
    await cargarEstado(); ir('hoy');
  }

  // ───── Buscador global ─────
  let texto = $state(''); let abierto = $state(false); let buscando = $state(false);
  let rPac = $state<PacienteResumen[]>([]); let rMed = $state<MedicamentoDto[]>([]); let sel = $state(0);
  let cajaBuscar: HTMLInputElement | undefined = $state();
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const lista = $derived([
    ...rPac.map(p => ({ clave: 'p' + p.id, etiqueta: p.nombreCompleto, detalle: p.centro ?? '', destino: `pacientes/${p.id}` })),
    ...rMed.map(m => ({ clave: 'm' + m.cn, etiqueta: m.nombre, detalle: 'CN ' + m.cn, destino: 'medicamentos' })),
  ]);
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
  function elegir(i: number) { const it = lista[i]; if (!it) return; ir(it.destino); texto = ''; abierto = false; cajaBuscar?.blur(); }
  function teclaBuscador(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, lista.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); }
    else if (e.key === 'Enter') { e.preventDefault(); elegir(sel); }
    else if (e.key === 'Escape') { texto = ''; abierto = false; }
  }
  function atajos(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    const escribiendo = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName);
    if ((e.ctrlKey && e.key.toLowerCase() === 'k') || (e.key === '/' && !escribiendo)) { e.preventDefault(); cajaBuscar?.focus(); }
  }
  function alternarTema() { aspecto = { ...aspecto, tema: document.documentElement.dataset.tema === 'oscuro' ? 'claro' : 'oscuro' }; }
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
  <Desbloqueo {estado} ondesbloqueado={(e) => { estado = e; cargarEstado(); }} />
{:else if !estado.sesion}
  <InicioSesion alentrar={alentrarUsuario} />
{:else}
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
            placeholder="Buscar paciente o medicamento" aria-label="Buscar paciente o medicamento" role="combobox" aria-expanded={abierto} aria-controls="res-global" autocomplete="off" />
          {#if abierto}
            <div class="resultados" id="res-global" role="listbox">
              {#if buscando && !lista.length}<div class="vacio" style="padding:1rem">Buscando…</div>
              {:else if !lista.length}<div class="vacio" style="padding:1rem">No hay nada con «{texto.trim()}».</div>
              {:else}
                {#if rPac.length}<h4>Pacientes</h4>{/if}
                {#each lista as it, i (it.clave)}
                  {#if i === rPac.length && rMed.length}<h4>Medicamentos</h4>{/if}
                  <button role="option" aria-selected={i === sel} class:sel={i === sel} onmousedown={(e) => { e.preventDefault(); elegir(i); }}>
                    <strong>{it.etiqueta}</strong> <span class="suave pequeno">{it.detalle}</span></button>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
        {#if copias?.atrasada}
          <a class="etiqueta atencion" href="#/ajustes/copias" style="text-decoration:none"><Icono n="alerta" tam={14} /> Copia de seguridad atrasada</a>
        {/if}
        <span class="espacio"></span>
        <button class="btn enlace" onclick={alternarTema} aria-label="Cambiar entre tema claro y oscuro" title="Tema claro / oscuro"><Icono n={document.documentElement.dataset.tema === 'oscuro' ? 'sol' : 'luna'} /></button>
        <div class="usuario-barra">
          <span class="avatar" aria-hidden="true">{estado.sesion.iniciales}</span>
          <div style="line-height:1.2"><strong>{estado.sesion.nombre}</strong><br><span class="suave pequeno">{nombreRol(estado.sesion.rol)}</span></div>
          <button class="btn" onclick={bloquear}><Icono n="bloquear" tam={18} />Bloquear</button>
        </div>
      </header>
      <main class="contenido" id="contenido">
        <div class="ancho">
          {#key $ruta.nombre + ':' + ($ruta.id ?? '')}
            {#if $ruta.nombre === 'pacientes' && $ruta.id !== undefined}<FichaPaciente id={$ruta.id} pestana={$ruta.resto[0]} rol={estado.sesion.rol} />
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

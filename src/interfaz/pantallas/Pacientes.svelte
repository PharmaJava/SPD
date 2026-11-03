<script lang="ts">
  import { spd } from '../api.ts';
  import type { PacienteResumen, CentroDto, EstadoPaciente } from '../../servicios/api.ts';
  import { ir } from '../router.ts';
  import { fecha } from '../lib/formato.ts';
  import Cargando from '../componentes/Cargando.svelte';
  import Aviso from '../componentes/Aviso.svelte';
  import Dialogo from '../componentes/Dialogo.svelte';
  import Icono from '../componentes/Icono.svelte';
  import FormPaciente from './paciente/FormPaciente.svelte';
  import AceptarTodoCentro from './paciente/AceptarTodoCentro.svelte';
  import { cargarSesion, puedeValidar } from './preparacion/util.ts';
  import { coberturaVista, ESTADOS_PACIENTE, mensajeError } from '../componentes/util.ts';
  import { TIPOS_CENTRO, ETIQUETA_TIPO_CENTRO } from '../../dominio/origen-paciente.ts';
  import type { ResumenOrigen } from '../../dominio/origen-paciente.ts';

  let lista = $state<PacienteResumen[] | null>(null); let centros = $state<CentroDto[]>([]); let error = $state<string | null>(null);
  let texto = $state(''); let estado = $state<EstadoPaciente | 'todos'>('activo'); let centro = $state(''); let nuevo = $state(false);
  // Origen: '' = todos · 'individual' · 'tipo:<tipo>' (cualquier centro de ese tipo)
  let origen = $state(''); let resumen = $state<ResumenOrigen | null>(null); let verResumen = $state(false);
  let seq = 0; let temp: ReturnType<typeof setTimeout> | undefined;
  let dlgNuevo: { pedirCerrar: () => void } | undefined = $state(); let sucioNuevo = $state(false);
  $effect(() => { if (!nuevo) sucioNuevo = false; });

  async function cargar() {
    const mi = ++seq;
    const r = await spd.listarPacientes({
      texto: texto.trim() || undefined, estado, centroId: centro ? Number(centro) : undefined,
      origen: origen === 'individual' ? 'individual' : origen === 'centros' || origen.startsWith('tipo:') ? 'centro' : undefined,
      centroTipo: origen.startsWith('tipo:') ? (origen.slice(5) as (typeof TIPOS_CENTRO)[number]) : undefined,
    });
    if (mi !== seq) return;
    if (r.ok) { lista = r.datos; error = null; } else error = mensajeError(r);
  }
  $effect(() => { void estado; void centro; void origen; cargar(); });
  async function cargarResumen() { const r = await spd.resumenOrigen(); if (r.ok) resumen = r.datos; }
  $effect(() => { if (verResumen) cargarResumen(); });
  $effect(() => { spd.listarCentros().then(r => { if (r.ok) centros = r.datos; }); });
  let puedeGestionar = $state(false);
  $effect(() => { cargarSesion().then(u => { puedeGestionar = puedeValidar(u?.rol); }); });
  const centroElegido = $derived(centros.find(c => String(c.id) === centro));
  function alEscribir() { clearTimeout(temp); temp = setTimeout(cargar, 150); }
  const hayFiltro = $derived(!!texto.trim() || estado !== 'activo' || !!centro || !!origen);
</script>

<div class="cabecera-pagina">
  <h1>Pacientes</h1><span class="espacio"></span>
  <button class="btn principal" onclick={() => (nuevo = true)}><Icono n="mas" />Nuevo paciente</button>
</div>

<div class="filtros" role="search" aria-label="Filtros de pacientes">
  <div class="campo" style="flex:1 1 280px;max-width:420px"><label for="f-pac-texto">Buscar</label>
    <input id="f-pac-texto" class="grande" type="search" bind:value={texto} oninput={alEscribir} placeholder="Nombre o DNI" autocomplete="off" /></div>
  <div class="campo"><label for="f-pac-estado">Estado</label>
    <select id="f-pac-estado" bind:value={estado}><option value="activo">Activos</option><option value="pausado">Pausados</option><option value="baja">De baja</option><option value="todos">Todos</option></select></div>
  <div class="campo"><label for="f-pac-origen">Origen</label>
    <select id="f-pac-origen" bind:value={origen}>
      <option value="">Todos los orígenes</option><option value="individual">Individuales</option><option value="centros">Procedentes de centro</option>
      {#each TIPOS_CENTRO as t (t)}<option value={'tipo:' + t}>{ETIQUETA_TIPO_CENTRO[t]}</option>{/each}
    </select></div>
  {#if centros.length}<div class="campo"><label for="f-pac-centro">Centro</label>
    <select id="f-pac-centro" bind:value={centro}><option value="">Todos los centros</option>{#each centros as c (c.id)}<option value={String(c.id)}>{c.nombre}</option>{/each}</select></div>{/if}
</div>

{#if centroElegido && puedeGestionar}
  <div class="fila" style="margin-bottom:.6rem" data-prueba="acciones-centro">
    <span class="suave">Centro «{centroElegido.nombre}»:</span>
    <AceptarTodoCentro centroId={centroElegido.id} centroNombre={centroElegido.nombre} alhecho={cargar} />
  </div>
{/if}

<div class="fila" style="margin-bottom:.6rem"><button class="btn enlace" onclick={() => (verResumen = !verResumen)} aria-expanded={verResumen}>{verResumen ? 'Ocultar' : 'Ver'} resumen por origen</button></div>
{#if verResumen}
  <section class="tarjeta seccion" aria-label="Resumen por origen">
    {#if !resumen}<Cargando />{:else}
      <h3>Pacientes activos por origen</h3>
      <div class="cifras">
        <div class="tarjeta cifra"><div class="valor">{resumen.individuales}</div><div class="rotulo">Individuales</div></div>
        {#each resumen.porTipo as t (t.tipo)}
          <div class="tarjeta cifra"><div class="valor">{t.pacientes}</div><div class="rotulo">{t.etiqueta}{#if t.centros} ({t.centros} {t.centros === 1 ? 'centro' : 'centros'}){/if}</div></div>
        {/each}
      </div>
      {#if resumen.porCentro.length}
        <table class="tabla"><thead><tr><th>Centro</th><th>Tipo</th><th>Pacientes</th></tr></thead><tbody>
          {#each resumen.porCentro as c (c.centroId)}<tr><td>{c.nombre}</td><td>{ETIQUETA_TIPO_CENTRO[c.tipo]}</td><td>{c.pacientes}</td></tr>{/each}
        </tbody></table>
      {:else}<p class="suave sin-margen">Aún no hay centros registrados.</p>{/if}
    {/if}
  </section>
{/if}

{#if error}<Aviso tipo="bloqueo" titulo="No se ha podido cargar">{error}</Aviso>
{:else if !lista}<Cargando />
{:else if !lista.length}
  <div class="tarjeta vacio">
    {#if hayFiltro}<p>No hay pacientes con esos criterios.</p><button class="btn" onclick={() => { texto = ''; estado = 'todos'; centro = ''; origen = ''; }}>Quitar filtros</button>
    {:else}<h2>Aún no hay pacientes</h2><p>Da de alta al primero para empezar a registrar tratamientos y cajas.</p><button class="btn principal" onclick={() => (nuevo = true)}>Nuevo paciente</button>{/if}
  </div>
{:else}
  <div class="tarjeta" style="padding:0; overflow:auto">
    <table class="tabla">
      <caption class="solo-lectores">Lista de pacientes. Pulsa el nombre para abrir la ficha.</caption>
      <thead><tr><th>Paciente</th><th>Origen / habitación</th><th>Alergias</th><th>Consentimiento</th><th>Cobertura</th><th>Próxima preparación</th></tr></thead>
      <tbody>
        {#each lista as p (p.id)}
          {@const cob = coberturaVista(p.coberturaDias)}
          <tr class="clicable" onclick={(e) => { if (!(e.target as HTMLElement).closest('a,button')) ir(`pacientes/${p.id}`); }}>
            <td class="nombre"><a class="enlace-fila" href="#/pacientes/{p.id}" onkeydown={(e) => { if (e.key === ' ') { e.preventDefault(); ir(`pacientes/${p.id}`); } }}>{p.nombreCompleto}</a>{#if p.estado !== 'activo'} <span class="etiqueta atencion">{ESTADOS_PACIENTE[p.estado]}</span>{/if}</td>
            <td>{#if p.origen === 'centro'}{p.centro}{#if p.centroTipo} <span class="etiqueta info">{ETIQUETA_TIPO_CENTRO[p.centroTipo]}</span>{/if}{:else}<span class="etiqueta">Individual</span>{/if}{#if p.habitacion} · {p.habitacion}{/if}</td>
            <td>{#if p.alergias.length}<div class="etiquetas">{#each p.alergias as a}<span class="etiqueta alergia">{a}</span>{/each}</div>{:else}<span class="suave">—</span>{/if}</td>
            <td>{#if p.consentimientoGestionado}<span class="etiqueta info" title="Gestionado sin firma individual">Gestionado, sin firma</span>{:else if p.consentimientoSpd}<span class="etiqueta ok">Firmado</span>{:else}<span class="etiqueta atencion">Falta</span>{/if}</td>
            <td><span class={cob.clase}>{cob.texto}</span></td>
            <td>{fecha(p.proximaPreparacion)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="suave pequeno">{lista.length} {lista.length === 1 ? 'paciente' : 'pacientes'}</p>
{/if}

<Dialogo bind:this={dlgNuevo} abierto={nuevo} titulo="Nuevo paciente" ancho={860} sucio={sucioNuevo} onclose={() => (nuevo = false)}>
  {#if nuevo}<FormPaciente {centros} bind:sucio={sucioNuevo} oncancelar={() => dlgNuevo?.pedirCerrar()} onguardado={(p) => { sucioNuevo = false; nuevo = false; ir(`pacientes/${p.id}`); }} />{/if}
</Dialogo>

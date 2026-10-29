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
  import { coberturaVista, ESTADOS_PACIENTE, mensajeError } from '../componentes/util.ts';

  let lista = $state<PacienteResumen[] | null>(null); let centros = $state<CentroDto[]>([]); let error = $state<string | null>(null);
  let texto = $state(''); let estado = $state<EstadoPaciente | 'todos'>('activo'); let centro = $state(''); let nuevo = $state(false);
  let seq = 0; let temp: ReturnType<typeof setTimeout> | undefined;

  async function cargar() {
    const mi = ++seq;
    const r = await spd.listarPacientes({ texto: texto.trim() || undefined, estado, centroId: centro ? Number(centro) : undefined });
    if (mi !== seq) return;
    if (r.ok) { lista = r.datos; error = null; } else error = mensajeError(r);
  }
  $effect(() => { void estado; void centro; cargar(); });
  $effect(() => { spd.listarCentros().then(r => { if (r.ok) centros = r.datos; }); });
  function alEscribir() { clearTimeout(temp); temp = setTimeout(cargar, 150); }
  const hayFiltro = $derived(!!texto.trim() || estado !== 'activo' || !!centro);
</script>

<div class="cabecera-pagina">
  <h1>Pacientes</h1><span class="espacio"></span>
  <button class="btn principal" onclick={() => (nuevo = true)}><Icono n="mas" />Nuevo paciente</button>
</div>

<div class="herramientas">
  <input class="grande" type="search" bind:value={texto} oninput={alEscribir} placeholder="Buscar por nombre, DNI o tarjeta sanitaria" aria-label="Buscar paciente" />
  <select bind:value={estado} aria-label="Estado"><option value="activo">Activos</option><option value="pausado">Pausados</option><option value="baja">De baja</option><option value="todos">Todos</option></select>
  {#if centros.length}<select bind:value={centro} aria-label="Centro"><option value="">Todos los centros</option>{#each centros as c (c.id)}<option value={String(c.id)}>{c.nombre}</option>{/each}</select>{/if}
</div>

{#if error}<Aviso tipo="bloqueo" titulo="No se ha podido cargar">{error}</Aviso>
{:else if !lista}<Cargando />
{:else if !lista.length}
  <div class="tarjeta vacio">
    {#if hayFiltro}<p>No hay pacientes con esos criterios.</p><button class="btn" onclick={() => { texto = ''; estado = 'todos'; centro = ''; }}>Quitar filtros</button>
    {:else}<h2>Aún no hay pacientes</h2><p>Da de alta al primero para empezar a registrar tratamientos y cajas.</p><button class="btn principal" onclick={() => (nuevo = true)}>Nuevo paciente</button>{/if}
  </div>
{:else}
  <div class="tarjeta" style="padding:0; overflow:auto">
    <table class="tabla">
      <thead><tr><th>Paciente</th><th>Centro / habitación</th><th>Alergias</th><th>Consentimiento</th><th>Cobertura</th><th>Próxima preparación</th></tr></thead>
      <tbody>
        {#each lista as p (p.id)}
          {@const cob = coberturaVista(p.coberturaDias)}
          <tr class="clicable" tabindex="0" onclick={() => ir(`pacientes/${p.id}`)} onkeydown={(e) => { if (e.key === 'Enter') ir(`pacientes/${p.id}`); }}>
            <td class="nombre">{p.nombreCompleto}{#if p.estado !== 'activo'} <span class="etiqueta atencion">{ESTADOS_PACIENTE[p.estado]}</span>{/if}</td>
            <td>{p.centro ?? 'Domicilio'}{#if p.habitacion} · {p.habitacion}{/if}</td>
            <td>{#if p.alergias.length}<div class="etiquetas">{#each p.alergias as a}<span class="etiqueta alergia">{a}</span>{/each}</div>{:else}<span class="suave">—</span>{/if}</td>
            <td>{#if p.consentimientoSpd}<span class="etiqueta ok">Firmado</span>{:else}<span class="etiqueta atencion">Falta</span>{/if}</td>
            <td><span class={cob.clase}>{cob.texto}</span></td>
            <td>{fecha(p.proximaPreparacion)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="suave pequeno">{lista.length} {lista.length === 1 ? 'paciente' : 'pacientes'}</p>
{/if}

<Dialogo abierto={nuevo} titulo="Nuevo paciente" ancho={860} onclose={() => (nuevo = false)}>
  {#if nuevo}<FormPaciente {centros} oncancelar={() => (nuevo = false)} onguardado={(p) => { nuevo = false; ir(`pacientes/${p.id}`); }} />{/if}
</Dialogo>

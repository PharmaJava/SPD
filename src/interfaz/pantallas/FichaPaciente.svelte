<script lang="ts">
  import { untrack } from 'svelte';
  import { spd } from '../api.ts';
  import type { PacienteDto, TratamientoDto, SaludDatoDto, ContactoDto, CentroDto, EstadoConsentimientosDto, MomentoTomaDto, RolUsuario } from '../../servicios/api.ts';
  import { ir } from '../router.ts';
  import Cargando from '../componentes/Cargando.svelte';
  import Aviso from '../componentes/Aviso.svelte';
  import Pestanas from '../componentes/Pestanas.svelte';
  import Icono from '../componentes/Icono.svelte';
  import Resumen from './paciente/Resumen.svelte';
  import Datos from './paciente/Datos.svelte';
  import Tratamientos from './paciente/Tratamientos.svelte';
  import FichaCajas from './FichaCajas.svelte';
  import FichaBlisteres from './FichaBlisteres.svelte';
  import FichaDocumentos from './FichaDocumentos.svelte';
  import FichaHistorial from './FichaHistorial.svelte';
  import { coberturaVista, edad, ESTADOS_PACIENTE, mensajeError } from '../componentes/util.ts';
  import { SALUD_TIPOS } from './paciente/constantes.ts';

  let { id, pestana }: { id: number; pestana?: string; rol?: RolUsuario } = $props();

  let paciente = $state<PacienteDto | null>(null); let error = $state<string | null>(null);
  let salud = $state<SaludDatoDto[]>([]); let contactos = $state<ContactoDto[]>([]); let centros = $state<CentroDto[]>([]);
  let tratamientos = $state<TratamientoDto[] | null>(null); let consent = $state<EstadoConsentimientosDto | null>(null); let momentos = $state<MomentoTomaDto[]>([]);

  async function cargar() {
    const [p, s, c, t, co, ce, m] = await Promise.all([spd.obtenerPaciente(id), spd.listarSalud(id), spd.listarContactos(id), spd.listarTratamientos(id), spd.estadoConsentimientos(id), spd.listarCentros(), spd.listarMomentos()]);
    if (!p.ok) { error = mensajeError(p); return; }
    paciente = p.datos; error = null;
    if (s.ok) salud = s.datos; if (c.ok) contactos = c.datos; if (t.ok) tratamientos = t.datos; if (co.ok) consent = co.datos; if (ce.ok) centros = ce.datos; if (m.ok) momentos = m.datos;
  }
  $effect(() => { void id; cargar(); });

  const PEST = ['resumen', 'datos', 'tratamiento', 'cajas', 'blisteres', 'documentos', 'historial'];
  let activa = $state(untrack(() => (PEST.includes(pestana ?? '') ? pestana! : 'resumen')));
  $effect(() => { const p = pestana && PEST.includes(pestana) ? pestana : 'resumen'; if (p !== activa) activa = p; });
  $effect(() => { const destino = `#/pacientes/${id}` + (activa === 'resumen' ? '' : '/' + activa); if (location.hash !== destino) history.replaceState(null, '', destino); });
  const irA = (p: string) => (activa = p);

  const alergias = $derived(salud.filter(s => s.vigente && s.tipo === 'alergia'));
  const otros = $derived(salud.filter(s => s.vigente && ['disfagia', 'insuficiencia_renal', 'insuficiencia_hepatica', 'embarazo_lactancia', 'intolerancia'].includes(s.tipo)));
  const cobertura = $derived.by(() => {
    const ts = (tratamientos ?? []).filter(t => !t.finalizadoEn && t.emblistable && t.pautaVigenteTexto && t.coberturaDias != null);
    return ts.length ? Math.min(...ts.map(t => t.coberturaDias!)) : null;
  });
  const cob = $derived(coberturaVista(cobertura));
  const anios = $derived(edad(paciente?.fechaNacimiento));
  const contador = $derived((tratamientos ?? []).filter(t => !t.finalizadoEn).length);
</script>

{#if error}
  <Aviso tipo="bloqueo" titulo="No se ha podido abrir el paciente">{error}</Aviso><button class="btn" onclick={() => ir('pacientes')}>Volver a pacientes</button>
{:else if !paciente}<Cargando />
{:else}
  <div class="ficha-cab">
    <div class="fila" style="margin-bottom:.4rem"><button class="btn enlace" onclick={() => ir('pacientes')}><Icono n="atras" tam={16} />Pacientes</button></div>
    <div class="tarjeta">
      <div class="dato" style="flex:1; min-width:220px">
        <h1>{paciente.nombre} {paciente.apellido1} {paciente.apellido2 ?? ''}</h1>
        <span class="suave">{anios != null ? anios + ' años' : 'Edad no indicada'}{paciente.habitacion ? ' · Hab. ' + paciente.habitacion : ''} · {paciente.idPublico}
          {#if paciente.estado !== 'activo'} <span class="etiqueta atencion">{ESTADOS_PACIENTE[paciente.estado]}</span>{/if}</span>
      </div>
      <div class="dato"><span class="rotulo">Alergias</span>
        {#if alergias.length}<div class="etiquetas">{#each alergias as a (a.id)}<span class="etiqueta alergia"><Icono n="alerta" tam={13} /> {a.descripcion}</span>{/each}</div>
        {:else}<span class="suave">Ninguna registrada</span>{/if}
        {#if otros.length}<div class="etiquetas" style="margin-top:.2rem">{#each otros as o (o.id)}<span class="etiqueta atencion">{SALUD_TIPOS[o.tipo]}: {o.descripcion}</span>{/each}</div>{/if}
      </div>
      <div class="dato"><span class="rotulo">Consentimiento</span>
        {#if !consent}<span class="suave">…</span>{:else if consent.completo}<span class="etiqueta ok">Completo</span>{:else}<span class="etiqueta atencion">Faltan documentos</span>{/if}</div>
      <div class="dato"><span class="rotulo">Cobertura</span><span class={cob.clase}>{cob.texto}</span></div>
    </div>
  </div>

  <div style="margin-top:1rem">
    <Pestanas bind:activa pestanas={[
      { id: 'resumen', etiqueta: 'Resumen' }, { id: 'datos', etiqueta: 'Datos' }, { id: 'tratamiento', etiqueta: 'Tratamiento', contador },
      { id: 'cajas', etiqueta: 'Cajas' }, { id: 'blisteres', etiqueta: 'Blísteres' }, { id: 'documentos', etiqueta: 'Documentos' }, { id: 'historial', etiqueta: 'Historial' }]} />
    <div role="tabpanel" id="panel-{activa}" aria-labelledby="pest-{activa}">
      {#if activa === 'resumen'}<Resumen {paciente} tratamientos={tratamientos ?? []} {consent} {contactos} {momentos} {centros} {irA} />
      {:else if activa === 'datos'}<Datos {paciente} {centros} {salud} {contactos} alcambiar={cargar} />
      {:else if activa === 'tratamiento'}<Tratamientos pacienteId={id} {tratamientos} {momentos} alcambiar={cargar} />
      {:else if activa === 'cajas'}<FichaCajas pacienteId={id} />
      {:else if activa === 'blisteres'}<FichaBlisteres pacienteId={id} />
      {:else if activa === 'documentos'}<FichaDocumentos pacienteId={id} />
      {:else if activa === 'historial'}<FichaHistorial pacienteId={id} />{/if}
    </div>
  </div>
{/if}

<script lang="ts">
  /** Paso 3 · Validar (segunda persona: farmacéutico o titular), etiqueta, hoja del paciente y entrega. */
  import { spd } from '../../api.ts';
  import type { Ajustes, EvaluacionPreparacion, PreparacionDto, UsuarioPublico, VistaImprimible } from '../../../servicios/api.ts';
  import { fecha, fechaHora, numero } from '../../lib/formato.ts';
  import '../../estilos/u2.css';
  import Entrega from './Entrega.svelte';
  import Leyenda from './Leyenda.svelte';
  import Mapa from './Mapa.svelte';
  import Nota from './Nota.svelte';
  import VistaPrevia from './VistaPrevia.svelte';
  import { NOMBRE_ROL, puedeValidar } from './util.ts';

  let { evaluacion, preparacion, sesion, ajustes, onCambio, onAtras, onNueva }: {
    evaluacion: EvaluacionPreparacion; preparacion: PreparacionDto; sesion: UsuarioPublico | null; ajustes: Ajustes | null;
    onCambio: (p: PreparacionDto) => void; onAtras: () => void; onNueva: () => void;
  } = $props();

  const validada = $derived(preparacion.estado === 'validado' || preparacion.estado === 'entregado');
  const entregada = $derived(preparacion.estado === 'entregado');
  const puede = $derived(puedeValidar(sesion?.rol));

  let comparado = $state(false);
  let validando = $state(false); let errorValidar = $state('');
  let entregando = $state(false);

  const lotes = $derived.by(() => {
    const m = new Map<number, { nombre: string; lote: string; caducidad: string; unidades: number }>();
    for (const l of evaluacion.lineasReparto) {
      const x = m.get(l.envaseId) ?? { nombre: l.nombre, lote: l.lote, caducidad: l.caducidad, unidades: 0 };
      x.unidades += l.unidades; m.set(l.envaseId, x);
    }
    return [...m.values()];
  });

  async function validar() {
    validando = true; errorValidar = '';
    const r = await spd.validarPreparacion(preparacion.id);
    validando = false;
    if (!r.ok) { errorValidar = r.error; return; }
    onCambio(r.datos);
  }

  // Vistas imprimibles (etiqueta y hoja A4): se piden cuando hacen falta
  let verBorrador = $state(false);
  let pestana = $state<'etiqueta' | 'hoja'>('etiqueta');
  let vistas = $state<{ etiqueta?: VistaImprimible; hoja?: VistaImprimible }>({});
  let errorVista = $state(''); let cargandoVista = $state(false);
  async function cargarVista(cual: 'etiqueta' | 'hoja') {
    cargandoVista = true; errorVista = '';
    const r = cual === 'etiqueta' ? await spd.vistaEtiqueta(preparacion.id) : await spd.vistaHojaPaciente(preparacion.id);
    cargandoVista = false;
    if (r.ok) vistas = { ...vistas, [cual]: r.datos }; else errorVista = r.error;
  }
  $effect(() => { preparacion.estado; vistas = {}; });          // al validar o entregar se vuelven a pedir
  $effect(() => { if ((validada || verBorrador) && !vistas[pestana] && !cargandoVista) void cargarVista(pestana); });
  const motivoEtiqueta = 'La etiqueta definitiva sólo se imprime cuando el blíster está validado.';
</script>

<div class="apilado">
  {#if entregada}
    <Nota gravedad="ok" id="entregada"><strong>Entregado.</strong> {preparacion.idPublico} · {fechaHora(preparacion.validadoEn)} validado por {preparacion.validadoPor ?? '—'}.
      {#snippet accion()}<button class="btn" type="button" onclick={onNueva}>Preparar otro</button>{/snippet}</Nota>
  {:else if validada}
    <Nota gravedad="ok" id="validada"><strong>Blíster validado</strong> por {preparacion.validadoPor ?? '—'} el {fechaHora(preparacion.validadoEn)}. Ya puedes imprimir la etiqueta y la hoja del paciente.</Nota>
  {:else if !puede}
    <Nota gravedad="info" id="sin-permiso">
      <strong>Falta la validación de un farmacéutico.</strong> Has entrado como {NOMBRE_ROL[sesion?.rol ?? ''] ?? 'usuario'}, y este paso lo hace un farmacéutico (o el titular) con su propio usuario, mirando el blíster. Avísale: el blíster queda guardado como «preparado» y esperándole.
    </Nota>
  {/if}

  <section class="tarjeta" aria-labelledby="t-resumen">
    <h2 id="t-resumen">Resumen del blíster {preparacion.idPublico}</h2>
    <div class="cuatro-campos">
      <div><div class="suave pequeno">Paciente</div><strong>{preparacion.pacienteNombre}</strong></div>
      <div><div class="suave pequeno">Periodo</div><strong>{fecha(preparacion.fechaInicio)} – {fecha(preparacion.fechaFin)}</strong></div>
      <div><div class="suave pequeno">Caduca el</div><strong data-prueba="caducidad-final">{fecha(preparacion.caducidadSpd)}</strong>{#if preparacion.fueraDeEstandar} <span class="etiqueta atencion">fuera del estándar</span>{/if}</div>
      <div><div class="suave pequeno">Preparado por</div><strong>{preparacion.preparadoPor ?? '—'}</strong> <span class="suave pequeno">{fechaHora(preparacion.preparadoEn)}</span></div>
    </div>
    {#if preparacion.temperatura != null || preparacion.humedad != null}
      <div class="suave margen-s">Sala: {numero(preparacion.temperatura)} °C · {numero(preparacion.humedad)} % de humedad</div>
    {/if}
    {#if preparacion.fueraDeEstandar && preparacion.justificacionValidez}<Nota gravedad="atencion">Validez ampliada. Justificación: {preparacion.justificacionValidez}</Nota>{/if}
  </section>

  {#if !validada}
    <div class="dos-col">
      <section class="tarjeta" aria-labelledby="t-comp">
        <h2 id="t-comp">Comprueba el blíster contra el mapa</h2>
        {#each evaluacion.mapas as m (m.indice)}
          {#if evaluacion.mapas.length > 1}<h3>Blíster {m.indice + 1} · {fecha(m.desde)} – {fecha(m.hasta)}</h3>{/if}
          <Mapa mapa={m} alveolos={evaluacion.alveolos} leyenda={evaluacion.leyenda} />
        {/each}
      </section>
      <aside class="apilado">
        <section class="tarjeta" aria-labelledby="t-asp">
          <h2 id="t-asp">Cómo es cada comprimido</h2>
          <Leyenda leyenda={evaluacion.leyenda} mostrarDescripcion />
        </section>
        <section class="tarjeta" aria-labelledby="t-lot">
          <h2 id="t-lot">Cajas usadas</h2>
          <ul class="lista-plana" data-prueba="lotes-usados">
            {#each lotes as l (l.nombre + l.lote)}
              <li><span class="espacio"><strong>{l.nombre}</strong><br /><span class="suave pequeno">lote {l.lote} · caduca {fecha(l.caducidad)}</span></span><span class="etiqueta">{numero(l.unidades)} ud.</span></li>
            {/each}
          </ul>
        </section>
      </aside>
    </div>

    {#each evaluacion.bloqueos.filter(b => b.codigo !== 'ROL_NO_PUEDE_VALIDAR') as b (b.codigo)}<Nota gravedad="bloqueo">{b.texto}</Nota>{/each}
    {#if errorValidar}<Nota gravedad="bloqueo">{errorValidar}</Nota>{/if}

    {#if puede}
      <section class="tarjeta fuerte">
        <label class="fila" style="gap:.8rem;cursor:pointer">
          <input type="checkbox" bind:checked={comparado} style="width:1.6rem;min-height:1.6rem" data-prueba="he-comparado" />
          <span class="negrita">He comparado el blíster con el mapa y con la descripción de cada comprimido.</span>
        </label>
      </section>
    {:else}
      <div class="fila"><button class="btn" type="button" onclick={() => (verBorrador = !verBorrador)}>{verBorrador ? 'Ocultar' : 'Ver'} la etiqueta provisional</button></div>
    {/if}
  {/if}

  {#if validada || verBorrador}
    <section class="tarjeta" aria-labelledby="t-imp">
      <h2 id="t-imp">Imprimir</h2>
      <div class="fila" role="tablist" style="margin-bottom:.8rem">
        <button class="btn" class:principal={pestana === 'etiqueta'} role="tab" aria-selected={pestana === 'etiqueta'} type="button" onclick={() => (pestana = 'etiqueta')} data-prueba="pestana-etiqueta">Etiqueta</button>
        <button class="btn" class:principal={pestana === 'hoja'} role="tab" aria-selected={pestana === 'hoja'} type="button" onclick={() => (pestana = 'hoja')} data-prueba="pestana-hoja">Hoja del paciente</button>
      </div>
      {#if errorVista}<Nota gravedad="bloqueo">{errorVista}</Nota>{/if}
      {#if cargandoVista && !vistas[pestana]}<div class="cargando-linea">Preparando la vista previa…</div>{/if}
      {#if vistas[pestana]}
        {#key pestana + preparacion.estado}
          <VistaPrevia titulo={pestana === 'etiqueta' ? 'Etiqueta del blíster' : 'Hoja del paciente (plan de administración)'} vista={vistas[pestana]!}
            nombreArchivo={`${pestana === 'etiqueta' ? 'etiqueta' : 'hoja'}-${preparacion.idPublico}.pdf`}
            impresora={pestana === 'etiqueta' ? ajustes?.impresoraEtiquetas : ajustes?.impresoraDocumentos}
            motivoNoImprimir={validada ? '' : motivoEtiqueta} />
        {/key}
      {/if}
    </section>
  {/if}
</div>

<Entrega bind:abierto={entregando} {preparacion} pacienteNombre={preparacion.pacienteNombre} onEntregada={onCambio} />

<div class="barra-acciones">
  <button class="btn" type="button" onclick={onAtras} disabled={validada}>← Volver a llenar</button>
  <span class="espacio"></span>
  {#if !validada}
    {#if puede}<button class="btn principal grande" type="button" onclick={validar} disabled={!comparado || validando} data-prueba="validar">{validando ? 'Validando…' : 'Validar el blíster'}</button>{/if}
  {:else if !entregada}
    <button class="btn principal grande" type="button" onclick={() => (entregando = true)} data-prueba="registrar-entrega">Registrar entrega</button>
  {:else}
    <button class="btn principal grande" type="button" onclick={onNueva}>Preparar otro blíster</button>
  {/if}
</div>

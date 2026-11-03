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
  import { corto, ir, NOMBRE_ROL, puedeValidar } from './util.ts';
  import { QUE_HACER, solucionComun } from './ayuda-bloqueos.ts';
  import { bloqueosParaMostrar } from '../../../dominio/preparacion.ts';
  import { mensajeError } from '../../componentes/util.ts';

  let { evaluacion, preparacion, sesion, ajustes, onCambio, onAtras, onNueva }: {
    evaluacion: EvaluacionPreparacion; preparacion: PreparacionDto; sesion: UsuarioPublico | null; ajustes: Ajustes | null;
    onCambio: (p: PreparacionDto) => void; onAtras: () => void; onNueva: () => void;
  } = $props();

  const validada = $derived(preparacion.estado === 'validado' || preparacion.estado === 'entregado');
  const entregada = $derived(preparacion.estado === 'entregado');
  const puede = $derived(puedeValidar(sesion?.rol));

  let comparado = $state(false);
  let validando = $state(false); let errorValidar = $state('');

  // La evaluación puede quedarse vieja (p. ej. se registró una alergia después de preparar): si al validar el servicio protesta, se vuelve a pedir.
  let evalLocal = $state<EvaluacionPreparacion | null>(null);
  const ev = $derived(evalLocal ?? evaluacion);
  const alergias = $derived(ev.avisos.filter(a => a.codigo === 'POSIBLE_ALERGIA'));
  const alergiaSinConfirmar = $derived(ev.bloqueos.some(b => b.codigo === 'ALERGIA_SIN_CONFIRMAR'));
  let alergiaRevisada = $state(false);
  const OCULTOS = ['ROL_NO_PUEDE_VALIDAR', 'ALERGIA_SIN_CONFIRMAR'];   // el de rol ya tiene su aviso; la alergia, su tarjeta
  let entregando = $state(false);

  const lotes = $derived.by(() => {
    const m = new Map<number, { nombre: string; lote: string; caducidad: string; unidades: number }>();
    for (const l of ev.lineasReparto) {
      const x = m.get(l.envaseId) ?? { nombre: l.nombre, lote: l.lote, caducidad: l.caducidad, unidades: 0 };
      x.unidades += l.unidades; m.set(l.envaseId, x);
    }
    return [...m.values()];
  });

  async function validar() {
    validando = true; errorValidar = '';
    // La confirmación sólo viaja si la persona la ha marcado en pantalla Y hay una posible alergia delante.
    const r = await spd.validarPreparacion(preparacion.id, alergiaSinConfirmar && alergiaRevisada ? { confirmarAlergias: true } : undefined);
    if (!r.ok) {
      errorValidar = mensajeError(r);
      const o = await spd.obtenerPreparacion(preparacion.id);
      if (o.ok) { evalLocal = o.datos.evaluacion; alergiaRevisada = false; }
      validando = false; return;
    }
    validando = false;
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
    <Nota gravedad="ok" id="entregada"><strong>Entregado.</strong> {corto(preparacion.idPublico)} · {fechaHora(preparacion.validadoEn)} validado por {preparacion.validadoPor ?? '—'}.
      {#snippet accion()}<button class="btn" type="button" onclick={onNueva}>Preparar otro</button>{/snippet}</Nota>
  {:else if validada}
    <Nota gravedad="ok" id="validada"><strong>Blíster validado</strong> por {preparacion.validadoPor ?? '—'} el {fechaHora(preparacion.validadoEn)}. Ya puedes imprimir la etiqueta y la hoja del paciente.</Nota>
  {:else if !puede}
    <Nota gravedad="info" id="sin-permiso">
      <strong>Falta la validación de un farmacéutico.</strong> Has entrado como {NOMBRE_ROL[sesion?.rol ?? ''] ?? 'usuario'}, y este paso lo hace un farmacéutico (o el titular) con su propio usuario, mirando el blíster. Avísale: el blíster queda guardado como «preparado» y esperándole.
    </Nota>
  {/if}

  <section class="tarjeta" aria-labelledby="t-resumen">
    <h2 id="t-resumen">Resumen del blíster {corto(preparacion.idPublico)}</h2>
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

  {#if alergias.length}
    <section class="tarjeta" aria-labelledby="t-alergia" data-prueba="posible-alergia">
      <h2 id="t-alergia">Posible alergia detectada</h2>
      <Nota gravedad={validada ? 'atencion' : 'bloqueo'}>
        {alergias.length === 1 ? 'Un medicamento de este blíster coincide con una alergia registrada del paciente:' : 'Estos medicamentos coinciden con alergias registradas del paciente:'}
        <ul class="margen-s">{#each alergias as a (a.texto)}<li>{a.texto}</li>{/each}</ul>
      </Nota>
      {#if !validada && alergiaSinConfirmar}
        {#if puede}
          <label class="fila" style="gap:.8rem;cursor:pointer">
            <input type="checkbox" bind:checked={alergiaRevisada} style="width:1.6rem;min-height:1.6rem" data-prueba="alergia-revisada" />
            <span class="negrita">He revisado la posible alergia con el paciente o el prescriptor.</span>
          </label>
          <p class="suave pequeno sin-margen">Sin esta confirmación el blíster no se puede validar. Queda anotado quién la ha dado y cuándo.</p>
        {:else}
          <Nota gravedad="info">Esta posible alergia la tiene que revisar un farmacéutico (o el titular) antes de validar el blíster.</Nota>
        {/if}
      {/if}
    </section>
  {/if}

  {#if !validada}
    <div class="dos-col">
      <section class="tarjeta" aria-labelledby="t-comp">
        <h2 id="t-comp">Comprueba el blíster contra el mapa</h2>
        {#each ev.mapas as m (m.indice)}
          {#if ev.mapas.length > 1}<h3>Blíster {m.indice + 1} · {fecha(m.desde)} – {fecha(m.hasta)}</h3>{/if}
          <Mapa mapa={m} alveolos={ev.alveolos} leyenda={ev.leyenda} />
        {/each}
      </section>
      <aside class="apilado">
        <section class="tarjeta" aria-labelledby="t-asp">
          <h2 id="t-asp">Cómo es cada comprimido</h2>
          <Leyenda leyenda={ev.leyenda} mostrarDescripcion />
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

    {#each bloqueosParaMostrar(ev.bloqueos, ev).filter(b => !OCULTOS.includes(b.codigo)) as b (b.codigo + b.texto)}
      {@const s = solucionComun(b.codigo, b.texto, preparacion.pacienteId)}
      <Nota gravedad="bloqueo">{b.texto}{#if QUE_HACER[b.codigo]}<br /><span class="suave">{QUE_HACER[b.codigo]}</span>{/if}
        {#snippet accion()}{#if s}<button class="btn" type="button" onclick={() => (s.hacer ? s.hacer() : ir(s.ruta!))}>{s.texto}</button>{/if}{/snippet}
      </Nota>
    {/each}
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
            nombreArchivo={`${pestana === 'etiqueta' ? 'etiqueta' : 'hoja'}-${corto(preparacion.idPublico)}.pdf`}
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
    {#if puede}<button class="btn principal grande" type="button" onclick={validar} disabled={!comparado || validando || (alergiaSinConfirmar && !alergiaRevisada)} data-prueba="validar">{validando ? 'Validando…' : 'Validar el blíster'}</button>{/if}
  {:else if !entregada}
    <button class="btn principal grande" type="button" onclick={() => (entregando = true)} data-prueba="registrar-entrega">Registrar entrega</button>
  {:else}
    <button class="btn principal grande" type="button" onclick={onNueva}>Preparar otro blíster</button>
  {/if}
</div>

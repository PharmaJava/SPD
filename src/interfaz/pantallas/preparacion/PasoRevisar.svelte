<script lang="ts">
  /** Paso 1 · Revisar: periodo, validez y lo que dice el programa (bloqueos, avisos, caducidad del SPD). */
  import type { Ajustes, EvaluacionPreparacion } from '../../../servicios/api.ts';
  import { fecha, fechaLarga, hoyIso, sumarDias } from '../../lib/formato.ts';
  import '../../estilos/u2.css';
  import BuscaPaciente from './BuscaPaciente.svelte';
  import Leyenda from './Leyenda.svelte';
  import Mapa from './Mapa.svelte';
  import Nota from './Nota.svelte';
  import { ir, rutas } from './util.ts';
  import { SOLO_PARA_VALIDAR, type EntradaPreparar } from './tipos.ts';


  let { entrada = $bindable(), pacienteIdInicial, ajustes, evaluacion, evaluando, errorEval, bloqueada = false, onSiguiente, onHoja }: {
    entrada: EntradaPreparar; pacienteIdInicial?: number; ajustes: Ajustes | null; evaluacion: EvaluacionPreparacion | null;
    evaluando: boolean; errorEval: string; bloqueada?: boolean; onSiguiente: () => void; onHoja: () => void;
  } = $props();

  const hoy = hoyIso();
  function proximoLunes(): string {
    const d = new Date(hoy + 'T00:00:00Z'); const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    return sumarDias(hoy, 8 - dow);
  }
  const lunes = proximoLunes();
  function modo(m: 'lunes' | 'hoy' | 'otra') {
    entrada.modoInicio = m;
    if (m === 'lunes') entrada.desde = lunes; else if (m === 'hoy') entrada.desde = hoy;
  }
  const estandar = $derived(ajustes?.diasValidezSpd ?? 14);
  const permiteExtendida = $derived(!!ajustes?.validezExtendidaPermitida);

  const bloqueosQueImpiden = $derived((evaluacion?.bloqueos ?? []).filter(b => !SOLO_PARA_VALIDAR.includes(b.codigo)));
  const bloqueosDeValidar = $derived((evaluacion?.bloqueos ?? []).filter(b => SOLO_PARA_VALIDAR.includes(b.codigo)));
  const puedeSeguir = $derived(!!evaluacion && !evaluando && bloqueosQueImpiden.length === 0 && !!entrada.paciente);
  const falta = $derived(evaluacion?.faltantes ?? []);

  /** Enlace de solución según el código estable del bloqueo. */
  function solucion(codigo: string): { texto: string; ruta?: string; hacer?: () => void } | null {
    const p = entrada.paciente?.id;
    switch (codigo) {
      case 'UNIDADES_INSUFICIENTES': case 'CAJA_CADUCA_EN_PERIODO': case 'SIN_LOTES_USADOS': case 'ENVASE_DE_OTRO_TRATAMIENTO':
        return { texto: 'Ir a Cajas', ruta: rutas.cajas(p) };
      case 'CONSENTIMIENTO_NO_VIGENTE': return p ? { texto: 'Ir a Documentos', ruta: rutas.paciente(p, 'documentos') } : null;
      case 'PAUTA_INVALIDA': case 'NADA_QUE_PREPARAR': case 'TOMA_SIN_CELDA': case 'MOMENTO_INEXISTENTE':
        return p ? { texto: 'Revisar el tratamiento', ruta: rutas.paciente(p, 'tratamiento') } : null;
      case 'PERIODO_NO_CABE': return entrada.modoInicio === 'hoy' ? null : { texto: 'Empezar hoy', hacer: () => modo('hoy') };
      case 'VALIDEZ_EXTENDIDA_NO_ACTIVADA': return { texto: 'Ir a Ajustes', ruta: '#/ajustes' };
      default: return null;
    }
  }
  const cad = $derived(evaluacion?.caducidadSpd);
  const porque = $derived(cad?.limitadaPor === 'lote' ? 'porque una de las cajas que se usan caduca antes' : cad?.limitadaPor === 'validez' ? `porque el SPD dura ${entrada.validez} días desde la preparación` : '');
</script>

<section class="tarjeta" aria-labelledby="t-periodo">
  <h2 id="t-periodo">¿Para quién y para cuántos días?</h2>
  <div class="dos-campos">
    <div>
      <BuscaPaciente bind:paciente={entrada.paciente} idInicial={pacienteIdInicial} enfocar={!pacienteIdInicial && !entrada.paciente} />
    </div>
    <div class="campo">
      <label for="dias">Días del blíster</label>
      <select id="dias" bind:value={entrada.dias} disabled={bloqueada} data-prueba="dias">
        <option value={7}>7 días (una semana)</option><option value={14}>14 días</option><option value={28}>28 días</option>
      </select>
    </div>
  </div>
  <div class="campo">
    <span class="negrita" style="font-size:.9rem" id="lbl-inicio">Primer día de toma</span>
    <div class="fila" role="group" aria-labelledby="lbl-inicio">
      <button type="button" class="btn" class:principal={entrada.modoInicio === 'lunes'} aria-pressed={entrada.modoInicio === 'lunes'} disabled={bloqueada} onclick={() => modo('lunes')}>Próximo lunes · {fecha(lunes)}</button>
      <button type="button" class="btn" class:principal={entrada.modoInicio === 'hoy'} aria-pressed={entrada.modoInicio === 'hoy'} disabled={bloqueada} onclick={() => modo('hoy')}>Hoy · {fecha(hoy)}</button>
      <button type="button" class="btn" class:principal={entrada.modoInicio === 'otra'} aria-pressed={entrada.modoInicio === 'otra'} disabled={bloqueada} onclick={() => modo('otra')}>Otra fecha</button>
      {#if entrada.modoInicio === 'otra'}<input type="date" bind:value={entrada.desde} min={hoy} style="width:auto" aria-label="Primer día de toma" disabled={bloqueada} />{/if}
    </div>
    <span class="ayuda">Empieza el {fechaLarga(entrada.desde)}.</span>
  </div>
  <div class="campo">
    <span class="negrita" style="font-size:.9rem" id="lbl-validez">Validez del SPD</span>
    {#if permiteExtendida}
      <div class="fila" role="group" aria-labelledby="lbl-validez">
        <button type="button" class="btn" class:principal={entrada.validez === estandar} aria-pressed={entrada.validez === estandar} disabled={bloqueada} onclick={() => (entrada.validez = estandar)}>{estandar} días (estándar)</button>
        <button type="button" class="btn" class:principal={entrada.validez === 30} aria-pressed={entrada.validez === 30} disabled={bloqueada} onclick={() => (entrada.validez = 30)}>30 días (requiere justificación)</button>
      </div>
      {#if entrada.validez > estandar}
        <label for="justif" class="negrita" style="font-size:.9rem">Justificación de la validez ampliada</label>
        <textarea id="justif" bind:value={entrada.justificacion} disabled={bloqueada} placeholder="Por qué se amplía y qué estabilidad se ha comprobado…"></textarea>
      {/if}
    {:else}
      <span>{estandar} días desde la preparación (estándar).</span>
    {/if}
  </div>
</section>

<div class="margen-m" aria-live="polite">
  {#if !entrada.paciente}
    <div class="tarjeta vacio">Elige un paciente para ver si se puede preparar su blíster.</div>
  {:else if evaluando && !evaluacion}
    <div class="tarjeta cargando-linea">Revisando el tratamiento, las cajas y las caducidades…</div>
  {:else if errorEval}
    <Nota gravedad="bloqueo">{errorEval}</Nota>
  {:else if evaluacion}
    <div class="apilado" class:evaluando>
      {#if bloqueosQueImpiden.length}
        <section class="tarjeta" aria-labelledby="t-bloq">
          <h2 id="t-bloq">Antes de preparar hay que resolver esto</h2>
          {#each bloqueosQueImpiden as b (b.codigo + b.texto)}
            {@const s = solucion(b.codigo)}
            <Nota gravedad="bloqueo">{b.texto}
              {#snippet accion()}{#if s}<button class="btn" type="button" onclick={() => (s.hacer ? s.hacer() : ir(s.ruta!))}>{s.texto}</button>{/if}{/snippet}
            </Nota>
          {/each}
          {#if falta.length}
            <h3 class="margen-s">Qué falta exactamente</h3>
            <ul class="lista-plana" data-prueba="faltantes">
              {#each falta as f (f.tratamientoId)}
                <li><span class="espacio">Faltan <strong>{f.faltan} {f.faltan === 1 ? 'unidad' : 'unidades'}</strong> de {f.nombre}</span>
                  <button class="btn mini" type="button" onclick={() => ir(rutas.cajas(entrada.paciente!.id))}>Ir a Cajas</button></li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}

      {#if bloqueosDeValidar.length}
        <section class="tarjeta">
          <h2>Se puede preparar, pero todavía no validar</h2>
          {#each bloqueosDeValidar as b (b.codigo)}
            {@const s = solucion(b.codigo)}
            <Nota gravedad="atencion">{b.texto}
              {#snippet accion()}{#if s}<button class="btn" type="button" onclick={() => (s.hacer ? s.hacer() : ir(s.ruta!))}>{s.texto}</button>{/if}{/snippet}
            </Nota>
          {/each}
        </section>
      {/if}

      {#if evaluacion.avisos.length}
        <section class="tarjeta" aria-labelledby="t-avisos">
          <h2 id="t-avisos">Ten en cuenta</h2>
          {#each evaluacion.avisos as a (a.codigo + a.texto)}<Nota gravedad="atencion">{a.texto}</Nota>{/each}
        </section>
      {/if}

      <div class="dos-col">
        <section class="tarjeta" aria-labelledby="t-res">
          <h2 id="t-res">Qué se va a preparar</h2>
          {#if evaluacion.leyenda.length}<Leyenda leyenda={evaluacion.leyenda} mostrarDescripcion />
          {:else}<div class="vacio">No hay ningún medicamento para meter en el blíster en estas fechas.</div>{/if}
          {#if evaluacion.aparte.length}
            <Nota gravedad="info"><strong>Se da aparte</strong> (no va en el blíster): {evaluacion.aparte.map(a => a.nombre).join(', ')}.</Nota>
          {/if}
        </section>
        <section class="tarjeta" aria-labelledby="t-cad">
          <h2 id="t-cad">Caducidad del SPD</h2>
          {#if cad?.caducidadSpd}
            <div class="negrita" style="font-size:1.4rem" data-prueba="caducidad-spd">{fecha(cad.caducidadSpd)}</div>
            <div class="suave">{porque}</div>
            {#if cad.fueraDeEstandar}<Nota gravedad="atencion">Validez fuera del estándar: queda anotada como desviación asumida.</Nota>{/if}
            {#each cad.avisos as a (a)}<Nota gravedad="atencion">{a}</Nota>{/each}
          {:else}
            <div class="suave">Se calculará cuando se pueda repartir la medicación a las cajas.</div>
          {/if}
          {#each cad?.errores ?? [] as a (a)}<Nota gravedad="bloqueo">{a}</Nota>{/each}
          <dl class="ficha-detalle">
            <dt>Periodo</dt><dd>{fecha(entrada.desde)} – {evaluacion.finPeriodo ? fecha(evaluacion.finPeriodo) : '—'} ({entrada.dias} días)</dd>
            <dt>Cajas usadas</dt><dd>{new Set(evaluacion.lineasReparto.map(l => l.envaseId)).size}</dd>
          </dl>
        </section>
      </div>

      {#if evaluacion.mapas.length}
        <section class="tarjeta" aria-labelledby="t-mapa">
          <h2 id="t-mapa">Así quedará el blíster</h2>
          {#each evaluacion.mapas as m (m.indice)}
            {#if evaluacion.mapas.length > 1}<h3>Blíster {m.indice + 1} · {fecha(m.desde)} – {fecha(m.hasta)}</h3>{/if}
            <Mapa mapa={m} alveolos={evaluacion.alveolos} leyenda={evaluacion.leyenda} />
          {/each}
        </section>
      {/if}
    </div>
  {/if}
</div>

<div class="barra-acciones">
  {#if evaluacion && !puedeSeguir && bloqueosQueImpiden.length}<span class="suave">Resuelve lo marcado en rojo para continuar.</span>{/if}
  <span class="espacio"></span>
  <button class="btn" type="button" onclick={onHoja} disabled={!evaluacion || !evaluacion.mapas.length}>Hoja de trabajo</button>
  <button class="btn principal grande" type="button" onclick={onSiguiente} disabled={!puedeSeguir} data-prueba="empezar-llenar">
    {bloqueada ? 'Seguir llenando' : 'Empezar a llenar'} →</button>
</div>

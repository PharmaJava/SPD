<script lang="ts">
  import { untrack } from 'svelte';
  import { spd } from '../../api.ts';
  import type { TratamientoDto, MomentoTomaDto, PautaDto } from '../../../servicios/api.ts';
  import { tomasDelPeriodo, avisosPauta } from '../../../dominio/calendario-pauta.ts';
  import Dialogo from '../../componentes/Dialogo.svelte';
  import Campo from '../../componentes/Campo.svelte';
  import Aviso from '../../componentes/Aviso.svelte';
  import { hoyIso, sumarDias, unidades } from '../../lib/formato.ts';
  import { DIAS_SEMANA, DIAS_SEMANA_LARGO, avisar } from '../../componentes/util.ts';
  import { ORIGENES, PATRONES } from './constantes.ts';

  let { tratamiento, momentos, onguardado, oncancelar }: {
    tratamiento: TratamientoDto | null; momentos: MomentoTomaDto[]; onguardado: (t: TratamientoDto) => void; oncancelar: () => void;
  } = $props();

  const activos = $derived(momentos.filter(m => m.activo).sort((a, b) => a.orden - b.orden));
  const actual = $derived(tratamiento ? [...tratamiento.pautas].sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0] : undefined);

  const a0 = untrack(() => actual);
  // Estado del formulario: parte de la pauta vigente (si la hay) para cambiar sólo lo que cambia.
  let patron = $state<PautaDto['patron']>(a0?.patron ?? 'diario');
  let diasSemana = $state<number[]>(a0?.diasSemana ? [...a0.diasSemana] : []);
  let cadaNDias = $state<string | number>(a0?.cadaNDias ?? 2);
  let cicloOn = $state<string | number>(a0?.cicloOn ?? 21); let cicloOff = $state<string | number>(a0?.cicloOff ?? 7);
  let fechaAncla = $state(a0?.fechaAncla ?? '');
  let vigenteDesde = $state(hoyIso());
  let origen = $state<PautaDto['origen']>(a0 ? 'revision_farmaceutica' : 'receta');
  let origenDetalle = $state(''); let instrucciones = $state(a0?.instrucciones ?? '');
  let dosis = $state<Record<number, number>>(Object.fromEntries((a0?.dosis ?? []).map(d => [d.momentoId, d.unidades])));
  let error = $state<string | null>(null); let ocupado = $state(false);

  const PASOS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10];
  const opcionesDosis = (v: number) => (PASOS.includes(v) ? PASOS : [...PASOS, v].sort((a, b) => a - b)).map(x => ({ valor: x, texto: x === 0 ? 'Nada' : unidades(x) }));

  function pauta(): PautaDto {
    const p: PautaDto = { vigenteDesde, patron, origen, origenDetalle: origenDetalle.trim() || null, instrucciones: instrucciones.trim() || null,
      dosis: activos.filter(m => (dosis[m.id] ?? 0) > 0).map(m => ({ momentoId: m.id, unidades: dosis[m.id]! })) };
    if (patron === 'dias_semana') p.diasSemana = [...diasSemana].sort((a, b) => a - b);
    if (patron === 'cada_n_dias') { p.cadaNDias = Number(cadaNDias); p.fechaAncla = fechaAncla || vigenteDesde; }
    if (patron === 'ciclo') { p.cicloOn = Number(cicloOn); p.cicloOff = Number(cicloOff); p.fechaAncla = fechaAncla || vigenteDesde; }
    return p;
  }
  /** Comprobaciones en lenguaje de persona (las reglas de fondo las vuelve a aplicar el servicio). */
  function problemas(p: PautaDto): string | null {
    if (!vigenteDesde) return 'Indica desde qué día vale esta pauta.';
    if (p.patron === 'dias_semana' && !p.diasSemana?.length) return 'Marca al menos un día de la semana.';
    if (p.patron === 'cada_n_dias' && !(Number.isInteger(p.cadaNDias) && p.cadaNDias! >= 1)) return 'Indica cada cuántos días se toma (un número entero).';
    if (p.patron === 'ciclo') {
      if (!(Number.isInteger(p.cicloOn) && p.cicloOn! >= 1)) return 'Indica cuántos días seguidos se toma.';
      if (!(Number.isInteger(p.cicloOff) && p.cicloOff! >= 0)) return 'Indica cuántos días de descanso hay (0 si no hay).';
    }
    if (p.patron !== 'si_precisa' && !p.dosis.length) return 'Indica la dosis en al menos un momento del día.';
    return null;
  }
  const borrador = $derived(pauta());
  const avisos = $derived.by(() => { try { return avisosPauta(borrador as never, tratamiento?.principioActivo); } catch { return []; } });
  // Vista previa de 7 días: desde el primer día en que toca (si arranca antes de hoy, desde hoy).
  const inicioVista = $derived(vigenteDesde > hoyIso() ? vigenteDesde : hoyIso());
  const vista = $derived.by(() => {
    if (problemas(borrador) || borrador.patron === 'si_precisa') return null;
    try {
      const tomas = tomasDelPeriodo(borrador as never, inicioVista, sumarDias(inicioVista, 6));
      const dias = Array.from({ length: 7 }, (_, i) => sumarDias(inicioVista, i));
      return { dias, tomas };
    } catch { return null; }
  });
  function diaCorto(iso: string) { const d = new Date(iso + 'T00:00:00Z').getUTCDay(); return DIAS_SEMANA[(d + 6) % 7]!; }

  async function guardar() {
    error = null;
    if (!tratamiento) return;
    const p = pauta(); const prob = problemas(p);
    if (prob) { error = prob; return; }
    ocupado = true;
    const r = await spd.guardarPauta(tratamiento.id, p);
    ocupado = false;
    if (r.ok) { avisar('Pauta guardada. La anterior queda en el historial.'); onguardado(r.datos); } else error = r.error;
  }
  function alternarDia(d: number) { diasSemana = diasSemana.includes(d) ? diasSemana.filter(x => x !== d) : [...diasSemana, d]; }
</script>

<Dialogo abierto={!!tratamiento} titulo={tratamiento ? `Pauta de ${tratamiento.principioActivo}` : ''} onclose={oncancelar} ancho={920}>
  {#if tratamiento}
    {#if actual}<Aviso tipo="info" titulo="Pauta actual">{tratamiento.pautaVigenteTexto}. Lo que guardes aquí será una versión nueva; la anterior se conserva en el historial.</Aviso>{/if}
    <div class="cols-2">
      <div>
        <fieldset class="campo" style="border:none;padding:0;margin:0 0 .8rem">
          <legend style="font-weight:600;font-size:.9rem;margin-bottom:.3rem">¿Cuándo se toma?</legend>
          <div class="apilado">{#each Object.entries(PATRONES) as [k, t]}<label class="marca"><input type="radio" name="patron" value={k} bind:group={patron} />{t}</label>{/each}</div>
        </fieldset>
        {#if patron === 'dias_semana'}
          <div class="campo"><span id="lbl-dias" style="font-weight:600;font-size:.9rem">Días de la semana</span>
            <div class="chips-dias" role="group" aria-labelledby="lbl-dias">
              {#each DIAS_SEMANA as d, i}<label><input type="checkbox" checked={diasSemana.includes(i + 1)} onchange={() => alternarDia(i + 1)} aria-label={DIAS_SEMANA_LARGO[i]} />{d}</label>{/each}
            </div></div>
        {:else if patron === 'cada_n_dias'}
          <div class="cols-2"><Campo etiqueta="Se toma cada… días" tipo="numero" bind:valor={cadaNDias} min={2} step={1} />
            <Campo etiqueta="Primer día de toma" tipo="fecha" bind:valor={fechaAncla} ayuda="Si lo dejas vacío, es el día de inicio." /></div>
        {:else if patron === 'ciclo'}
          <div class="cols-3"><Campo etiqueta="Días seguidos de toma" tipo="numero" bind:valor={cicloOn} min={1} step={1} />
            <Campo etiqueta="Días de descanso" tipo="numero" bind:valor={cicloOff} min={0} step={1} />
            <Campo etiqueta="Primer día del ciclo" tipo="fecha" bind:valor={fechaAncla} /></div>
        {/if}
      </div>
      <div>
        {#if patron !== 'si_precisa'}
          <div class="campo"><span style="font-weight:600;font-size:.9rem">Dosis en cada momento (unidades: comprimidos, cápsulas…)</span>
            <div class="dosis-grid">
              {#each activos as m (m.id)}
                <div class="celda"><strong>{m.nombre}</strong>{#if m.hora}<span class="suave pequeno">{m.hora}</span>{/if}
                  <select aria-label="Dosis en {m.nombre}" value={dosis[m.id] ?? 0} onchange={(e) => (dosis[m.id] = Number(e.currentTarget.value))}>
                    {#each opcionesDosis(dosis[m.id] ?? 0) as o (o.valor)}<option value={o.valor}>{o.texto}</option>{/each}
                  </select></div>
              {/each}
            </div></div>
        {:else}<Aviso tipo="info">Esta medicación no se prepara en el blíster: queda anotada en el tratamiento y en la hoja del paciente.</Aviso>{/if}
      </div>
    </div>

    {#if avisos.length}{#each avisos as a}<Aviso tipo="atencion">{a}</Aviso>{/each}{/if}

    {#if vista}
      <div class="seccion"><h3>Así quedaría la próxima semana</h3>
        <div style="overflow:auto"><table class="vista-semanal" aria-label="Vista previa de la semana">
          <thead><tr><th></th>{#each vista.dias as d}<th>{diaCorto(d)} {Number(d.slice(8))}</th>{/each}</tr></thead>
          <tbody>
            {#each activos.filter(m => (dosis[m.id] ?? 0) > 0) as m (m.id)}
              <tr><td class="rot">{m.nombre}</td>
                {#each vista.dias as d}{@const t = vista.tomas.find(x => x.fecha === d && x.momentoId === m.id)}<td class:toma={!!t}>{t ? unidades(t.unidades) : ''}</td>{/each}</tr>
            {/each}
          </tbody></table></div>
        <p class="suave pequeno">Los huecos en blanco son días sin toma. Revisa que coincide con lo que indica el médico.</p>
      </div>
    {/if}

    <div class="cols-3">
      <Campo etiqueta="Vale desde el día" tipo="fecha" bind:valor={vigenteDesde} requerido />
      <Campo etiqueta="¿De dónde sale esta pauta?" tipo="seleccion" bind:valor={origen} opciones={Object.entries(ORIGENES).map(([valor, texto]) => ({ valor, texto }))} />
      <Campo etiqueta="Detalle del origen" bind:valor={origenDetalle} ayuda="Nº de receta, fecha del informe, nombre del médico…" />
    </div>
    <Campo etiqueta="Instrucciones para la toma" tipo="area" filas={2} bind:valor={instrucciones} ayuda="Se imprimen en la hoja del paciente. Ejemplo: «con el desayuno»." />
    {#if error}<Aviso tipo="bloqueo" titulo="No se ha guardado">{error}</Aviso>{/if}
  {/if}
  {#snippet pie()}
    <button class="btn" onclick={oncancelar}>Cancelar</button>
    <button class="btn principal" onclick={guardar} disabled={ocupado}>Guardar pauta</button>
  {/snippet}
</Dialogo>

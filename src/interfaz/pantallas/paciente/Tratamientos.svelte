<script lang="ts">
  import { spd } from '../../api.ts';
  import type { TratamientoDto, MomentoTomaDto } from '../../../servicios/api.ts';
  import Dialogo from '../../componentes/Dialogo.svelte';
  import Campo from '../../componentes/Campo.svelte';
  import Aviso from '../../componentes/Aviso.svelte';
  import Confirmar from '../../componentes/Confirmar.svelte';
  import Cargando from '../../componentes/Cargando.svelte';
  import EditorPauta from './EditorPauta.svelte';
  import { fecha } from '../../lib/formato.ts';
  import { avisar, coberturaVista } from '../../componentes/util.ts';
  import { ORIGENES, textoPauta } from './constantes.ts';
  import { ir } from '../../router.ts';

  let { pacienteId, tratamientos, momentos, alcambiar }: { pacienteId: number; tratamientos: TratamientoDto[] | null; momentos: MomentoTomaDto[]; alcambiar: () => void } = $props();

  let verFinalizados = $state(false); let finalizados = $state<TratamientoDto[]>([]);
  let editandoDatos = $state<Partial<TratamientoDto> | null>(null); let errDatos = $state<Record<string, string>>({}); let errGeneral = $state<string | null>(null); let ocupado = $state(false);
  let conPauta = $state<TratamientoDto | null>(null); let finalizando = $state<TratamientoDto | null>(null); let versiones = $state<number | null>(null);
  let cnNombre = $state<string | null>(null);

  $effect(() => { if (verFinalizados) spd.listarTratamientos(pacienteId, true).then(r => { if (r.ok) finalizados = r.datos.filter(t => t.finalizadoEn); }); });
  const activos = $derived((tratamientos ?? []).filter(t => !t.finalizadoEn));

  // Pista del CN: nombre del medicamento si ya está en la base.
  $effect(() => {
    const cn = editandoDatos?.cnPreferente?.trim(); cnNombre = null;
    if (!cn || !/^\d{6,7}$/.test(cn)) return;
    const t = setTimeout(async () => {
      const r = await spd.obtenerMedicamento(cn);
      cnNombre = r.ok ? (r.datos ? r.datos.nombre : 'No lo tienes todavía en Medicamentos; puedes añadirlo allí.') : null;
    }, 250);
    return () => clearTimeout(t);
  });

  function nuevo() { editandoDatos = { principioActivo: '', dosisTexto: '', cnPreferente: '', indicacion: '', emblistable: true, motivoNoEmblistable: '', notaFarmaceutico: '' }; errDatos = {}; errGeneral = null; }
  async function guardarDatos(despuesPauta: boolean) {
    const e = editandoDatos; if (!e) return;
    errDatos = {}; errGeneral = null;
    if (!e.principioActivo?.trim()) errDatos.principio = 'Escribe el medicamento o principio activo.';
    if (e.cnPreferente && !/^\d{6,7}$/.test(e.cnPreferente.trim())) errDatos.cn = 'El código nacional (CN) tiene 6 o 7 cifras.';
    if (e.emblistable === false && !e.motivoNoEmblistable?.trim()) errDatos.motivo = 'Explica por qué no va en el blíster.';
    if (Object.keys(errDatos).length) return;
    ocupado = true;
    const n = (v?: string | null) => (v?.trim() ? v.trim() : undefined);
    const r = await spd.guardarTratamiento({ id: e.id, pacienteId, principioActivo: e.principioActivo!.trim(), dosisTexto: n(e.dosisTexto), cnPreferente: n(e.cnPreferente), indicacion: n(e.indicacion),
      emblistable: e.emblistable !== false, motivoNoEmblistable: e.emblistable === false ? n(e.motivoNoEmblistable) : undefined, notaFarmaceutico: n(e.notaFarmaceutico) });
    ocupado = false;
    if (!r.ok) { errGeneral = r.error; return; }
    editandoDatos = null; avisar('Tratamiento guardado.'); alcambiar();
    if (despuesPauta && r.datos.emblistable) conPauta = r.datos;
  }
  async function finalizar(motivo: string) {
    const t = finalizando!; const r = await spd.finalizarTratamiento(t.id, motivo);
    if (r.ok) { finalizando = null; avisar('Tratamiento finalizado.'); alcambiar(); if (verFinalizados) verFinalizados = false; } else { finalizando = null; avisar(r.error, 'bloqueo', 6000); }
  }
  const sinAspecto = (t: TratamientoDto) => t.emblistable && t.medicamento && t.medicamento.descripcionEstado !== 'confirmada';
</script>

<div class="fila" style="margin-bottom:1rem">
  <h2 class="sin-margen">Tratamientos</h2><span class="espacio"></span>
  <label class="marca"><input type="checkbox" bind:checked={verFinalizados} />Ver también los finalizados</label>
  <button class="btn principal" onclick={nuevo}>Nuevo tratamiento</button>
</div>

{#if !tratamientos}<Cargando />
{:else if !activos.length}
  <div class="tarjeta vacio"><h2>Sin tratamientos en curso</h2><p>Añade cada medicamento que toma el paciente y define su pauta.</p><button class="btn principal" onclick={nuevo}>Nuevo tratamiento</button></div>
{/if}

{#each [...activos, ...(verFinalizados ? finalizados : [])] as t (t.id)}
  {@const cob = coberturaVista(t.coberturaDias)}
  <article class="tarjeta tratamiento" class:finalizado={!!t.finalizadoEn}>
    <div class="cabecera">
      <div style="flex:1">
        <h3 class="sin-margen" style="font-size:1.15rem">{t.principioActivo}{#if t.dosisTexto} <span class="suave" style="font-weight:500">{t.dosisTexto}</span>{/if}</h3>
        {#if t.indicacion}<div class="suave pequeno">Para: {t.indicacion}</div>{/if}
        {#if t.medicamento}<div class="pequeno">Medicamento: {t.medicamento.nombre} <span class="suave">(CN {t.medicamento.cn})</span></div>{/if}
      </div>
      {#if t.finalizadoEn}<span class="etiqueta">Finalizado {fecha(t.finalizadoEn)}</span>
      {:else if !t.emblistable}<span class="etiqueta info">Va aparte del blíster</span>
      {:else}<div class="derecha"><div class="suave pequeno">Cobertura</div><div class={cob.clase}>{cob.texto}</div></div>{/if}
    </div>
    <div class="pauta-texto">{#if t.pautaVigenteTexto}{t.pautaVigenteTexto}{:else}<span class="cobertura-baja">Sin pauta definida</span>{/if}</div>
    {#if !t.emblistable && t.motivoNoEmblistable}<div class="pequeno suave">Motivo: {t.motivoNoEmblistable}</div>{/if}
    {#if t.notaFarmaceutico}<Aviso tipo="info" titulo="Nota del farmacéutico">{t.notaFarmaceutico}</Aviso>{/if}
    {#if sinAspecto(t)}<Aviso tipo="atencion" titulo="Aspecto sin confirmar">El aspecto de {t.medicamento?.nombre} no está confirmado. <button class="btn enlace" onclick={() => ir('medicamentos')}>Confirmarlo en Medicamentos</button></Aviso>{/if}
    {#if t.finalizadoEn && t.motivoFin}<div class="pequeno suave">Motivo: {t.motivoFin}</div>{/if}
    {#if !t.finalizadoEn}
      <div class="fila" style="margin-top:.6rem">
        {#if t.emblistable}<button class="btn" onclick={() => (conPauta = t)}>{t.pautas.length ? 'Cambiar la pauta' : 'Definir la pauta'}</button>{/if}
        <button class="btn" onclick={() => { editandoDatos = { ...t, motivoNoEmblistable: t.motivoNoEmblistable ?? '' }; errDatos = {}; errGeneral = null; }}>Editar datos</button>
        {#if t.pautas.length}<button class="btn enlace" onclick={() => (versiones = versiones === t.id ? null : t.id)}>{versiones === t.id ? 'Ocultar historial' : 'Historial de la pauta'} ({t.pautas.length})</button>{/if}
        <span class="espacio"></span>
        <button class="btn peligro" onclick={() => (finalizando = t)}>Finalizar</button>
      </div>
    {:else if t.pautas.length}
      <button class="btn enlace" onclick={() => (versiones = versiones === t.id ? null : t.id)}>{versiones === t.id ? 'Ocultar historial' : 'Historial de la pauta'}</button>
    {/if}
    {#if versiones === t.id}
      <ol class="versiones" aria-label="Versiones de la pauta">
        {#each [...t.pautas].sort((a, b) => (b.version ?? 0) - (a.version ?? 0)) as p (p.id ?? p.version)}
          <li><strong>Versión {p.version ?? '—'}</strong>, desde {fecha(p.vigenteDesde)}{p.vigenteHasta ? ' hasta ' + fecha(p.vigenteHasta) : ''}: {textoPauta(p, momentos)}.
            <span class="suave">Origen: {ORIGENES[p.origen]}{p.origenDetalle ? ' (' + p.origenDetalle + ')' : ''}.</span></li>
        {/each}
      </ol>
    {/if}
  </article>
{/each}

<Dialogo abierto={!!editandoDatos} titulo={editandoDatos?.id ? 'Editar tratamiento' : 'Nuevo tratamiento'} onclose={() => (editandoDatos = null)} ancho={680}>
  {#if editandoDatos}
    <Campo etiqueta="Medicamento o principio activo" bind:valor={editandoDatos.principioActivo} error={errDatos.principio} requerido autofocus ayuda="Ejemplo: «Metformina»" />
    <div class="cols-2">
      <Campo etiqueta="Dosis del envase (texto)" bind:valor={editandoDatos.dosisTexto} ayuda="Ejemplo: «850 mg»" />
      <Campo etiqueta="Código nacional (CN) del envase" bind:valor={editandoDatos.cnPreferente} error={errDatos.cn} inputmode="numeric" maxlength={7}>
        {#if cnNombre}<div class="ayuda">{cnNombre}</div>{/if}
      </Campo>
    </div>
    <Campo etiqueta="¿Para qué lo toma?" bind:valor={editandoDatos.indicacion} />
    <label class="marca"><input type="checkbox" checked={editandoDatos.emblistable !== false} onchange={(e) => (editandoDatos!.emblistable = e.currentTarget.checked)} />Va en el blíster</label>
    {#if editandoDatos.emblistable === false}<Campo etiqueta="¿Por qué no va en el blíster?" bind:valor={editandoDatos.motivoNoEmblistable} error={errDatos.motivo} ayuda="Ejemplo: «es un sobre», «se parte en cuartos»." />{/if}
    <Campo etiqueta="Nota del farmacéutico" tipo="area" filas={2} bind:valor={editandoDatos.notaFarmaceutico} ayuda="Se enseña al preparar y se imprime en la hoja. Ejemplo: «tomar en ayunas»." />
    {#if errGeneral}<Aviso tipo="bloqueo" titulo="No se ha guardado">{errGeneral}</Aviso>{/if}
  {/if}
  {#snippet pie()}
    <button class="btn" onclick={() => (editandoDatos = null)}>Cancelar</button>
    {#if !editandoDatos?.id}<button class="btn" onclick={() => guardarDatos(false)} disabled={ocupado}>Guardar sin pauta</button>{/if}
    <button class="btn principal" onclick={() => guardarDatos(!editandoDatos?.id)} disabled={ocupado}>{editandoDatos?.id ? 'Guardar' : 'Guardar y definir la pauta'}</button>
  {/snippet}
</Dialogo>

{#key conPauta?.id}
  <EditorPauta tratamiento={conPauta} {momentos} oncancelar={() => (conPauta = null)} onguardado={() => { conPauta = null; alcambiar(); }} />
{/key}

<Confirmar abierto={!!finalizando} titulo="Finalizar tratamiento" mensaje={`¿Dejar de preparar ${finalizando?.principioActivo ?? ''}? Queda en el historial; no se borra.`}
  confirmarTexto="Finalizar" peligro pideMotivo etiquetaMotivo="Motivo (p. ej. «suspendido por el médico»)" onconfirmar={finalizar} oncancelar={() => (finalizando = null)} />

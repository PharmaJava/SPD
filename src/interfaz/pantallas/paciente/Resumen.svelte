<script lang="ts">
  import type { PacienteDto, TratamientoDto, EstadoConsentimientosDto, ContactoDto, MomentoTomaDto, CentroDto } from '../../../servicios/api.ts';
  import Aviso from '../../componentes/Aviso.svelte';
  import { ir } from '../../router.ts';
  import { fecha } from '../../lib/formato.ts';
  import { coberturaVista } from '../../componentes/util.ts';
  import { CONTACTO_TIPOS } from './constantes.ts';

  let { paciente, tratamientos, consent, contactos, momentos, centros, irA }: {
    paciente: PacienteDto; tratamientos: TratamientoDto[]; consent: EstadoConsentimientosDto | null; contactos: ContactoDto[]; momentos: MomentoTomaDto[]; centros: CentroDto[]; irA: (p: string) => void;
  } = $props();
  const activos = $derived(tratamientos.filter(t => !t.finalizadoEn));
  const sinPauta = $derived(activos.filter(t => t.emblistable && !t.pautaVigenteTexto));
  const sinAspecto = $derived(activos.filter(t => t.emblistable && t.medicamento && t.medicamento.descripcionEstado !== 'confirmada'));
  const sinCaja = $derived(activos.filter(t => t.emblistable && t.pautaVigenteTexto && (t.coberturaDias ?? 0) <= 0));
</script>

<div class="rejilla" style="grid-template-columns: 2fr 1fr; align-items:start">
  <div>
    <section class="seccion">
      <h2>Qué hay que hacer</h2>
      {#if paciente.estado !== 'activo'}<Aviso tipo="atencion" titulo="Paciente {paciente.estado === 'baja' ? 'de baja' : paciente.estado === 'pausado' ? 'pausado' : 'fallecido'}">{paciente.motivoEstado ?? 'No se preparan blísteres para este paciente.'}</Aviso>{/if}
      {#if consent && !consent.completo}
        <Aviso tipo="atencion" titulo="Faltan consentimientos">{#if consent.faltan.length}Sin firmar: {consent.faltan.join(', ')}. {/if}{#if consent.desactualizados.length}Desactualizados: {consent.desactualizados.join(', ')}. {/if}{#if consent.revocados.length}Revocados: {consent.revocados.join(', ')}. {/if}
          <button class="btn enlace" onclick={() => irA('documentos')}>Ir a documentos</button></Aviso>
      {/if}
      {#if !activos.length}<Aviso tipo="info" titulo="Sin tratamientos">Añade los medicamentos que toma. <button class="btn enlace" onclick={() => irA('tratamiento')}>Ir a tratamiento</button></Aviso>{/if}
      {#each sinPauta as t}<Aviso tipo="atencion" titulo="Sin pauta">{t.principioActivo} no tiene pauta. <button class="btn enlace" onclick={() => irA('tratamiento')}>Definirla</button></Aviso>{/each}
      {#each sinAspecto as t}<Aviso tipo="atencion" titulo="Aspecto sin confirmar">{t.medicamento?.nombre}: hay que confirmar cómo es el medicamento antes de preparar.</Aviso>{/each}
      {#each sinCaja as t}<Aviso tipo="atencion" titulo="Sin cajas">No hay unidades de {t.principioActivo} para cubrir la pauta. <button class="btn enlace" onclick={() => ir('cajas/' + paciente.id)}>Registrar cajas</button></Aviso>{/each}
      {#if paciente.estado === 'activo' && consent?.completo && activos.length && !sinPauta.length && !sinAspecto.length && !sinCaja.length}
        <Aviso tipo="ok" titulo="Todo en orden">Se puede preparar.</Aviso>
      {/if}
      <div class="fila" style="margin-top:.8rem">
        <button class="btn principal grande" onclick={() => ir('preparar/' + paciente.id)}>Preparar blíster</button>
        <button class="btn grande" onclick={() => ir('cajas/' + paciente.id)}>Entrada de cajas</button>
      </div>
    </section>

    <section class="seccion">
      <h2>Tratamientos en curso</h2>
      {#if !activos.length}<p class="suave">Ninguno todavía.</p>{:else}
        <table class="tabla"><thead><tr><th>Medicamento</th><th>Pauta</th><th>Cobertura</th></tr></thead><tbody>
          {#each activos as t (t.id)}{@const c = coberturaVista(t.coberturaDias)}
            <tr><td class="negrita">{t.principioActivo} <span class="suave" style="font-weight:400">{t.dosisTexto ?? ''}</span></td>
              <td>{t.emblistable ? (t.pautaVigenteTexto || '—') : 'Va aparte del blíster'}</td><td class={c.clase}>{t.emblistable ? c.texto : '—'}</td></tr>
          {/each}</tbody></table>
        <button class="btn enlace" onclick={() => irA('tratamiento')}>Ver y editar tratamiento</button>
      {/if}
    </section>
  </div>
  <aside>
    <section class="tarjeta seccion">
      <h3>Datos básicos</h3>
      <dl class="par">
        <dt>Nacimiento</dt><dd>{fecha(paciente.fechaNacimiento)}</dd>
        <dt>Teléfono</dt><dd>{paciente.telefono ?? '—'}</dd>
        <dt>Centro</dt><dd>{paciente.centroId ? (centros.find(c => c.id === paciente.centroId)?.nombre ?? 'Centro') : 'Domicilio'}{paciente.habitacion ? ' · ' + paciente.habitacion : ''}</dd>
        <dt>Revisión</dt><dd>{fecha(paciente.proximaRevision)}</dd>
        {#if paciente.letraGrande}<dt>Hoja</dt><dd>Letra grande</dd>{/if}
        {#if paciente.necesitaBraille}<dt>Braille</dt><dd>Sí</dd>{/if}
      </dl>
    </section>
    <section class="tarjeta seccion">
      <h3>Contactos</h3>
      {#if !contactos.length}<p class="suave sin-margen">Sin contactos.</p>{:else}
        {#each contactos.slice(0, 4) as c (c.id)}<div style="margin-bottom:.5rem"><strong>{c.nombre}</strong><br><span class="suave pequeno">{CONTACTO_TIPOS[c.tipo] ?? c.tipo}{c.telefono ? ' · ' + c.telefono : ''}</span></div>{/each}
      {/if}
      <button class="btn enlace" onclick={() => irA('datos')}>Ver todos</button>
    </section>
  </aside>
</div>

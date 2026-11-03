<script lang="ts">
  import { spd } from '../api.ts';
  import type { VersionPublicada } from '../../dominio/actualizaciones.ts';
  import type { Ajustes, DatosFarmacia, UsuarioPublico, MomentoTomaDto, EstadoCopias, CopiaDto, PreferenciasActualizaciones, ImpresoraDto, RolUsuario, EstadoSistema } from '../../servicios/api.ts';
  import { ir } from '../router.ts';
  import { fechaHora } from '../lib/formato.ts';
  import Cargando from '../componentes/Cargando.svelte';
  import Aviso from '../componentes/Aviso.svelte';
  import Campo from '../componentes/Campo.svelte';
  import Dialogo from '../componentes/Dialogo.svelte';
  import Confirmar from '../componentes/Confirmar.svelte';
  import EditorMomentos, { type FilaMomento } from '../componentes/EditorMomentos.svelte';
  import { avisar, fortaleza, inicialesDe, nombreRol, type Aspecto, type Tema } from '../componentes/util.ts';

  let { rol, seccion, aspecto, cambiaAspecto, alcambiar, alcerrar }: {
    rol: RolUsuario; seccion?: string; aspecto: Aspecto; cambiaAspecto: (a: Aspecto) => void; alcambiar: () => void; alcerrar: () => void;
  } = $props();

  const SECCIONES = [
    ['farmacia', 'Farmacia'], ['usuarios', 'Usuarios'], ['momentos', 'Momentos de toma'], ['validez', 'Validez del SPD'], ['blister', 'Disposición del blíster'],
    ['lector', 'Lector de códigos'], ['impresoras', 'Impresoras'], ['copias', 'Copias de seguridad'], ['actualizaciones', 'Actualizaciones'], ['seguridad', 'Seguridad'], ['aspecto', 'Aspecto'], ['acerca', 'Acerca de'],
  ] as const;
  const activa = $derived(SECCIONES.some(s => s[0] === seccion) ? seccion! : 'farmacia');
  const esTitular = $derived(rol === 'titular');
  const ir_ = (s: string) => ir('ajustes/' + s);

  let aj = $state<Ajustes | null>(null); let cargaError = $state<string | null>(null);
  async function cargarAjustes() { const r = await spd.obtenerAjustes(); if (r.ok) aj = r.datos; else cargaError = r.error; }
  $effect(() => { cargarAjustes(); });
  async function guardarAj(parcial: Partial<Ajustes>, msg = 'Ajustes guardados.'): Promise<boolean> {
    const r = await spd.guardarAjustes(parcial);
    if (r.ok) { aj = r.datos; avisar(msg); alcambiar(); return true; }
    avisar(r.error, 'bloqueo', 6000); return false;
  }

  // ───── Farmacia ─────
  let far = $state<DatosFarmacia | null>(null); let errFar = $state<Record<string, string>>({});
  $effect(() => { if (activa === 'farmacia' && !far) spd.obtenerFarmacia().then(r => { if (r.ok) far = { ...r.datos }; }); });
  async function guardarFarmacia() {
    if (!far) return; errFar = {};
    if (!far.nombre?.trim()) errFar.nombre = 'El nombre es obligatorio.';
    if (!far.titular?.trim()) errFar.titular = 'El titular es obligatorio.';
    if (Object.keys(errFar).length) return;
    const r = await spd.guardarFarmacia(far);
    if (r.ok) { far = { ...r.datos }; avisar('Datos de la farmacia guardados.'); } else avisar(r.error, 'bloqueo', 6000);
  }

  // ───── Usuarios ─────
  let usuarios = $state<UsuarioPublico[] | null>(null); let nuevoU = $state(false);
  let nu = $state({ nombre: '', iniciales: '', rol: 'farmaceutico' as RolUsuario, numColegiado: '', pin: '', pin2: '' }); let errU = $state<Record<string, string>>({}); let ocupadoU = $state(false);
  $effect(() => { if (activa === 'usuarios' && !usuarios) spd.listarUsuarios().then(r => { if (r.ok) usuarios = r.datos; }); });
  async function crearUsuario() {
    errU = {};
    if (!nu.nombre.trim()) errU.nombre = 'Escribe el nombre.';
    if (!nu.iniciales.trim()) errU.iniciales = 'Escribe las iniciales.';
    if (!/^\d{4,8}$/.test(nu.pin)) errU.pin = 'El PIN son entre 4 y 8 cifras.'; else if (nu.pin !== nu.pin2) errU.pin2 = 'Los dos PIN no coinciden.';
    if (Object.keys(errU).length) return;
    ocupadoU = true;
    const r = await spd.crearUsuario({ nombre: nu.nombre.trim(), iniciales: nu.iniciales.trim().toUpperCase(), rol: nu.rol, numColegiado: nu.numColegiado.trim() || undefined, pin: nu.pin });
    ocupadoU = false;
    if (r.ok) { nuevoU = false; usuarios = null; avisar('Usuario creado.'); spd.listarUsuarios().then(x => { if (x.ok) usuarios = x.datos; }); } else errU.general = r.error;
  }

  // ───── Momentos ─────
  let momentos = $state<FilaMomento[] | null>(null);
  function cargarMomentos() { spd.listarMomentos().then(r => { if (r.ok) momentos = [...r.datos].sort((a, b) => a.orden - b.orden).map((m: MomentoTomaDto) => ({ id: m.id, nombre: m.nombre, hora: m.hora ?? '', activo: m.activo })); }); }
  $effect(() => { if (activa === 'momentos' && !momentos) cargarMomentos(); });
  async function guardarMomentos() {
    if (!momentos) return;
    const lista = momentos.filter(m => m.nombre.trim());
    if (!lista.some(m => m.activo)) { avisar('Deja al menos un momento activo.', 'atencion'); return; }
    const r = await spd.guardarMomentos(lista.map((m, i) => ({ id: m.id, nombre: m.nombre.trim(), hora: m.hora || undefined, orden: i + 1, activo: m.activo })));
    if (r.ok) { momentos = null; cargarMomentos(); avisar('Momentos de toma guardados.'); } else avisar(r.error, 'bloqueo', 6000);
  }

  // ───── Validez ─────
  let dias = $state<string | number>(14); let ext = $state(false); let pedirExt = $state(false); let validezCargada = false;
  $effect(() => { if (aj && !validezCargada) { dias = aj.diasValidezSpd; ext = aj.validezExtendidaPermitida; validezCargada = true; } });
  async function guardarValidez(conExt = ext) {
    const n = Number(dias);
    if (!Number.isInteger(n) || n < 1 || n > 14) { avisar('La validez estándar son entre 1 y 14 días.', 'atencion'); return; }
    ext = conExt; await guardarAj({ diasValidezSpd: n, validezExtendidaPermitida: conExt });
  }

  // ───── Blíster ─────
  let bl = $state({ inicioDia: 'convencional', rotar180: false, sentidoTomas: 'izquierda_derecha', posicionInicial: 'izquierda' }); let blCargado = false;
  $effect(() => { if (aj && !blCargado) { bl = { inicioDia: aj.inicioDia, rotar180: aj.rotar180, sentidoTomas: aj.sentidoTomas, posicionInicial: aj.posicionInicial }; blCargado = true; } });

  // ───── Lector ─────
  let lector = $state({ modo: 'teclado' as 'teclado' | 'serie', separadorGs: '', puerto: '', baudios: 9600 }); let lecCargado = false;
  $effect(() => { if (aj && !lecCargado) { lector = { modo: aj.lector.modo, separadorGs: aj.lector.separadorGs ?? '', puerto: aj.lector.puerto ?? '', baudios: aj.lector.baudios ?? 9600 }; lecCargado = true; } });
  let recibido = $state<string[]>([]); let probando = $state(false);
  function nombreTecla(e: KeyboardEvent): string {
    if (e.key === 'Enter') return '↵'; if (e.key === 'Tab') return '⇥'; if (e.ctrlKey && e.key === ']') return '‹GS›';
    if (e.key.length === 1) return e.key.charCodeAt(0) === 29 ? '‹GS›' : e.key;
    return '';
  }
  function teclaPrueba(e: KeyboardEvent) {
    if (e.key === 'Escape') { probando = false; (e.currentTarget as HTMLElement).blur(); return; }
    e.preventDefault(); const t = nombreTecla(e); if (t) recibido = [...recibido, t];
  }
  async function guardarLector() { await guardarAj({ lector: { modo: lector.modo, separadorGs: lector.separadorGs, ...(lector.modo === 'serie' ? { puerto: lector.puerto || undefined, baudios: Number(lector.baudios) || 9600 } : {}) } }); }

  // ───── Impresoras ─────
  let impresoras = $state<ImpresoraDto[] | null>(null); let errImp = $state<string | null>(null);
  let iEt = $state(''); let iDoc = $state(''); let impCargadas = false;
  $effect(() => { if (activa === 'impresoras' && !impresoras) spd.listarImpresoras().then(r => { if (r.ok) impresoras = r.datos; else { impresoras = []; errImp = r.error; } }); });
  $effect(() => { if (aj && !impCargadas) { iEt = aj.impresoraEtiquetas ?? ''; iDoc = aj.impresoraDocumentos ?? ''; impCargadas = true; } });
  async function probar(nombre: string, tipo: 'etiqueta' | 'documento') {
    const html = `<html><body style="font-family:sans-serif;padding:8mm"><h2>Prueba de impresión</h2><p>${tipo === 'etiqueta' ? 'Etiqueta' : 'Documento'} · SPD</p><p>Si lees esto, la impresora funciona.</p></body></html>`;
    const r = await spd.imprimirHtml(html, { impresora: nombre || undefined, silenciosa: !!nombre, ...(tipo === 'etiqueta' ? { anchoMm: 60, altoMm: 40 } : {}) });
    if (r.ok) avisar('Se ha enviado la hoja de prueba a la impresora.', 'info'); else avisar(r.error, 'bloqueo', 6000);
  }

  // ───── Copias ─────
  let copias = $state<EstadoCopias | null>(null); let haciendo = $state(false);
  $effect(() => { if (activa === 'copias' && !copias) spd.estadoCopias().then(r => { if (r.ok) copias = r.datos; }); });
  async function hacerCopia() {
    haciendo = true; const r = await spd.crearCopia(); haciendo = false;
    if (r.ok) { avisar('Copia de seguridad creada.'); copias = null; alcambiar(); } else avisar(r.error, 'bloqueo', 7000);
  }
  const ORIGEN: Record<string, string> = { automatica: 'Automática', manual: 'Manual', antes_actualizar: 'Antes de actualizar', antes_restaurar: 'Antes de restaurar', desconocido: 'Sin ficha' };
  let lista = $state<CopiaDto[] | null>(null); let errLista = $state<string | null>(null);
  $effect(() => { if (activa === 'copias' && !lista) spd.listarCopias().then(r => { if (r.ok) lista = r.datos; else errLista = r.error; }); });
  const kb = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  let resC = $state<CopiaDto | null>(null); let rc = $state({ pass: '', passCopia: '', frase: '' }); let pedirPassCopia = $state(false); let errRc = $state<string | null>(null); let restaurando = $state(false);
  function abrirRestaurar(c: CopiaDto) { resC = c; rc = { pass: '', passCopia: '', frase: '' }; pedirPassCopia = false; errRc = null; }
  async function restaurar() {
    if (!resC) return;
    if (rc.frase.trim().toUpperCase() !== 'RESTAURAR') { errRc = 'Escribe RESTAURAR para confirmar.'; return; }
    if (!rc.pass) { errRc = 'Escribe la contraseña de la farmacia.'; return; }
    restaurando = true; errRc = null;
    const r = await spd.restaurarCopia(resC.nombre, rc.pass, rc.passCopia || undefined); restaurando = false;
    if (r.ok) { resC = null; avisar(r.datos.aviso, 'ok', 15000); lista = null; copias = null; alcambiar(); }
    else { errRc = r.error; if (r.codigo === 'CONTRASENA_COPIA') pedirPassCopia = true; }
  }
  async function elegirCarpeta() {
    const r = await spd.elegirCarpeta('Carpeta para las copias de seguridad');
    if (r.ok && r.datos) { if (await guardarAj({ carpetaCopias: r.datos }, 'Carpeta guardada.')) copias = null; } else if (!r.ok) avisar(r.error, 'bloqueo', 6000);
  }

  // ───── Seguridad ─────
  let cs = $state({ actual: '', nueva: '', nueva2: '' }); let errCs = $state<Record<string, string>>({}); let bloqueoMin = $state<string | number>(10); let bmCargado = false;
  $effect(() => { if (aj && !bmCargado) { bloqueoMin = aj.bloqueoMinutos; bmCargado = true; } });
  const fz = $derived(fortaleza(cs.nueva));
  async function cambiarContrasena() {
    errCs = {};
    if (!cs.actual) errCs.actual = 'Escribe la contraseña actual.';
    if (cs.nueva.length < 10) errCs.nueva = 'La contraseña nueva debe tener al menos 10 caracteres.'; else if (fz.nivel < 2) errCs.nueva = 'Es demasiado fácil de adivinar.';
    else if (cs.nueva !== cs.nueva2) errCs.nueva2 = 'Las dos contraseñas no coinciden.';
    if (Object.keys(errCs).length) return;
    const r = await spd.cambiarContrasena(cs.actual, cs.nueva);
    if (r.ok) { cs = { actual: '', nueva: '', nueva2: '' }; avisar('Contraseña cambiada.'); } else errCs.actual = r.error;
  }

  // ───── Actualizaciones ─────
  let prefAct = $state<PreferenciasActualizaciones | null>(null); let buscandoAct = $state(false); let msgAct = $state<{ tipo: 'info' | 'ok' | 'atencion' | 'bloqueo'; texto: string } | null>(null);
  let versiones = $state<VersionPublicada[] | null>(null); let errVer = $state<string | null>(null); let cargandoVer = $state(false);
  $effect(() => { if (activa === 'actualizaciones' && !prefAct) spd.estadoActualizaciones().then(r => { if (r.ok) prefAct = r.datos; }); });
  async function guardarPrefAct(p: { comprobarAlArrancar?: boolean; versionIgnorada?: string | null }) { const r = await spd.guardarPreferenciasActualizaciones(p); if (r.ok) prefAct = r.datos; else avisar(r.error, 'bloqueo', 6000); }
  async function buscarAct() {
    buscandoAct = true; msgAct = null; const r = await spd.buscarActualizaciones(); buscandoAct = false;
    msgAct = r.ok ? { tipo: r.datos.estado === 'al_dia' ? 'ok' : 'info', texto: r.datos.mensaje } : { tipo: 'bloqueo', texto: r.error };
    prefAct = null;
  }
  async function cargarVersiones() { cargandoVer = true; errVer = null; const r = await spd.listarVersiones(); cargandoVer = false; if (r.ok) versiones = r.datos; else errVer = r.error; }

  // ───── Acerca de ─────
  const TEXTO_DONACION = 'Apoya el software gratuito con una donación por PayPal a boarding87@gmail.com';
  let copiadoDon = $state(false);
  async function copiarDonacion() {
    try { await navigator.clipboard.writeText('boarding87@gmail.com'); copiadoDon = true; setTimeout(() => (copiadoDon = false), 3000); }
    catch { avisar('No se pudo copiar: selecciona el texto y cópialo con Ctrl+C.', 'atencion', 5000); }
  }
  let sistema = $state<EstadoSistema | null>(null);
  $effect(() => { if (activa === 'acerca' && !sistema) spd.estado().then(r => { if (r.ok) sistema = r.datos; }); });
</script>

<div class="cabecera-pagina"><h1>Ajustes</h1></div>
<div class="ajustes-cols">
  <nav class="ajustes-menu" aria-label="Secciones de ajustes">
    {#each SECCIONES as [id, texto]}<button class:activo={activa === id} aria-current={activa === id ? 'page' : undefined} onclick={() => ir_(id)}>{texto}</button>{/each}
  </nav>
  <div>
    {#if cargaError}<Aviso tipo="bloqueo" titulo="No se han podido cargar los ajustes">{cargaError}</Aviso>{/if}

    {#if activa === 'farmacia'}
      <div class="tarjeta apilado"><h2>Datos de la farmacia</h2>
        {#if !far}<Cargando />{:else}
          <div class="cols-2">
            <Campo etiqueta="Nombre de la farmacia" bind:valor={far.nombre} error={errFar.nombre} requerido />
            <Campo etiqueta="Titular" bind:valor={far.titular} error={errFar.titular} requerido />
            <Campo etiqueta="NIF" bind:valor={far.nif} /><Campo etiqueta="Número de autorización" bind:valor={far.numeroAutorizacion} />
            <div class="col-2"><Campo etiqueta="Dirección" bind:valor={far.direccion} /></div>
            <Campo etiqueta="Código postal" bind:valor={far.codigoPostal} inputmode="numeric" maxlength={5} /><Campo etiqueta="Municipio" bind:valor={far.municipio} />
            <Campo etiqueta="Provincia" bind:valor={far.provincia} /><Campo etiqueta="Comunidad autónoma" bind:valor={far.comunidadAutonoma} />
            <Campo etiqueta="Teléfono" bind:valor={far.telefono} inputmode="tel" /><Campo etiqueta="Correo electrónico" tipo="email" bind:valor={far.email} />
          </div>
          <h3>Declaración del servicio y protección de datos</h3>
          <div class="cols-2">
            <Campo etiqueta="Fecha de la declaración del servicio SPD" tipo="fecha" bind:valor={far.spdDeclaracionFecha} /><Campo etiqueta="Referencia de la declaración" bind:valor={far.spdDeclaracionRef} />
            <Campo etiqueta="Responsable del tratamiento de datos" bind:valor={far.rgpdResponsable} /><Campo etiqueta="Contacto para protección de datos" bind:valor={far.rgpdContacto} />
            <Campo etiqueta="Delegado de protección de datos (si lo hay)" bind:valor={far.rgpdDpd} />
          </div>
          <div class="fila fin"><button class="btn principal" onclick={guardarFarmacia}>Guardar</button></div>
        {/if}
      </div>

    {:else if activa === 'usuarios'}
      <div class="tarjeta apilado"><div class="fila"><h2 class="sin-margen">Usuarios</h2><span class="espacio"></span>{#if esTitular}<button class="btn principal" onclick={() => { nuevoU = true; nu = { nombre: '', iniciales: '', rol: 'farmaceutico', numColegiado: '', pin: '', pin2: '' }; errU = {}; }}>Nuevo usuario</button>{/if}</div>
        {#if !usuarios}<Cargando />{:else}
          <table class="tabla"><thead><tr><th>Nombre</th><th>Iniciales</th><th>Función</th></tr></thead><tbody>{#each usuarios as u (u.id)}<tr><td class="negrita">{u.nombre}</td><td>{u.iniciales}</td><td>{nombreRol(u.rol)}</td></tr>{/each}</tbody></table>
        {/if}
        {#if !esTitular}<Aviso tipo="info">Solo el titular puede añadir usuarios.</Aviso>{/if}
        <p class="suave pequeno sin-margen">Cada persona entra con su PIN y todo lo que hace queda registrado a su nombre. Solo farmacéuticos y titular pueden validar un blíster.</p>
      </div>

    {:else if activa === 'momentos'}
      <div class="tarjeta apilado"><h2>Momentos de toma</h2>
        <p class="suave sin-margen">Son las columnas del blíster. Si desactivas uno, deja de ofrecerse, pero lo ya preparado se conserva.</p>
        {#if !momentos}<Cargando />{:else}<EditorMomentos bind:momentos modo="ajustes" /><div class="fila fin"><button class="btn principal" onclick={guardarMomentos}>Guardar</button></div>{/if}
      </div>

    {:else if activa === 'validez'}
      <div class="tarjeta apilado"><h2>Validez del SPD</h2>
        {#if !aj}<Cargando />{:else}
          <Campo etiqueta="Validez estándar (días)" tipo="numero" bind:valor={dias} min={1} max={14} step={1} ayuda="La referencia son 14 días desde la preparación. Es la fecha que sale en la etiqueta." disabled={!esTitular} />
          <label class="marca"><input type="checkbox" checked={ext} disabled={!esTitular} onchange={(e) => { if (e.currentTarget.checked) { e.currentTarget.checked = false; pedirExt = true; } else guardarValidez(false); }} />Permitir preparar hasta 30 días</label>
          {#if ext}<Aviso tipo="atencion" titulo="Desviación asumida por la farmacia">Preparar para más de 14 días <strong>no es lo que recomiendan los documentos de referencia</strong>. Cada preparación de más de 14 días pedirá una justificación escrita y quedará registrada. La responsabilidad es de la farmacia.</Aviso>{/if}
          {#if !esTitular}<Aviso tipo="info">Solo el titular puede cambiar la validez.</Aviso>{:else}<div class="fila fin"><button class="btn principal" onclick={() => guardarValidez()}>Guardar</button></div>{/if}
        {/if}
      </div>

    {:else if activa === 'blister'}
      <div class="tarjeta apilado"><h2>Disposición del blíster</h2>
        <p class="suave sin-margen">Cada fabricante orienta el blíster de forma distinta. Elige la que coincide con el tuyo; se aplica a la pantalla de preparar, a la hoja de trabajo y a la etiqueta.</p>
        {#if !aj}<Cargando />{:else}
          <Campo etiqueta="Filas del blíster" tipo="seleccion" bind:valor={bl.inicioDia} opciones={[{ valor: 'convencional', texto: 'Días fijos de la semana (lunes a domingo)' }, { valor: 'cronologico', texto: 'Empieza en el primer día de la preparación' }]}
            ayuda={bl.inicioDia === 'convencional' ? 'Un blíster que empieza en miércoles rellena la fila del miércoles; la del lunes lleva el lunes siguiente.' : 'La primera fila es el primer día; cada fila siguiente es el día siguiente.'} />
          <Campo etiqueta="Orden de las tomas" tipo="seleccion" bind:valor={bl.sentidoTomas} opciones={[{ valor: 'izquierda_derecha', texto: 'De izquierda a derecha (desayuno primero)' }, { valor: 'derecha_izquierda', texto: 'De derecha a izquierda (noche primero)' }]} />
          <Campo etiqueta="Por qué lado se empieza a llenar" tipo="seleccion" bind:valor={bl.posicionInicial} opciones={[{ valor: 'izquierda', texto: 'Por la izquierda' }, { valor: 'derecha', texto: 'Por la derecha' }]} />
          <label class="marca"><input type="checkbox" bind:checked={bl.rotar180} />El blíster se coloca girado 180°</label>
          <div class="fila fin"><button class="btn principal" onclick={() => guardarAj({ inicioDia: bl.inicioDia as Ajustes['inicioDia'], rotar180: bl.rotar180, sentidoTomas: bl.sentidoTomas as Ajustes['sentidoTomas'], posicionInicial: bl.posicionInicial as Ajustes['posicionInicial'] })}>Guardar</button></div>
        {/if}
      </div>

    {:else if activa === 'lector'}
      <div class="tarjeta apilado"><h2>Lector de códigos</h2>
        {#if !aj}<Cargando />{:else}
          <Campo etiqueta="Cómo está conectado" tipo="seleccion" bind:valor={lector.modo} opciones={[{ valor: 'teclado', texto: 'Como un teclado (USB, lo más habitual)' }, { valor: 'serie', texto: 'Por puerto serie (USB-COM)' }]} />
          {#if lector.modo === 'serie'}<div class="cols-2"><Campo etiqueta="Puerto" bind:valor={lector.puerto} placeholder="COM3" /><Campo etiqueta="Velocidad" tipo="numero" bind:valor={lector.baudios} /></div>{/if}
          <Campo etiqueta="Carácter que sustituye al separador de grupos (GS)" bind:valor={lector.separadorGs} maxlength={3} ayuda="Déjalo vacío si el lector ya envía el separador. Si ves un símbolo raro en la prueba, indícalo aquí." />
          <div class="fila fin"><button class="btn principal" onclick={guardarLector}>Guardar</button></div>
          <hr style="border:none;border-top:1px solid var(--borde);width:100%">
          <h3>Prueba del lector</h3>
          {#if lector.modo === 'teclado'}
            <p class="suave sin-margen">Pulsa en el recuadro y lee un código con el lector (o teclea). Verás lo que llega, carácter a carácter; ‹GS› es el separador y ↵ el final.</p>
            <div class="recibido" tabindex="0" role="textbox" aria-label="Zona de prueba del lector" onkeydown={teclaPrueba} onfocus={() => (probando = true)} onblur={() => (probando = false)}>
              {#if recibido.length}{recibido.join('')}{:else}<span class="suave">{probando ? 'Esperando lectura…' : 'Pulsa aquí y lee un código'}</span>{/if}</div>
            <div class="fila"><button class="btn" onclick={() => (recibido = [])}>Borrar</button><span class="suave pequeno">{recibido.length} caracteres</span></div>
          {:else}<Aviso tipo="info">La prueba del lector serie solo está disponible en la aplicación de escritorio.</Aviso>{/if}
        {/if}
      </div>

    {:else if activa === 'impresoras'}
      <div class="tarjeta apilado"><h2>Impresoras</h2>
        {#if !impresoras || !aj}<Cargando />
        {:else}
          {#if errImp}<Aviso tipo="atencion" titulo="No se pudo leer la lista">{errImp}</Aviso>{/if}
          {#if !impresoras.length}<p class="suave">No se han encontrado impresoras instaladas.</p>{/if}
          {#each [['Impresora de etiquetas', 'etiqueta'], ['Impresora de documentos', 'documento']] as [titulo, tipo]}
            <div class="fila" style="align-items:flex-end"><div style="flex:1">
              {#if tipo === 'etiqueta'}<Campo etiqueta={titulo ?? ''} tipo="seleccion" bind:valor={iEt} opciones={[{ valor: '', texto: 'La predeterminada de Windows' }, ...impresoras.map(i => ({ valor: i.nombre, texto: i.nombre + (i.predeterminada ? ' (predeterminada)' : '') }))]} />
              {:else}<Campo etiqueta={titulo ?? ''} tipo="seleccion" bind:valor={iDoc} opciones={[{ valor: '', texto: 'La predeterminada de Windows' }, ...impresoras.map(i => ({ valor: i.nombre, texto: i.nombre + (i.predeterminada ? ' (predeterminada)' : '') }))]} />{/if}
            </div><button class="btn" style="margin-bottom:.8rem" onclick={() => probar(tipo === 'etiqueta' ? iEt : iDoc, tipo as 'etiqueta' | 'documento')}>Probar</button></div>
          {/each}
          <div class="fila fin"><button class="btn principal" onclick={() => guardarAj({ impresoraEtiquetas: iEt || null, impresoraDocumentos: iDoc || null })}>Guardar</button></div>
        {/if}
      </div>

    {:else if activa === 'copias'}
      <div class="tarjeta apilado"><h2>Copias de seguridad</h2>
        {#if !copias || !aj}<Cargando />{:else}
          {#if copias.atrasada}<Aviso tipo="atencion" titulo="Copia atrasada">{copias.ultima ? 'La última copia es del ' + fechaHora(copias.ultima) + '.' : 'Todavía no has hecho ninguna copia.'} Haz una ahora.</Aviso>
          {:else}<Aviso tipo="ok" titulo="Copias al día">Última copia: {fechaHora(copias.ultima)}.</Aviso>{/if}
          <dl class="par"><dt>Copias guardadas</dt><dd>{copias.total}</dd><dt>Carpeta</dt><dd>{aj.carpetaCopias ?? copias.carpeta ?? 'La carpeta por defecto del programa'}</dd></dl>
          <div class="fila"><button class="btn" onclick={elegirCarpeta}>Elegir carpeta…</button><span class="espacio"></span>
            <button class="btn principal" onclick={hacerCopia} disabled={haciendo}>{haciendo ? 'Creando copia…' : 'Crear copia ahora'}</button></div>
          <p class="suave pequeno sin-margen">Las copias van cifradas. Guarda también una copia fuera del ordenador (otro disco o la nube de la farmacia).</p>
        {/if}
      </div>
      <div class="tarjeta apilado"><h2>Copias guardadas</h2>
        {#if errLista}<Aviso tipo="bloqueo" titulo="No se pueden listar">{errLista}</Aviso>
        {:else if !lista}<Cargando />
        {:else if lista.length === 0}<p class="suave">Todavía no hay copias.</p>
        {:else}
          <table class="tabla"><thead><tr><th>Fecha</th><th>Origen</th><th>Programa</th><th>Motivo</th><th>Tamaño</th><th></th></tr></thead><tbody>
            {#each lista as c (c.nombre)}<tr><td>{fechaHora(c.fecha)}</td><td>{ORIGEN[c.origen]}</td><td>{c.versionApp ?? '—'}</td><td>{c.motivo ?? '—'}{#if c.avisoRestauracion}<div class="pequeno suave">{c.avisoRestauracion}</div>{/if}</td><td>{kb(c.tamano)}</td>
              <td>{#if esTitular}<button class="btn" onclick={() => abrirRestaurar(c)} disabled={!c.restaurable}>Restaurar…</button>{/if}</td></tr>{/each}
          </tbody></table>
          {#if !esTitular}<p class="suave pequeno sin-margen">Sólo el titular puede restaurar una copia.</p>{/if}
          <p class="suave pequeno sin-margen">Se conservan siempre las últimas copias hechas antes de actualizar o de restaurar. Una copia de una versión anterior del programa se restaura y se adapta sola; una de una versión posterior se rechaza.</p>
        {/if}
      </div>

    {:else if activa === 'actualizaciones'}
      <div class="tarjeta apilado"><h2>Actualizaciones</h2>
        {#if !prefAct}<Cargando />{:else}
          <dl class="par"><dt>Versión instalada</dt><dd>{prefAct.versionActual}</dd><dt>Última comprobación</dt><dd>{prefAct.ultimaComprobacion ? fechaHora(prefAct.ultimaComprobacion) : 'Nunca'}</dd></dl>
          <label class="marca"><input type="checkbox" checked={prefAct.comprobarAlArrancar} onchange={(e) => guardarPrefAct({ comprobarAlArrancar: e.currentTarget.checked })} />Buscar actualizaciones al abrir el programa</label>
          {#if prefAct.versionIgnorada}<p class="suave pequeno sin-margen">No se avisa de la versión {prefAct.versionIgnorada}. <button class="btn" onclick={() => guardarPrefAct({ versionIgnorada: null })}>Volver a avisar</button></p>{/if}
          <div class="fila"><button class="btn principal" onclick={buscarAct} disabled={buscandoAct}>{buscandoAct ? 'Buscando…' : 'Buscar actualizaciones'}</button></div>
          {#if msgAct}<Aviso tipo={msgAct.tipo} titulo="Actualizaciones">{msgAct.texto}</Aviso>{/if}
          <p class="suave pequeno sin-margen">Sólo se consulta la página de versiones del proyecto (github.com/PharmaJava/SPD) por internet seguro. No se envía ningún dato de la farmacia ni de pacientes. Nada se descarga ni se instala sin que lo aceptes; antes de instalar se hace una copia de seguridad y se comprueba la suma SHA-256 del instalador.</p>
        {/if}
      </div>
      <div class="tarjeta apilado"><h2>Volver a una versión anterior</h2>
        <Aviso tipo="atencion" titulo="Léelo antes">Una versión nueva puede cambiar la forma de guardar los datos, y una versión antigua no abre datos guardados por una más nueva. Para volver atrás: 1) instala la versión anterior (instalador de abajo, sobre la actual) y 2) restaura la copia «Antes de actualizar» en Ajustes → Copias de seguridad. Lo hecho después de esa copia se pierde.</Aviso>
        <div class="fila"><button class="btn" onclick={cargarVersiones} disabled={cargandoVer}>{cargandoVer ? 'Consultando…' : 'Ver versiones publicadas'}</button></div>
        {#if errVer}<Aviso tipo="bloqueo" titulo="No se pudo consultar">{errVer}</Aviso>{/if}
        {#if versiones}
          <table class="tabla"><thead><tr><th>Versión</th><th>Fecha</th><th>Enlaces</th><th>SHA-256 del instalador</th></tr></thead><tbody>
            {#each versiones as v (v.version)}<tr><td class="negrita">{v.version}{v.esActual ? ' (instalada)' : ''}</td><td>{v.fecha ? fechaHora(v.fecha) : '—'}</td>
              <td><a href={v.urlPagina} target="_blank" rel="noopener noreferrer">Notas</a>{#if v.instalador} · <a href={v.instalador.url} target="_blank" rel="noopener noreferrer">Instalador</a>{/if}</td>
              <td class="mono pequeno">{v.instalador?.sha256 ?? 'no disponible'}</td></tr>{/each}
          </tbody></table>
          <p class="suave pequeno sin-margen">Comprueba que el SHA-256 del fichero descargado coincide con el de la tabla antes de ejecutarlo. Los instaladores no están firmados: Windows puede avisar de «aplicación no reconocida».</p>
        {/if}
      </div>

    {:else if activa === 'seguridad'}
      <div class="tarjeta apilado"><h2>Cambiar la contraseña</h2>
        <Campo etiqueta="Contraseña actual" tipo="contrasena" bind:valor={cs.actual} error={errCs.actual} autocomplete="current-password" />
        <Campo etiqueta="Contraseña nueva" tipo="contrasena" bind:valor={cs.nueva} error={errCs.nueva} autocomplete="new-password" ayuda="Mínimo 10 caracteres.">
          {#if cs.nueva}<div class="medidor" aria-hidden="true">{#each [1,2,3,4] as i}<span class={fz.nivel >= i ? 'on-' + fz.nivel : ''}></span>{/each}</div><div class="pequeno suave">Fortaleza: {fz.texto}</div>{/if}</Campo>
        <Campo etiqueta="Repite la contraseña nueva" tipo="contrasena" bind:valor={cs.nueva2} error={errCs.nueva2} autocomplete="new-password" onenter={cambiarContrasena} />
        <div class="fila fin"><button class="btn principal" onclick={cambiarContrasena}>Cambiar contraseña</button></div>
      </div>
      <div class="tarjeta apilado" style="margin-top:1rem"><h2>Bloqueo automático</h2>
        <Campo etiqueta="Bloquear tras (minutos sin actividad)" tipo="numero" bind:valor={bloqueoMin} min={0} max={240} step={1} ayuda="0 = no bloquear solo. Recomendado en un mostrador con público." disabled={!esTitular} />
        {#if esTitular}<div class="fila fin"><button class="btn" onclick={() => guardarAj({ bloqueoMinutos: Math.max(0, Number(bloqueoMin) || 0) })}>Guardar</button></div>{/if}
      </div>
      <div class="tarjeta apilado" style="margin-top:1rem"><h2>Clave de recuperación</h2>
        <Aviso tipo="info" titulo="Pendiente">Por seguridad la clave no se puede volver a ver. Poder generar una nueva (pidiendo la contraseña) todavía no está disponible: si dudas de dónde está tu copia impresa, avisa a quien mantiene el programa.</Aviso>
      </div>

    {:else if activa === 'aspecto'}
      <div class="tarjeta apilado"><h2>Aspecto</h2>
        <fieldset style="border:none;padding:0;margin:0"><legend style="font-weight:600;margin-bottom:.3rem">Tema</legend>
          <div class="opciones-radio">{#each [['auto', 'Como el sistema'], ['claro', 'Claro'], ['oscuro', 'Oscuro']] as [v, t]}
            <label class="marca"><input type="radio" name="tema" value={v} checked={aspecto.tema === v} onchange={() => cambiaAspecto({ ...aspecto, tema: v as Tema })} />{t}</label>{/each}</div></fieldset>
        <fieldset style="border:none;padding:0;margin:0"><legend style="font-weight:600;margin-bottom:.3rem">Tamaño de la letra</legend>
          <div class="opciones-radio">{#each [[16, 'Normal'], [18, 'Grande'], [20, 'Muy grande']] as [v, t]}
            <label class="marca"><input type="radio" name="letra" value={v} checked={aspecto.letra === v} onchange={() => cambiaAspecto({ ...aspecto, letra: v as number })} />{t}</label>{/each}</div></fieldset>
        <p class="suave pequeno sin-margen">Se guarda en este ordenador.</p>
      </div>

    {:else if activa === 'acerca'}
      <div class="tarjeta apilado"><h2>Acerca de SPD</h2>
        <dl class="par"><dt>Versión</dt><dd>{sistema?.version ?? '…'}</dd><dt>Desarrollador</dt><dd>PharmaJava</dd><dt>Datos en</dt><dd class="mono pequeno">{sistema?.rutaDatos ?? '…'}</dd></dl>
        <p>SPD está desarrollado por <strong>PharmaJava</strong>: farmacéutico y programador. Es un programa <strong>gratuito (freeware)</strong> y forma parte de la suite de herramientas y atención farmacéutica de <a href="https://conveniodefarmacia.com" target="_blank" rel="noopener noreferrer">conveniodefarmacia.com</a> (web y contacto).</p>
        <Aviso tipo="atencion" titulo="Aviso legal">SPD es una herramienta de registro, organización e impresión. <strong>No es un producto sanitario</strong>, no decide dosis ni tratamientos y no sustituye el criterio del farmacéutico ni la ficha técnica. La farmacia es la responsable de verificar cada preparación y de los datos de sus pacientes. Los textos de consentimiento que incluye son <strong>borradores</strong> para revisar con un profesional del derecho antes de usarlos.</Aviso>
        <div class="suave pequeno" style="border-top:1px solid var(--borde, #ddd);padding-top:.6rem">
          <strong>¿Te ha gustado SPD?</strong> <span class="seleccionable" style="user-select:text">{TEXTO_DONACION}</span>.
          <button class="btn" style="margin-left:.4rem" onclick={copiarDonacion}>{copiadoDon ? 'Copiado' : 'Copiar'}</button>
          <div>Donar es voluntario y no da ninguna ventaja: el programa es igual para todos.</div>
        </div>
        <h3>Licencia de uso (freeware)</h3>
        <div class="licencia">
          <p>Se concede a cualquier persona o farmacia el derecho gratuito e indefinido de instalar y usar el programa en tantos equipos como necesite, y de copiarlo y redistribuirlo sin modificar y sin cobrar.</p>
          <p>No se puede vender, incluir en un producto de pago, modificar, descompilar ni quitar el aviso del autor.</p>
          <p>El programa se ofrece «tal cual», sin garantía ni soporte. El usuario debe mantener sus propias copias de seguridad.</p>
          <p class="suave pequeno">Texto completo en el archivo LICENSE.txt que acompaña al programa. Copyright © 2026 PharmaJava.</p>
        </div>
      </div>
    {/if}
  </div>
</div>

<Dialogo abierto={nuevoU} titulo="Nuevo usuario" onclose={() => (nuevoU = false)}>
  <Campo etiqueta="Nombre" bind:valor={nu.nombre} error={errU.nombre} requerido autofocus />
  <div class="cols-2">
    <Campo etiqueta="Iniciales" bind:valor={nu.iniciales} error={errU.iniciales} maxlength={4} requerido />
    <Campo etiqueta="Función" tipo="seleccion" bind:valor={nu.rol} opciones={(['titular', 'farmaceutico', 'tecnico', 'administrativo'] as const).map(r => ({ valor: r, texto: nombreRol(r) }))} />
  </div>
  {#if nu.rol === 'farmaceutico' || nu.rol === 'titular'}<Campo etiqueta="Nº de colegiado" bind:valor={nu.numColegiado} />{/if}
  <div class="cols-2">
    <Campo etiqueta="PIN (4 a 8 cifras)" tipo="contrasena" bind:valor={nu.pin} error={errU.pin} inputmode="numeric" maxlength={8} requerido />
    <Campo etiqueta="Repite el PIN" tipo="contrasena" bind:valor={nu.pin2} error={errU.pin2} inputmode="numeric" maxlength={8} requerido onenter={crearUsuario} />
  </div>
  {#if errU.general}<Aviso tipo="bloqueo" titulo="No se ha creado">{errU.general}</Aviso>{/if}
  {#snippet pie()}<button class="btn" onclick={() => (nuevoU = false)}>Cancelar</button><button class="btn principal" onclick={crearUsuario} disabled={ocupadoU}>Crear usuario</button>{/snippet}
</Dialogo>

<Dialogo abierto={resC !== null} titulo="Restaurar una copia" onclose={() => (resC = null)}>
  {#if resC}
    <Aviso tipo="bloqueo" titulo="Esto sustituye TODOS los datos actuales">Se volverá al estado del {fechaHora(resC.fecha)}: se pierde todo lo hecho después (pacientes, preparaciones, entregas, auditoría). Antes se guardará una copia del estado actual («Antes de restaurar») para poder deshacerlo. Tendrás que volver a iniciar sesión con tu PIN.</Aviso>
    <Campo etiqueta="Contraseña de la farmacia" tipo="contrasena" bind:valor={rc.pass} requerido autofocus />
    {#if pedirPassCopia}<Campo etiqueta="Contraseña que tenía la farmacia cuando se hizo la copia" tipo="contrasena" bind:valor={rc.passCopia} />{/if}
    <Campo etiqueta="Escribe RESTAURAR para confirmar" bind:valor={rc.frase} requerido onenter={restaurar} />
    {#if errRc}<Aviso tipo="bloqueo" titulo="No se ha restaurado">{errRc}</Aviso>{/if}
  {/if}
  {#snippet pie()}<button class="btn" onclick={() => (resC = null)}>Cancelar</button><button class="btn principal" onclick={restaurar} disabled={restaurando}>{restaurando ? 'Restaurando…' : 'Restaurar copia'}</button>{/snippet}
</Dialogo>

<Confirmar abierto={pedirExt} titulo="¿Permitir hasta 30 días?" confirmarTexto="Sí, asumo la desviación" peligro
  mensaje="Preparar para más de 14 días no es lo que recomiendan los documentos de referencia. La farmacia asume la responsabilidad y cada uso se justificará por escrito."
  onconfirmar={async () => { pedirExt = false; await guardarValidez(true); }} oncancelar={() => (pedirExt = false)} />

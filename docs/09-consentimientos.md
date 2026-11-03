# 9. Consentimientos y documentos para firmar

> ⚠️ Las plantillas de `plantillas/consentimientos/` son textos genéricos que
> conviene revisar con un abogado y adaptar a la comunidad autónoma (el aviso
> legal de Ajustes → Acerca de, el README y el manual lo dicen). No llevan la
> marca del programa (lo firma el paciente con la farmacia, el programa no es
> parte) ni citan artículos que no se hayan contrastado. **Ni la pantalla de
> documentos ni el papel impreso llevan marca o banner de «borrador»** (3-nov-2026).

## 9.1 Documentos

| Código | Documento | Cuándo | Obligatorio para validar SPD |
|---|---|---|---|
| `consentimiento_spd` | Consentimiento informado del servicio de SPD (incluye custodia de medicamentos y entrega) | Alta | **Sí** |
| `info_rgpd` | Información sobre protección de datos (art. 13 RGPD) | Alta | Sí (se entrega y se registra la entrega) |
| `autorizacion_terceros` | Autorización a cuidador/familiar para recoger el SPD y recibir información | Cuando lo haya | Si recoge otra persona |
| `comunicacion_medico` | Autorización para comunicarse con el médico prescriptor sobre el tratamiento | Alta (opcional) | No |
| `recibi_devolucion` | Recibí de medicamentos devueltos al paciente al terminar el servicio | Baja | — |
| `revocacion` | Revocación del consentimiento / baja del servicio | Cuando ocurra | — |

## 9.2 Cómo funcionan en el programa

1. Las plantillas viven en `plantilla_documento` con **versión**. Editar una
   crea la versión siguiente; las firmadas siguen apuntando a la suya.
2. Al imprimir se rellenan las variables (`{{farmacia.nombre}}`,
   `{{paciente.nombre_completo}}`, `{{firmante.nombre}}`…) y se guarda **el
   texto exacto impreso** y su hash SHA-256 (`documento_firmado`).
3. El papel firmado se puede escanear y adjuntar.
4. La ficha del paciente enseña qué tiene firmado, qué versión, y si una
   plantilla ha cambiado desde entonces (para decidir si re-firmar).
5. Sin `consentimiento_spd` vigente el programa **no deja validar** una
   preparación. Si se revoca, las preparaciones pendientes se paran. Esto es
   así **mientras el titular no desactive el ajuste «Exigir consentimientos
   firmados para validar»** (§9.5).

## 9.3 Firma

- **Papel** (por defecto): se imprime, se firma, se marca como firmado y,
  opcionalmente, se escanea.
- **Tableta de firma** (fase posterior): imagen de la firma incrustada en el
  PDF. Una firma manuscrita digitalizada simple no es una firma electrónica
  avanzada; para el uso interno de la farmacia suele bastar, pero es una
  pregunta para el abogado.

## 9.4 Variables disponibles

`farmacia.*` (nombre, titular, nif, direccion, municipio, telefono, email,
rgpd_contacto, rgpd_dpd) · `paciente.*` (nombre_completo, dni_nie,
fecha_nacimiento, direccion) · `firmante.*` (nombre, dni_nie, calidad) ·
`fecha.hoy`, `fecha.efecto` · `autorizado.*` (nombre, dni_nie, parentesco, telefono) · `motivo` · `tabla_envases_devueltos`, `tabla_envases_sigre` · `documento.version` · `documento.id`.

Una variable sin valor **no se imprime en blanco**: la vista previa la marca y no deja imprimir la versión definitiva.

## 9.4 Consentimientos opcionales (decisión de la farmacia)

Ajuste `exigir_consentimientos` (Ajustes → Consentimientos), **activado por
defecto**. Sólo el titular lo cambia, con motivo escrito (mínimo 5 caracteres),
en cualquier sentido, y queda en la auditoría.

- **Desactivado**: `estadoConsentimientos()` sigue diciendo qué falta
  (`completo = false`), pero con `exigido = false` ni `evaluarPreparacion()` ni
  `validarPreparacion()` bloquean: lo pendiente sale como **aviso informativo**
  (`CONSENTIMIENTO_NO_EXIGIDO`) y en «Hoy» como información, no en rojo.
- **La responsabilidad es de la farmacia**: el programa lo dice en el ajuste y
  en la confirmación («la farmacia asume la responsabilidad de gestionarlos
  fuera del programa»).
- El ajuste solo relaja los consentimientos. El rol que valida, la alergia sin
  confirmar, las cajas caducadas y las alertas de calidad **siguen bloqueando**.
- Un valor ilegible o ausente del ajuste **exige** (solo `0`, `false` o `no`
  lo relajan).

## 9.5 «Gestionado sin firma individual»

Para residencias y centros que recogen los consentimientos ellos mismos. La
farmacia deja constancia **sin falsear una firma**:

- Se guarda en `documento_firmado` con `origen = 'gestionado_sin_firma'`,
  `firmante_calidad = 'sin_firma'` y `motivo_gestion` obligatorio (restricción
  `CHECK` de la base: no puede hacerse pasar por una firma del paciente).
- `texto_impreso` es una **constancia** («GESTIONADO SIN FIRMA INDIVIDUAL… No
  consta firma del paciente…»), con su hash; no imita el documento firmado y
  nunca se imprime como firmado.
- Sólo se pueden gestionar `consentimiento_spd`, `info_rgpd` y
  `comunicacion_medico`. `recibi_devolucion`, `revocacion` y
  `autorizacion_terceros` se firman en el acto o por persona.
- **Por paciente** (pestaña Documentos) o **masivo por centro** («Aceptar
  todo» en la lista de pacientes filtrada por centro): sólo pacientes
  **activos** del centro; el diálogo cuenta antes (`simular`) cuántos pacientes
  y documentos, y cuántos se saltan por tenerlo ya vigente. Todo o nada.
- Sólo titular o farmacéutico. Cada registro se audita (con motivo) y el
  masivo deja además un resumen (`entidad = 'consentimiento'`).
- Cuenta como **vigente** para validar; se ve como «Gestionado por el centro,
  sin firma individual», con fecha, usuario y motivo; es **revocable**; y una
  firma real posterior lo sustituye (con motivo), quedando el gestionado
  revocado en el historial.

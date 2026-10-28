# 9. Consentimientos y documentos para firmar

> ⚠️ Las plantillas de `plantillas/consentimientos/` son **borradores** para
> revisar con un abogado y adaptar a la comunidad autónoma. Son genéricas:
> no llevan la marca del programa (lo firma el paciente con la farmacia, el
> programa no es parte) ni citan artículos que no se hayan contrastado.

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
   preparación. Si se revoca, las preparaciones pendientes se paran.

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

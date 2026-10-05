# Panel Impresora de Pago Proveedores BancoEstado

Panel del Servicio Local de Educación Pública de Petorca para armar las nóminas de carga masiva de pago a proveedores de BancoEstado. Genera archivos en formato DET-SUBDET de 9 columnas, con una nómina por fuente de financiamiento. Es un sitio estático publicado en GitHub Pages. Los datos se guardan en Firestore y los comparte el equipo de Finanzas.

> **Este repositorio es público. Nunca subas datos reales.** Eso incluye RUT de proveedores, cuentas, nóminas `.txt`, planillas con datos, comprobantes PDF de transferencias y respaldos `.json`. El `.gitignore` los excluye, pero revisa `git status` antes de cada commit.

## Estructura

```
index.html                  Panel (4 pasos + Configuración)
css/panel.css               Estilos: mismo sistema visual que Control de DC y Facturación, tema claro y oscuro
js/firebase-config.js       firebaseConfig del proyecto (el mismo de las otras apps)
js/firebase.js              Inicialización, acceso por enlace al correo, firma de escrituras
js/catalogos.js             Bancos, formas de pago, sectores y tipos de documento
js/formato.js               Normalización, validaciones, armado de la nómina y .txt
js/importar.js              Pegar desde Excel, importar xls/xlsx/csv/txt, planilla del banco
js/excel.js                 Excel BancoEstado idéntico, plantilla de documentos y Excel del reporte de pagos
js/pdf.js                   Reporte de pagos en PDF (A4 horizontal)
js/comprobante.js           Lectura del comprobante PDF de una transferencia (imagen del PDF y campos)
js/ocr.js                   OCR del comprobante en el navegador (Tesseract.js)
js/datos.js                 Firestore: suscripciones, transacciones, historial, migración
js/ui/*.js                  Pasos 1 a 4, Remuneraciones, transferencias electrónicas y Configuración
assets/                     Plantillas .xlsx vacías y logos (SLEP Petorca, Educación Pública, Mineduc, BancoEstado)
vendor/                     SheetJS 0.18.5, JSZip 3.10.1, jsPDF 4.2.1, jsPDF-AutoTable 5.0.8 y Tesseract.js 7.0.0 con español (versiones fijadas; jsPDF y Tesseract se cargan solo al usarse)
firestore/bloque_pago.rules Bloque de reglas del panel (con correos marcadores)
referencia/                 Panel anterior (especificación viva)
tests/                      Pruebas (no se publican)
.github/workflows/          Pruebas automáticas en GitHub
```

Se usan módulos ES nativos. No hay framework ni paso de compilación.

## Puesta en marcha

### 1. Configuración de Firebase (ya lista)

`js/firebase-config.js` ya trae la configuración del proyecto `slep-petorca-finanzas-permisos`. Es la misma de Calendariopermisos y del Visor SAF/SPYCG. Es pública por diseño: la seguridad la dan las reglas de Firestore.

El acceso es igual al de esas apps: la persona escribe su correo, recibe un enlace (revisar también Spam) y lo abre en el mismo navegador. El enlace vence en 1 hora. El método *Correo electrónico → Vínculo del correo electrónico (acceso sin contraseña)* ya está habilitado en el proyecto porque lo usan las otras apps.

### 2. Pegar el bloque de reglas en Firestore

1. Abre `firestore/bloque_pago.rules`. Reemplaza los correos marcadores (`admin1@example.com`, `usuario1@example.com`, …) por los reales:
   - `pAdmin()`: administradores (tú);
   - `pAllowed()`: el resto del equipo con acceso.

   Guarda esa copia con los correos reales solo en tu computador, por ejemplo como `firestore/bloque_pago.local.rules` (el `.gitignore` la excluye).
2. En la consola de Firebase, abre *Firestore Database → Reglas*.
3. Pega el bloque completo **justo antes** del bloque final:
   ```
       // Todo lo no declarado queda denegado.
       match /{document=**} {
         allow read, write: if false;
       }
   ```
   No modifiques ninguna línea de los bloques existentes. Los nombres del bloque (`pEmail`, `pAdmin`, `pAllowed`, `pFirmado`, `pContadorPath`) no chocan con los de las otras apps.
4. Pulsa **Publicar**. Si la consola marca un error, no publiques y revisa las comas de las listas de correos.

Respecto del bloque original, se agregó una línea en `pago_nominas`: solo se puede anular una nómina que siga en estado `generada`. La interfaz ya lo exigía; ahora también lo exigen las reglas.

### 3. Autorizar el dominio de GitHub Pages en Firebase Authentication

`signInWithPopup` solo funciona desde dominios autorizados:

1. Abre *Authentication → Settings → Dominios autorizados → Agregar dominio*.
2. Agrega `finanzas-slep-petorca.github.io` (en general, `<usuario u organización>.github.io`, sin `https://` ni la ruta del repositorio).
3. En *Authentication → Método de acceso*, el proveedor **Correo electrónico/contraseña** debe tener activado el **vínculo del correo electrónico (acceso sin contraseña)**. Las otras apps ya lo usan.

Si falta este paso, al pedir el enlace aparece "este dominio no está autorizado en Firebase Authentication".

### 4. Activar GitHub Pages

1. En GitHub, abre *Settings → Pages → Build and deployment*.
2. Elige **Source: Deploy from a branch**, **Branch: main** y carpeta **/ (root)**. Pulsa **Save**.
3. En uno o dos minutos el panel queda en `https://finanzas-slep-petorca.github.io/Generador-Nominas-Pago-en-BancoEstado/`.

Cada cambio que llega a `main` se publica solo. El archivo `.nojekyll` evita que GitHub procese el sitio con Jekyll.

Con esta opción también quedan servidos `tests/`, `referencia/`, `firestore/` y este README. Ninguno tiene datos reales (solo ejemplos ficticios y correos marcadores). Los datos viven en Firestore y solo se leen con una sesión autorizada.

### 5. Migrar los datos del panel anterior (una sola vez)

Los datos actuales viven en el `localStorage` de claude.ai, que no es accesible desde GitHub Pages.

1. En el panel anterior, paso 4, pulsa **Exportar respaldo (.json)**. Si la descarga no está disponible en esa vista, sirve también un objeto con las claves `bepago.maestro.v1`, `bepago.docs.v1`, `bepago.nominas.v1` y `bepago.config.v1` (sus valores pueden venir como texto JSON).
2. En el panel nuevo, entra como administrador y abre **Configuración → Importar respaldo JSON**.
3. Elige el archivo y revisa el resumen: proveedores nuevos o con cambios, documentos pendientes, nóminas y avisos. Recién entonces pulsa **Confirmar e importar**.

Qué hace la importación:

- Escribe en batches, cada escritura firmada y con historial.
- Recrea las nóminas en orden con su número, estado, pagos y resultados, porque las reglas solo dejan crear nóminas en estado `generada` y con el contador en `num + 1`. El contador queda en el número siguiente.
- Solo importa nóminas si la bitácora de Firestore está vacía.
- Deja fuera los documentos pendientes con monto inválido, porque Firestore exige un entero mayor que cero. El resumen los cuenta.

El maestro también se puede cargar solo, con el CSV que exporta el paso 1 (*Importar archivo* en el paso 1).

Guarda el respaldo fuera del repositorio: contiene datos bancarios.

## Lista de acceso: sumar o quitar personas

El acceso lo definen **solo** las reglas de Firestore. El panel no guarda una lista propia: detecta si eres administrador preguntándole a las reglas.

1. En *Firestore Database → Reglas*, busca `function pAllowed()` en el bloque del panel.
2. Para **sumar** a alguien, agrega su correo a la lista, entre comillas y separado por coma. Para **quitarlo**, borra su línea y revisa que no quede una coma sobrante antes del `]`.
3. Los administradores van en `pAdmin()`. Pueden eliminar proveedores, cambiar el RUT de un proveedor e importar respaldos.
4. Pulsa **Publicar**. Firebase aplica las reglas en un par de minutos; las sesiones que ya estaban abiertas pueden tardar hasta unos 10. A quien se quita le aparece "sin acceso" cuando Firestore le rechaza la siguiente lectura o al recargar.
5. Actualiza también tu copia local `firestore/bloque_pago.local.rules`.

Solo entran cuentas con correo verificado (`email_verified`); el acceso por enlace verifica el correo. Esta lista es independiente de `isAllowed()` de las otras apps: estar en una no da acceso a la otra.

## Modelo de datos (Firestore)

| Colección | Contenido |
|---|---|
| `pago_config/general` | `fuentes`, `emailDefecto`, `feriados` (fechas ISO), `prefijoArchivo` (`AAAAMMDD` = fecha del día), `cuentas` (cuentas de origen de las transferencias: `{cuenta, nombre, fuente}`) |
| `pago_config/contador` | `nextNum`: correlativo de nóminas |
| `pago_proveedores/{rut}` | Maestro. Id = RUT sin puntos ni guion |
| `pago_documentos/{id}` | Documentos pendientes, con `dc` y `hist` opcionales. El id ordena por fecha de ingreso, así la nómina respeta el orden de carga |
| `pago_nominas/{num}` | Nóminas: `lineas` como mapas `{tipo, f}`, `pagos` con sus documentos, `fechaCarga`, `fechaPago` (día en que el banco paga la nómina; se mantiene aunque después haya rechazos), `creadaPor` y `cargadaPor` (quién generó y quién cargó; las reglas exigen que sea quien escribe). El resultado del banco se espera desde las 14:00 del día de pago. `tipo`: sin valor (proveedores), `abonos` (remuneraciones) o `transferencia` |
| `pago_abonos/{id}` | Abonos pendientes de la nómina de remuneraciones (7 columnas): RUT, nombre, email, banco, forma, cuenta, monto, fuente, concepto, glosa |
| `pago_historial/{id}` | Bitácora de acciones; solo se agregan entradas |

Toda escritura lleva `updatedBy` (correo) y `updatedAt` (hora del servidor). El historial registra:

- altas y ediciones de proveedores, con antes y después completos cuando cambia banco, cuenta o forma de pago;
- generación, carga, resultados, reintegros y anulación de nóminas;
- borrado de documentos pendientes;
- importaciones.

Tamaño: una nómina ocupa cerca de 300 bytes por documento. Con 500 documentos pesa unos 150 KB; el límite de 1 MB de Firestore recién se acercaría con unos 3.000 documentos en una sola nómina.

Las preferencias de interfaz quedan en `localStorage`: último paso abierto, filtros, fuente por defecto al pegar y "agrupar". Los datos no se guardan en el navegador: Firestore usa caché en memoria.

## Transferencias electrónicas

Los pagos directos por transferencia electrónica (sin nómina) se registran en la Bitácora con **Registrar transferencia**: se sube el **Comprobante** o el **Detalle de Transferencia Electrónica** en PDF, tal como lo descarga BancoEstado (se pueden elegir o soltar varios; quedan en cola). También se puede ingresar a mano.

- **Lectura del PDF** (`js/comprobante.js` y `js/ocr.js`). El banco arma el PDF con una captura de su página: los datos vienen como una imagen RGB comprimida con Flate y una máscara de transparencia, sin texto. El panel extrae esa imagen sin librerías (`DecompressionStream`) y la lee con OCR, con **Tesseract.js 7** y el idioma español (`vendor/tesseract/`, unos 10 MB que se cargan solo al leer el primer comprobante; después quedan en la caché del navegador). Todo corre en el navegador: el PDF no sale del computador. Tarda unos segundos por comprobante.
- **Qué lee:** N° de transferencia, ID TEF, fecha y hora, estado, cuenta de origen y su nombre, beneficiario (nombre, RUT, banco, tipo y N° de cuenta), monto, concepto, mensaje e intervinientes (quién preparó y quiénes autorizaron).
- **Controles:** dígito verificador de los RUT, CuentaRUT igual al RUT, banco conocido, estado `Autorizada`, N° de transferencia ya registrado o repetido entre los PDF subidos, y datos bancarios distintos a los del maestro de proveedores. Si el OCR dudó de algo, el formulario queda abierto para corregir.
- **Qué paga:** si el monto calza exactamente con abonos pendientes de Remuneraciones o con documentos pendientes del mismo RUT (una combinación única, las notas de crédito restan), quedan marcados. Si no, queda como pago sin documento y se avisa.
- **Fuente:** sale de la cuenta de origen asociada en Configuración. Si la cuenta no está asociada, se deduce del nombre de la cuenta (“Subvencion General” → GENERAL) y se avisa.

- Queda en `pago_nominas` con `tipo: "transferencia"`, el mismo correlativo de las nóminas y estado `cargada`, con su único pago ya `pagado`: el banco la autoriza al instante. El N° de transferencia va en `operacion` (columna N° BancoEstado).
- `origen` dice qué paga: `documentos` (pendientes del paso 2), `abonos` (de Remuneraciones) o `suelto` (nada cargado en el panel). Lo que paga sale de pendientes en la misma transacción, y vuelve si la transferencia se anula o se rechaza.
- Cada cuenta de origen se asocia a su fuente en Configuración (`pago_config/general.cuentas`).
- Reglas: una transferencia puede nacer `cargada` si `cargadaPor` es quien la registra y `cargadaAt` es la hora del servidor, y se puede anular (registrada por error). La configuración acepta el campo `cuentas`.

## Nómina de remuneraciones y abonos (7 columnas)

La pestaña **Remuneraciones** arma nóminas con la planilla BancoEstado **“Pago Solo Abonos DET” de 7 columnas**. Sirve para pagar a personas naturales: viáticos, fondos fijos y cajas chicas, honorarios y remuneraciones. Cada línea del archivo es un pago: RUT, nombre, email, banco, forma de pago, N° de cuenta y monto. No lleva documentos ni sector.

- **Cargar:** se importa la planilla del banco ya completa (hoja DETALLE, desde la fila 4) o se pegan filas. El concepto y la fuente se deducen del nombre del archivo cuando se puede.
- **Normalización:** los nombres pasan a mayúsculas sin tildes ni ñ. Las formas de pago sin cuenta (20, 23, 28, 29: vale vista o pago cash) van con el N° de cuenta en blanco, y CuentaRUT (30) usa el RUT sin dígito verificador.
- **Controles:** el panel avisa si:
  - los datos bancarios de una persona cambiaron respecto de su último pago;
  - un RUT y monto se repiten en la nómina;
  - hay un pago igual en otra nómina aún sin resultado.
- **Generar:** una nómina por fuente, con el mismo correlativo y la misma bitácora que proveedores (tipo "Remuneraciones"). Se descargan el .txt (7 campos separados por tabulación, CRLF) y el Excel, hecho sobre `assets/plantilla_abonos_7col.xlsx`, en el que solo se llenan las filas de la hoja DETALLE. El nombre es `AAAAMMDD_CONCEPTO_FUENTE`.
- **Rechazos y anulación:** los abonos vuelven a la pestaña con sus datos bancarios.
- **Reglas:** requiere el bloque `pago_abonos` del archivo de reglas. Mientras no se publique, la pestaña lo avisa y el resto del panel sigue funcionando.

## Diseño

El panel usa el mismo sistema visual que **Control de DC y Facturación**:

- barra superior con los logos de SLEP Petorca, Educación Pública y Mineduc;
- pestañas flotantes con íconos y contadores;
- títulos de sección en dos tonos (azul marino y azul);
- tarjetas blancas redondeadas y tarjetas de colores para los indicadores;
- tipografía Arial.

El selector **Claro / Oscuro / Sistema** de la barra superior funciona igual que en el Visor SAF/SPYCG. La elección se guarda en el navegador. La vista previa de la planilla BancoEstado mantiene siempre los colores oficiales del banco.

## Diferencias con el panel anterior

El formato del archivo, las validaciones y los cálculos son los mismos; `tests/formato.test.mjs` lo verifica ejecutando el código de la referencia. Cambia lo siguiente:

- **Datos compartidos y en tiempo real.** Lo que hace una persona lo ven las demás al instante.
- **Generar nómina es una transacción.** Reserva el número, verifica que cada documento siga pendiente y marcado y que los datos bancarios del proveedor no hayan cambiado mientras se revisaba. Si otro usuario movió algo, se aborta con un mensaje.

  Si dos personas generan a la vez, cada una recibe un número distinto. Con el emulador se comprobó que, en ese choque, Firestore responde "permiso denegado" en vez de reintentar, porque la regla del contador se evalúa con el número ya tomado. Por eso el panel reintenta hasta 5 veces con espera creciente.
- **Anular, reintegrar, cargar y registrar resultados** también son atómicos. Una nómina anulada queda cerrada.
- **Resultado desde el reporte de BancoEstado.** En la bitácora, **Cargar reporte del banco** lee el *Detalle de Nómina* que el banco deja descargar en Excel y registra el resultado de cada pago. Reconoce los tres formatos que publica (proveedores, remuneraciones y el detalle por documento, donde varias filas del mismo RUT son un solo pago) por la fila de encabezados, no por la posición de las columnas. Acepta varios archivos a la vez y dirige cada uno a su nómina por el **N° BancoEstado**.

  Primero muestra una **vista previa** con lo que quedaría registrado; hasta que la persona la aprueba no se escribe nada. Lo que no calza se deja intacto y se avisa: un archivo de otra nómina, una nómina que no está cargada, un monto distinto al de la nómina, un estado que el panel no conoce, un pago ya reintegrado o uno que el banco no informa. Volver a subir el mismo archivo no reescribe nada.

  Traduce solo los estados vistos en archivos reales: `Pagado`, `Rechazado` (con el motivo del banco) y `Pendiente de Cobro`, que es un pago cash o vale vista ya pagado y por cobrar en banco. Al aplicar, los resultados de una nómina van en **una sola transacción**, que vuelve a validar contra la nómina recién leída —entre la vista previa y el botón, otra persona pudo registrar algo— y deja en el historial una entrada con el archivo y una por pago.
- **Columna DC** opcional:
  - se importa desde la plantilla (columna G), como 7.ª columna al pegar documentos, como 13.ª en el formato completo o por encabezado "DC";
  - se muestra en la tabla, viaja a la nómina y a la bitácora, y se puede buscar;
  - la exportación CSV de la bitácora la incluye.
- **Feriados:** el resultado del banco (14:00 del día hábil siguiente) salta también las fechas de Configuración.
- **Monto inválido:** los documentos sin monto válido no se guardan. Se informan al importar.
- **Detalle de Nómina del banco como fuente de documentos.** *Importar archivo* (paso 1 o 2) reconoce el Excel de BancoEstado en la vista *Ver Documento* por sus encabezados: toma el monto de cada documento (`Monto $`, no `Monto Total $`, que es el total del pago y se repite en cada documento) y traduce `Tipo Documento` del texto del banco al código del SII (`FACTURA ELECTRONICA` → 33, `FACTURA NO AFECTA O EXENTA ELECTRONICA` → 34, `NOTA DE CREDITO ELECTRONICA` → 61). Los tipos también se aceptan en texto al pegar. La fuente se deduce del nombre del archivo o del nombre de la nómina. El archivo no trae N° de cuenta, así que a un proveedor del maestro no se le toca nada y uno nuevo queda para completar.
- **Sin duplicados al importar.** Un documento que ya está pendiente (mismo RUT, N° y monto) no se vuelve a agregar; si quedó sin un tipo válido y el archivo trae uno, se completa y queda en el historial.
- **CSV y .txt se leen como texto.** Así no se pierden ceros a la izquierda ni dígitos de cuentas largas.
- **Solo administradores** pueden cambiar el RUT o eliminar un proveedor.
- **Descargas directas** del navegador (Blob). "Copiar texto" sigue disponible.

## Publicar cambios sin copias viejas en caché

GitHub Pages deja los archivos 10 minutos en la caché del navegador. Para que un cambio se vea al recargar, `index.html` carga cada módulo y la hoja de estilos con `?v=` y un código del contenido del archivo (un *import map*). Después de modificar cualquier archivo de `js/` o `css/`, y antes del commit, corre:

```
node tests/versionar.mjs
```

Si se olvida, `npm run formato` (y el workflow **Pruebas**) falla con el aviso "index.html tiene versiones viejas".

## Cómo probar

### Pruebas automáticas (carpeta `tests/`, no se publica)

Requieren Node 20 o superior; las de reglas, también Java 11 o superior.

```
cd tests
npm install
npm run formato   # .txt byte a byte y validaciones contra el código de la referencia
npm run conciliar # lectura del reporte de BancoEstado y conciliación con la bitácora
npm run comprobante # lectura del comprobante PDF de una transferencia (imagen del PDF y campos)
npm run reglas    # bloque de reglas en el emulador de Firestore
npm run e2e       # Chromium contra los emuladores de Auth y Firestore (primera vez: npx playwright install chromium)
```

El workflow **Pruebas** corre `formato`, `conciliar`, `comprobante` y `reglas` en cada push y pull request. Las pruebas usan los correos marcadores del bloque (`admin1@example.com`, `usuario1@example.com`) y solo datos ficticios.

### Probar el panel con emuladores, sin tocar el proyecto real

```
cd tests && npm run emuladores                   # Auth 9099 y Firestore 8080
python3 -m http.server 5000 --bind 127.0.0.1     # desde la raíz del repositorio, en otra terminal
```

Abre `http://localhost:5000/?emulador`. El título muestra "EMULADOR". Escribe un correo de la lista de prueba (por ejemplo `admin1@example.com`) y pide el enlace. El emulador no envía correos: el enlace aparece en la terminal de los emuladores; ábrelo en el mismo navegador. También puedes entrar desde la consola del navegador con `__entrarEmulador("admin1@example.com")`. Ese atajo solo existe en modo emulador, en `localhost`.

### Prueba manual guiada (checklist)

Hazla con **datos ficticios**, en el emulador o en el proyecto real antes de migrar. Si la haces en el real, borra después lo creado desde la consola de Firebase.

- [ ] **Acceso denegado.** Entra con una cuenta que no esté en `pAllowed()`. Debe aparecer "no tiene acceso a este panel" y ningún dato. En la consola del navegador, `getDoc` sobre cualquier colección `pago_` responde `permission-denied`.
- [ ] **Planilla de pago anterior del banco.** En el paso 1, *Importar archivo* con una planilla BancoEstado (.xlsx o .txt de una nómina anterior), o pega sus filas. Deben aparecer los proveedores en el maestro y sus documentos en el paso 2, con la fuente deducida del nombre del archivo (por ejemplo `…_SEP.xlsx` → SEP).
- [ ] **.txt idéntico byte a byte.** Carga los mismos datos ficticios en el panel anterior y en el nuevo. Genera la nómina en el nuevo y compara:
  - `fc /b anterior.txt nuevo.txt` en Windows, o `cmp` en Mac o Linux;
  - la nueva debe tener tabulaciones y CRLF, también al final.

  `npm run formato` y `npm run e2e` hacen esta comparación automáticamente.
- [ ] **Dos usuarios a la vez.** Con dos personas (o dos navegadores con cuentas distintas) y documentos marcados en fuentes distintas, pulsen *Generar nómina* al mismo tiempo. Deben quedar dos nóminas con números distintos y correlativos, y ningún documento en ambas.
- [ ] **Documento movido por otro.** Una persona revisa el paso 3 y otra desmarca uno de esos documentos. Al generar, la primera recibe el aviso de que un documento ya no está marcado y no se crea la nómina.
- [ ] **Nómina anulada cerrada.** Anula una nómina generada. Sus documentos vuelven a pendientes con "Viene de la nómina N° X anulada". El detalle queda sin botones de acción y con los campos deshabilitados. Un intento directo de escribirla (consola del navegador) responde `permission-denied`.
- [ ] **Rechazo y reintegro.** Marca una nómina como cargada y un pago como *Rechazado* con motivo. Luego *Volver a pendientes*: sus documentos vuelven con "Rechazado en nómina N° X: motivo" y el historial de la nómina lo registra.
- [ ] **Control de datos bancarios.** Cambia la cuenta de un proveedor. En su ficha, *Historial del proveedor* muestra el antes y el después.
- [ ] **DC.** Descarga la plantilla de documentos, llena la columna G e impórtala. El DC aparece en la tabla, en el detalle de la nómina, en el buscador de la bitácora y en el CSV.
- [ ] **Feriados.** Agrega un feriado el día hábil siguiente a una carga. "Resultado desde" debe saltarlo.
- [ ] **Móvil.** Abre el panel en el teléfono: los pasos se ven en dos columnas y las tablas se desplazan de lado.

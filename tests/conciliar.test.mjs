// Lectura del reporte de BancoEstado y conciliación con la bitácora.
//   node tests/conciliar.test.mjs
//
// Las filas de ejemplo reproducen los tres formatos reales que publica el banco
// (proveedores, remuneraciones y el detalle por documento), con los mismos
// encabezados, pero con RUT, nombres y montos inventados: en este repositorio
// no entran datos de pagos del Servicio.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { leerReporteBanco, conciliar, repartir, traducirEstado } = await import(path.join(raiz, "js/conciliar.js"));

let ok = 0;
const prueba = (nombre, fn) => { fn(); ok++; console.log("  ✓ " + nombre) };

// ---------- filas de ejemplo ----------
const cabecera = (nOperacion, nombre, total, pagos, estadoNom, convenio = "SLEP EJEMPLO PROVEEDORES(PROV-000)") => [
  ["Mis Nóminas - Ver Nómina"], [],
  ["Fecha : Sep 30, 2026, 3:09:57 PM"], [],
  ["Detalle Nómina"],
  ["Convenio", convenio, "Nº Nómina", nOperacion],
  ["Nombre Nómina", nombre, "Monto Total $", total],
  ["Cantidad Pagos", String(pagos), "Fecha Pago", "30/09/2026"],
  ["Concepto Pago", "Proveedores", "Estado Nómina Pagos", estadoNom],
  []
];
const H_PROV = ["Rut", "Nombre", "Forma Abono", "N° Cuenta", "Banco", "Código Propio", "Monto Abono", "Cantidad Documentos", "Estado Abono", "Motivo"];
const H_REM = ["Rut", "Nombre", "Fecha Abono", "Forma Abono", "Banco", "Código Propio", "N° Cuenta", "Estado Abono", "Motivo", "Monto Abono"];
const H_DOC = ["Rut", "Nombre", "Centro Negocio", "Tipo Abono", "Banco", "Monto Total $", "Estado", "Motivo", "N° Documento", "Tipo Documento", "Fecha Emisión", "Monto $"];

const prov = (rut, nombre, monto, estado, motivo = "") =>
  [rut, nombre, "Abono en Cuenta Corriente / Cuenta Vista", "1234567", "BANCOESTADO", "", monto, "1", estado, motivo];
const rem = (rut, nombre, monto, estado, motivo = "") =>
  [rut, nombre, "30/09/2026", "Pago Cash", "BANCOESTADO", "", "", estado, motivo, monto];
const docFila = (rut, nombre, total, estado, motivo, ndoc, monto) =>
  [rut, nombre, "", "Abono en Cuenta Corriente / Cuenta Vista", "BANCOESTADO", total, estado, motivo, ndoc, "FACTURA EXENTA ELECTRONICA", "25/09/2026", monto];

// RUT válidos inventados
const R1 = "11.111.111-1", R2 = "22.222.222-2", R3 = "33.333.333-3";
const n1 = "111111111", n2 = "222222222", n3 = "333333333";

const nomina = (over = {}) => ({
  id: "7", num: 7, operacion: "900001", estado: "cargada", total: 3000, fuente: "GENERAL",
  pagos: [
    { rut: n1, nombre: "PROVEEDOR UNO", monto: 1000, estado: "pendiente", motivo: "" },
    { rut: n2, nombre: "PROVEEDOR DOS", monto: 2000, estado: "pendiente", motivo: "" }
  ], ...over
});

console.log("Lectura del archivo del banco");

prueba("formato proveedores: cabecera y pagos", () => {
  const r = leerReporteBanco([...cabecera("900001", "20260929_PAGO_GENERAL", "$3.000", 2, "Aceptada Parcial"), H_PROV,
    prov(R1, "PROVEEDOR UNO", "$ 1.000", "Pagado"), prov(R2, "PROVEEDOR DOS", "$ 2.000", "Rechazado", "CUENTA NO EXISTE")]);
  assert.equal(r.ok, true);
  assert.equal(r.operacion, "900001");
  assert.equal(r.montoTotal, 3000);
  assert.equal(r.cantidadPagos, 2);
  assert.equal(r.estadoNomina, "Aceptada Parcial");
  assert.equal(r.porDocumento, false);
  assert.deepEqual(r.pagos.map(p => [p.rut, p.monto, p.estado, p.motivo]),
    [[n1, 1000, "Pagado", ""], [n2, 2000, "Rechazado", "CUENTA NO EXISTE"]]);
});

prueba("formato remuneraciones: otro orden de columnas, monto al final", () => {
  const r = leerReporteBanco([...cabecera("900002", "20260929_FONDOSFIJOS", "$377.882", 3, "Aceptada Parcial", "SLEP EJEMPLO REMUNERACIONES(REM-000)"), H_REM,
    rem(R1, "PERSONA UNA", "$ 139.502", "Pendiente de Cobro"), rem(R2, "PERSONA DOS", "$ 137.380", "Pendiente de Cobro")]);
  assert.equal(r.ok, true);
  assert.equal(r.operacion, "900002");
  assert.deepEqual(r.pagos.map(p => [p.rut, p.monto, p.estado]), [[n1, 139502, "Pendiente de Cobro"], [n2, 137380, "Pendiente de Cobro"]]);
});

prueba("formato por documento: varias filas del mismo RUT son un solo pago", () => {
  const filas = [...cabecera("900001", "20260929_PAGO_GENERAL", "$3.000", 2, "Aceptada Parcial"), H_DOC,
    docFila(R1, "PROVEEDOR UNO", "$ 1.000", "Pagado", "", "201", "$ 1.000"),
    docFila(R2, "PROVEEDOR DOS", "$ 2.000", "Pagado", "", "349", "$ 800"),
    docFila(R2, "PROVEEDOR DOS", "$ 2.000", "Pagado", "", "351", "$ 1.200")];
  const r = leerReporteBanco(filas);
  assert.equal(r.porDocumento, true);
  assert.equal(r.pagos.length, 3);              // tres filas…
  const c = conciliar(r, nomina());
  assert.equal(c.cambios.length, 2);            // …pero dos pagos
  assert.deepEqual(c.cambios.map(x => [x.rut, x.monto, x.estado]), [[n1, 1000, "pagado"], [n2, 2000, "pagado"]]);
  assert.deepEqual(c.avisos, []);
});

prueba("por documento como lo descarga el banco: cada documento es un pago con su propio monto", () => {
  const filas = [...cabecera("900001", "P02_EJEMPLO_GENERAL", "$3.000", 3, "Aceptada"), H_DOC,
    docFila(R1, "PROVEEDOR UNO", "$ 1.000", "Pagado", "", "201", "$ 1.000"),
    docFila(R2, "PROVEEDOR DOS", "$ 800", "Pagado", "", "349", "$ 800"),
    docFila(R2, "PROVEEDOR DOS", "$ 1.200", "Pagado", "", "351", "$ 1.200")];
  const n = nomina(); n.pagos[1].docs = [{ ndoc: "349" }, { ndoc: "351" }]; n.pagos[0].docs = [{ ndoc: "201" }];
  const c = conciliar(leerReporteBanco(filas), n);
  assert.deepEqual(c.cambios.map(x => [x.rut, x.monto, x.estado]), [[n1, 1000, "pagado"], [n2, 2000, "pagado"]]);
  assert.deepEqual(c.avisos, []);
});

prueba("guarda el nombre y la forma de pago como los escribe el banco, solo si cambian", () => {
  const filas = [...cabecera("900001", "P02_EJEMPLO_GENERAL", "$3.000", 2, "Aceptada"), H_DOC,
    docFila(R1, "PROVEEDOR UNO  ", "$ 1.000", "Pagado", "", "201", "$ 1.000"),
    docFila(R2, "PROV DOS", "$ 2.000", "Pagado", "", "349", "$ 2.000")];
  const r = leerReporteBanco(filas);
  assert.equal(r.pagos[0].forma, "Abono en Cuenta Corriente / Cuenta Vista");
  const c = conciliar(r, nomina());
  assert.deepEqual(c.detalle, [
    { rut: n1, monto: 1000, nombre: "PROVEEDOR UNO", forma: "Abono en Cuenta Corriente / Cuenta Vista" },
    { rut: n2, monto: 2000, nombre: "PROV DOS", forma: "Abono en Cuenta Corriente / Cuenta Vista" }]);
  // Ya guardados: no se vuelven a proponer.
  const n = nomina(); n.pagos[0].formaBanco = "Abono en Cuenta Corriente / Cuenta Vista";
  n.pagos[1].nombreBanco = "PROV DOS"; n.pagos[1].formaBanco = "Abono en Cuenta Corriente / Cuenta Vista";
  assert.deepEqual(conciliar(r, n).detalle, []);
});

prueba("un archivo que no es del banco se rechaza", () => {
  const r = leerReporteBanco([["cualquier cosa"], ["otra fila"]]);
  assert.equal(r.ok, false);
  assert.match(r.error, /Detalle de Nómina/);
});

console.log("\nTraducción de estados");
prueba("solo se traduce lo conocido", () => {
  assert.deepEqual(traducirEstado("Pagado"), { estado: "pagado" });
  assert.deepEqual(traducirEstado("RECHAZADO"), { estado: "rechazado" });
  assert.deepEqual(traducirEstado("Pendiente de Cobro"), { estado: "pagado", cobro: "" });
  assert.equal(traducirEstado("En Proceso"), null);
  assert.equal(traducirEstado(""), null);
});

console.log("\nConciliación con la nómina");
const repProv = (...filas) => leerReporteBanco([...cabecera("900001", "N", "$3.000", 2, "Aceptada Parcial"), H_PROV, ...filas]);
const normal = () => repProv(prov(R1, "PROVEEDOR UNO", "$ 1.000", "Pagado"), prov(R2, "PROVEEDOR DOS", "$ 2.000", "Rechazado", "CUENTA NO EXISTE"));

prueba("caso normal: un pagado y un rechazado con su motivo", () => {
  const c = conciliar(normal(), nomina());
  assert.deepEqual(c.cambios.map(x => [x.rut, x.estado, x.motivo]), [[n1, "pagado", ""], [n2, "rechazado", "CUENTA NO EXISTE"]]);
  assert.deepEqual(c.avisos, []);
});

prueba("el archivo de otra nómina no se aplica", () => {
  const c = conciliar(normal(), nomina({ operacion: "900999" }));
  assert.match(c.error, /900001/);
});

prueba("una nómina que no está cargada no se toca", () => {
  assert.match(conciliar(normal(), nomina({ estado: "generada" })).error, /no está cargada/);
  assert.match(conciliar(normal(), nomina({ estado: "anulada" })).error, /anulada/);
});

prueba("un monto que no calza se avisa y no se aplica", () => {
  const n = nomina(); n.pagos[1].monto = 1500;
  const c = conciliar(normal(), n);
  assert.deepEqual(c.cambios.map(x => x.rut), [n1]);
  assert.equal(c.avisos.length, 1);
  assert.match(c.avisos[0], /22\.222\.222-2.*\$2\.000.*\$1\.500/);
});

prueba("un estado desconocido se deja para registrar a mano", () => {
  const c = conciliar(repProv(prov(R1, "PROVEEDOR UNO", "$ 1.000", "En Proceso"), prov(R2, "PROVEEDOR DOS", "$ 2.000", "Pagado")), nomina());
  assert.deepEqual(c.cambios.map(x => x.rut), [n2]);
  assert.match(c.avisos[0], /"En Proceso"/);
});

prueba("volver a subir el mismo archivo no reescribe nada", () => {
  const n = nomina();
  n.pagos[0].estado = "pagado";
  n.pagos[1].estado = "rechazado"; n.pagos[1].motivo = "CUENTA NO EXISTE";
  const c = conciliar(normal(), n);
  assert.deepEqual(c.cambios, []);
  assert.equal(c.iguales.length, 2);
});

prueba("un pago ya reintegrado no se modifica", () => {
  const n = nomina(); n.pagos[1].estado = "rechazado"; n.pagos[1].reint = "2026-09-30";
  const c = conciliar(normal(), n);
  assert.deepEqual(c.cambios.map(x => x.rut), [n1]);
  assert.match(c.avisos[0], /reintegró/);
});

prueba("pagos que el banco no informa, y filas que no son de la nómina", () => {
  const n = nomina();
  n.pagos.push({ rut: n3, nombre: "PROVEEDOR TRES", monto: 500, estado: "pendiente", motivo: "" });
  const c = conciliar(repProv(prov(R1, "PROVEEDOR UNO", "$ 1.000", "Pagado"), prov(R3 /* ajeno */, "OTRO", "$ 900", "Pagado")), n);
  assert.deepEqual(c.cambios.map(x => x.rut), [n1]);
  assert.ok(c.avisos.some(a => /PROVEEDOR DOS.*no lo informa/.test(a)));
  assert.ok(c.avisos.some(a => /33\.333\.333-3.*\$900.*\$500/.test(a)));   // el monto no calza
});

prueba("el mismo RUT con dos resultados distintos se deja a mano", () => {
  const c = conciliar(repProv(prov(R1, "PROVEEDOR UNO", "$ 1.000", "Pagado"), prov(R1, "PROVEEDOR UNO", "$ 1.000", "Rechazado", "X")), nomina());
  assert.deepEqual(c.cambios, []);
  assert.match(c.avisos[0], /más de un resultado/);
});

prueba("total y cantidad de pagos que no cuadran se avisan", () => {
  const r = leerReporteBanco([...cabecera("900001", "N", "$9.999", 5, "Aceptada"), H_PROV,
    prov(R1, "PROVEEDOR UNO", "$ 1.000", "Pagado"), prov(R2, "PROVEEDOR DOS", "$ 2.000", "Pagado")]);
  const c = conciliar(r, nomina());
  assert.equal(c.cambios.length, 2);
  assert.ok(c.avisos.some(a => /5 pagos.*tiene 2/.test(a)));
  assert.ok(c.avisos.some(a => /\$9\.999.*\$3\.000/.test(a)));
});

console.log("\nReparto de varios archivos");
prueba("cada archivo va a su nómina, y el que no calza se informa", () => {
  const nominas = [nomina(), nomina({ id: "8", num: 8, operacion: "900002" })];
  const ajeno = leerReporteBanco([...cabecera("900777", "N", "$1.000", 1, "Aceptada"), H_PROV, prov(R1, "X", "$ 1.000", "Pagado")]);
  const out = repartir([
    { archivo: "a.xlsx", rep: normal() },
    { archivo: "b.xlsx", rep: ajeno },
    { archivo: "c.xlsx", rep: { ok: false, error: "ilegible" } }
  ], nominas);
  assert.equal(out[0].nomina.num, 7);
  assert.equal(out[0].cambios.length, 2);
  assert.match(out[1].error, /900777/);
  assert.equal(out[2].error, "ilegible");
});

prueba("dos nóminas con el mismo N° BancoEstado no se tocan", () => {
  const out = repartir([{ archivo: "a.xlsx", rep: normal() }], [nomina(), nomina({ id: "9", num: 9 })]);
  assert.match(out[0].error, /2 nóminas/);
});

prueba("una transferencia electrónica con el mismo número no recibe el reporte", () => {
  const tef = nomina({ id: "12", num: 12, tipo: "transferencia", origen: "suelto" });
  // La transferencia sola no es candidata; con la nómina real, el archivo va a la nómina.
  assert.match(repartir([{ archivo: "a.xlsx", rep: normal() }], [tef])[0].error, /Ninguna nómina/);
  const out = repartir([{ archivo: "a.xlsx", rep: normal() }], [tef, nomina()]);
  assert.equal(out[0].nomina.num, 7);
  assert.match(conciliar(normal(), tef).error, /transferencia electrónica/);
});

console.log(`\n${ok} pruebas, todas bien.`);

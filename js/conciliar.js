// Lee el "Detalle Nómina" que BancoEstado deja descargar en Excel y lo compara
// con una nómina de la bitácora. Funciones puras: no tocan el DOM ni Firestore,
// así se prueban en Node (tests/conciliar.test.mjs) contra archivos reales.
//
// El banco publica el mismo detalle en tres formatos, que se reconocen por la
// fila de encabezados y no por la posición de las columnas:
//   · Proveedores, "Ver Nómina"     → una fila por pago
//   · Remuneraciones, "Ver Nómina"  → una fila por pago, columnas en otro orden
//   · Proveedores, "Ver Documentos" → una fila por documento (se agrupan por RUT;
//     el banco cuenta cada documento como un pago y su "Monto Total $" es el del documento)

import { S, normRut, fmtRut, parseMonto, money, tipoDe, esCobroCaja } from "./formato.js";
import { leerMisNominas } from "./barrido.js";

// Sin tildes, sin el signo de ordinal (BancoEstado escribe "Nº Nómina" con º y
// "N° Documento" con °) y con los espacios colapsados.
const llave = v => S(v).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[º°]/g, "").replace(/\s+/g, " ").trim();

const RX = {
  rut: /^rut$/, nombre: /^nombre$/, monto: /^monto (abono|total)/, estado: /^estado( abono)?$/,
  motivo: /^motivo$/, cuenta: /^n cuenta$/, banco: /^banco$/, forma: /^(forma|tipo) abono$/,
  ndoc: /^n documento$/, tipodoc: /^tipo documento$/, montodoc: /^monto \$$/, fechadoc: /^fecha emision$/
};
// "Monto Abono"/"Monto Total" es lo que se abona al beneficiario; "Monto $" es
// el de cada documento. El orden importa: gana la primera que calce.
const ORDEN = ["rut", "nombre", "forma", "cuenta", "banco", "estado", "motivo", "ndoc", "tipodoc", "montodoc", "fechadoc", "monto"];

// filas: matriz de celdas (XLSX.utils.sheet_to_json con header:1).
export function leerReporteBanco(filas) {
  const enc = {};
  // Cabecera: pares "etiqueta | valor" en las primeras filas, en A-B y en C-D.
  for (let i = 0; i < Math.min(filas.length, 12); i++)
    for (const c of [0, 2]) {
      const k = llave(filas[i] && filas[i][c]);
      if (k) enc[k] = S(filas[i][c + 1]);
    }
  let hi = -1, map = null;
  for (let i = 0; i < filas.length; i++) {
    const m = {};
    (filas[i] || []).forEach((celda, j) => {
      const h = llave(celda); if (!h) return;
      for (const k of ORDEN) if (!(k in m) && RX[k].test(h)) { m[k] = j; break }
    });
    if ("rut" in m && "estado" in m) { hi = i; map = m; break }
  }
  if (hi < 0) return { ok: false, error: "No parece un Detalle de Nómina de BancoEstado: no encontré la fila de encabezados con Rut y Estado." };

  const pagos = [];
  for (let i = hi + 1; i < filas.length; i++) {
    const g = k => k in map ? filas[i][map[k]] : "";
    const rut = normRut(g("rut")); if (!rut) continue;
    // nombreTal: el nombre sin recortar (en remuneraciones el banco lo deja tal como se subió, a veces con espacios al final).
    pagos.push({ rut, nombre: S(g("nombre")), nombreTal: String(g("nombre") ?? "").replace(/^\s+/, ""), forma: S(g("forma")), monto: parseMonto(g("monto")), estado: S(g("estado")), motivo: S(g("motivo")),
      banco: S(g("banco")), cuenta: S(g("cuenta")), ndoc: S(g("ndoc")), tipodoc: S(g("tipodoc")), montodoc: parseMonto(g("montodoc")), fechadoc: S(g("fechadoc")) });
  }
  const operacion = S(enc["n nomina"]);
  if (!operacion) return { ok: false, error: "El archivo no trae el N° de nómina de BancoEstado." };
  if (!pagos.length) return { ok: false, error: "El archivo no trae ninguna fila de pago." };
  return {
    ok: true, operacion, convenio: S(enc["convenio"]), nombreNomina: S(enc["nombre nomina"]),
    montoTotal: parseMonto(enc["monto total $"]), cantidadPagos: parseInt(enc["cantidad pagos"], 10) || 0,
    fechaPago: S(enc["fecha pago"]), estadoNomina: S(enc["estado nomina pagos"]), conceptoPago: S(enc["concepto pago"]),
    porDocumento: "ndoc" in map, pagos,
    // Vista del banco: proveedores por documento, remuneraciones (con N° de cuenta) o proveedores por pago.
    vista: "ndoc" in map ? "documentos"
      : /remuneraciones/.test(llave(filas[0] && filas[0][0])) || (filas[hi] || []).some(c => llave(c) === "fecha abono") ? "remuneraciones" : "pagos"
  };
}

// Estados que el banco informa, traducidos a los de la bitácora. Solo están los
// vistos en archivos reales: un estado que no esté aquí NO se toca, se avisa.
// "Pendiente de Cobro" es un pago cash o vale vista que ya salió de la cuenta
// pero que el beneficiario todavía no retira: pagado y por cobrar en banco.
// Cuando lo retira, el banco lo pasa a "Pagado" (conciliar lo registra cobrado).
const ESTADOS = {
  "pagado": { estado: "pagado" },
  "rechazado": { estado: "rechazado" },
  "pendiente de cobro": { estado: "pagado", cobro: "" }
};
export const traducirEstado = e => ESTADOS[llave(e)] || null;

// Compara el reporte con la nómina y devuelve lo que habría que escribir, sin
// escribir nada: { cambios, iguales, avisos }. Un pago solo entra en `cambios`
// si el banco lo informa, el monto calza y el estado se reconoce.
export function conciliar(rep, n) {
  if (S(n.operacion) !== S(rep.operacion))
    return { error: `El archivo es de la nómina BancoEstado N° ${rep.operacion} y la N° ${n.num} tiene el N° ${n.operacion || "(sin número)"}.` };
  if (tipoDe(n) === "transferencia") return { error: `El registro N° ${n.num} es una transferencia electrónica: no tiene reporte de nómina.` };
  if (n.estado === "anulada") return { error: `La nómina N° ${n.num} está anulada.` };
  if (n.estado !== "cargada") return { error: `La nómina N° ${n.num} no está cargada en el banco; primero regístrala como cargada.` };

  const cambios = [], iguales = [], avisos = [], detalle = [];
  let reintegrados = 0;
  // Por documento el banco cuenta cada documento como un pago.
  const nDocs = n.pagos.reduce((a, p) => a + ((p.docs || []).length || 1), 0);
  if (rep.cantidadPagos && rep.cantidadPagos !== n.pagos.length && !(rep.porDocumento && rep.cantidadPagos === nDocs))
    avisos.push(`El banco informa ${rep.cantidadPagos} pago${rep.cantidadPagos > 1 ? "s" : ""} y la nómina tiene ${n.pagos.length}.`);
  if (rep.montoTotal && rep.montoTotal !== n.total)
    avisos.push(`El total del banco (${money(rep.montoTotal)}) no cuadra con el de la nómina (${money(n.total)}).`);

  // Una entrada por RUT: en el formato por documento el mismo pago viene repetido.
  const porRut = new Map();
  rep.pagos.forEach(f => {
    const a = porRut.get(f.rut);
    if (!a) porRut.set(f.rut, { ...f, suma: f.monto });
    else {
      a.suma += f.monto;
      if (llave(a.estado) !== llave(f.estado) || S(a.motivo) !== S(f.motivo)) a.conflicto = true;
    }
  });

  const vistos = new Set();
  n.pagos.forEach((p, i) => {
    const f = porRut.get(p.rut);
    const quien = `${fmtRut(p.rut)} ${p.nombre}`;
    if (!f) { avisos.push(`${quien}: el banco no lo informa en este archivo.`); return }
    vistos.add(p.rut);
    if (f.conflicto) { avisos.push(`${quien}: el archivo trae más de un resultado para el mismo RUT; regístralo a mano.`); return }
    // Por documento, "Monto Total $" es el de cada documento: el pago es la suma.
    const montoOk = isNaN(f.monto) || f.monto === p.monto || f.suma === p.monto;
    // Nombre y forma de pago como los escribe el banco, para emitir después el Detalle de Nómina igual.
    const nombreBco = rep.vista === "remuneraciones" ? f.nombreTal || f.nombre : f.nombre;
    if (montoOk && ((nombreBco && nombreBco !== (p.nombreBanco || S(p.nombre))) || (f.forma && f.forma !== S(p.formaBanco)) || (f.banco && f.banco !== S(p.bancoBanco))))
      detalle.push({ rut: p.rut, monto: p.monto, nombre: nombreBco, forma: f.forma, banco: f.banco });
    // Un pago ya reintegrado a pendientes no se vuelve a tocar (no es un problema del archivo).
    if (p.reint) { avisos.push(`${quien}: ya se reintegró a pendientes; no se modifica.`); reintegrados++; return }
    if (!montoOk) {
      avisos.push(`${quien}: el banco informa ${money(f.monto)} y la nómina dice ${money(p.monto)}. No se toca.`);
      return;
    }
    const t = traducirEstado(f.estado);
    if (!t) { avisos.push(`${quien}: el banco informa "${f.estado}", que esta versión no reconoce; regístralo a mano.`); return }
    const motivo = t.estado === "rechazado" ? S(f.motivo) : "";
    // Un pago cash o vale vista que el banco ya informa "Pagado" (antes "Pendiente de Cobro") se cobró.
    // Lo que ya se registró a mano (cobrado o devuelto) no vuelve a "por cobrar" por un reporte anterior.
    const cobro = t.cobro === undefined && t.estado === "pagado" && esCobroCaja(n, p) ? "cobrado" : t.cobro === "" && S(p.cobro) ? undefined : t.cobro;
    const item = { i, rut: p.rut, nombre: p.nombre, monto: p.monto, antes: p.estado, estado: t.estado, motivo, cobro, antesCobro: S(p.cobro) };
    // Ya registrado igual (se volvió a subir el mismo archivo): no se reescribe.
    if (p.estado === t.estado && S(p.motivo) === motivo && (cobro === undefined || S(p.cobro) === cobro)) iguales.push(item);
    else cambios.push(item);
  });
  porRut.forEach((f, rut) => {
    if (!vistos.has(rut)) avisos.push(`${fmtRut(rut)} ${f.nombre}: viene en el archivo pero no es un pago de esta nómina.`);
  });
  return { cambios, iguales, avisos, detalle, reintegrados };
}

// Lee el .xlsx tal como lo descarga BancoEstado (hoja "DetalleNomina").
export async function leerArchivoBanco(file) {
  if (typeof XLSX === "undefined") throw new Error("no se pudo cargar el lector de Excel");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
  const hoja = wb.SheetNames.find(x => /detalle/i.test(x)) || wb.SheetNames[0];
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[hoja], { header: 1, raw: false, defval: "" });
  // "Mis Nóminas" (la lista de nóminas del convenio) va al barrido; el resto es un Detalle de Nómina.
  return leerMisNominas(filas) || leerReporteBanco(filas);
}

// Reparte varios archivos entre las nóminas de la bitácora, por N° BancoEstado.
// lecturas: [{ archivo, rep }]. Devuelve una entrada por archivo, en orden.
export function repartir(lecturas, nominas) {
  return lecturas.map(({ archivo, rep }) => {
    if (!rep.ok) return { archivo, error: rep.error };
    if (rep.lista) return { archivo, rep, lista: true };
    // Las transferencias electrónicas llevan su propio N° de transferencia en el mismo campo: no cuentan.
    const cands = nominas.filter(n => S(n.operacion) === S(rep.operacion) && n.estado !== "anulada" && tipoDe(n) !== "transferencia");
    if (!cands.length) return { archivo, rep, sinNomina: true, error: `Ninguna nómina de la bitácora tiene el N° BancoEstado ${rep.operacion}.` };
    if (cands.length > 1) return { archivo, rep, error: `Hay ${cands.length} nóminas con el N° BancoEstado ${rep.operacion} (N° ${cands.map(n => n.num).join(", N° ")}); regístralas a mano.` };
    const n = cands[0];
    return { archivo, rep, nomina: n, ...conciliar(rep, n) };
  });
}

// Barrido de nóminas: el Excel "Mis Nóminas" de BancoEstado (la lista de todas
// las nóminas de un convenio, con su N°, nombre, fecha de pago, monto, cantidad
// de pagos y estado) se cruza con la bitácora para saber cuáles faltan, cuáles
// tienen resultados por registrar y cuáles están al día. Funciones puras (sin
// DOM ni Firestore), se prueban en Node (tests/conciliar.test.mjs).

import { S, parseMonto, tipoDe, porCobrar } from "./formato.js";

const llave = v => S(v).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[º°]/g, "").replace(/\s+/g, " ").trim();
const iso = v => { const m = S(v).match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "" };

// Estados del banco en que la nómina sí se pagó (total o parcialmente).
const PAGADA = new Set(["aceptada", "aceptada parcial"]);

// filas: matriz de celdas de la hoja "MisNominas". Devuelve null si no es ese archivo.
export function leerMisNominas(filas) {
  if (!/^mis nominas$/.test(llave(filas[0] && filas[0][0]))) return null;
  const hi = filas.findIndex(f => (f || []).map(llave).join("|").startsWith("convenio|n nomina|nombre nomina|fecha pago"));
  if (hi < 0) return null;
  const h = filas[hi].map(llave), col = k => h.indexOf(k);
  const c = { convenio: col("convenio"), operacion: col("n nomina"), nombre: col("nombre nomina"), fecha: col("fecha pago"), monto: col("monto total $"), cantidad: col("cantidad pagos"), estado: col("estado") };
  const nominas = [];
  for (const f of filas.slice(hi + 1)) {
    const operacion = S(f[c.operacion]).replace(/\D/g, "");
    if (!operacion) continue;
    const convenio = S(f[c.convenio]);
    nominas.push({ convenio, operacion, nombre: S(f[c.nombre]), fechaPago: iso(f[c.fecha]), monto: parseMonto(f[c.monto]),
      cantidad: parseInt(S(f[c.cantidad]), 10) || 0, estado: S(f[c.estado]), tipo: /REMUNERA|\(REM-/i.test(convenio) ? "abonos" : "proveedores" });
  }
  const fecha = S(filas[2] && filas[2][0]).replace(/^Fecha\s*:\s*/, "");
  return { ok: true, lista: true, fecha, nominas };
}

// Categorías del barrido, en el orden en que se atienden.
export const CATEGORIAS = {
  falta: { t: "Falta en la bitácora", c: "err" },
  resultados: { t: "Registrar resultados", c: "wrn" },
  ok: { t: "Al día", c: "okk" },
  sinpago: { t: "Sin pago en el banco", c: "neu" }
};

// listas: [{ nominas }] (una por archivo). nominas: las de la bitácora.
// Devuelve { filas, soloPanel, resumen }. Cada fila: la nómina del banco con
// { cat, nomina (de la bitácora o null), nota }.
export function cruzarMisNominas(listas, nominas) {
  const banco = new Map();
  listas.forEach(l => l.nominas.forEach(b => banco.set(b.operacion, b)));       // dos archivos iguales no duplican
  const panel = nominas.filter(n => n.estado !== "anulada" && tipoDe(n) !== "transferencia");
  const porOper = new Map();
  panel.forEach(n => { const k = S(n.operacion); if (k) porOper.set(k, [...(porOper.get(k) || []), n]) });

  const filas = [...banco.values()].map(b => {
    const ns = porOper.get(b.operacion) || [];
    const n = ns[0] || null;
    const pagada = PAGADA.has(llave(b.estado));
    const fila = (cat, nota) => ({ ...b, cat, nomina: n, nota });
    if (ns.length > 1) return fila("resultados", `Hay ${ns.length} nóminas de la bitácora con este N° BancoEstado (N° ${ns.map(x => x.num).join(", N° ")}); deja solo una.`);
    if (!pagada) {
      const enProceso = /proceso/.test(llave(b.estado));
      if (n && n.estado === "cargada" && n.pagos.some(p => p.estado === "pagado"))
        return fila("resultados", `El banco la informa "${b.estado}"${enProceso ? "" : ", sin pago"}, pero en la bitácora tiene pagos pagados. Revísala.`);
      return fila("sinpago", enProceso ? "El banco aún la está procesando; vuelve a revisarla." : `El banco la informa "${b.estado}": no se pagó, no hay nada que registrar.`);
    }
    if (!n) return fila("falta", tipoNota(b));
    if (n.estado === "generada") return fila("resultados", `N° ${n.num} sigue como generada: sube su Detalle de Nómina para marcarla cargada con sus resultados.`);
    const pend = n.pagos.filter(p => p.estado === "pendiente").length;
    if (pend) return fila("resultados", `${pend} pago${pend > 1 ? "s" : ""} sin resultado: sube su Detalle de Nómina.`);
    // El banco la da por terminada sin rechazos ni cobros pendientes, pero la bitácora no.
    const xCobrar = n.pagos.filter(p => porCobrar(n, p)).length;
    if (llave(b.estado) === "aceptada" && xCobrar) return fila("resultados", `El banco la informa Aceptada y en la bitácora hay ${xCobrar} pago${xCobrar > 1 ? "s" : ""} por cobrar: sube su Detalle para registrar el cobro.`);
    if (llave(b.estado) === "aceptada" && n.pagos.some(p => p.estado === "rechazado")) return fila("ok", "El banco la informa Aceptada y en la bitácora tiene rechazos: revisa con su Detalle.");
    if (b.monto && n.total !== b.monto) return fila("ok", `El total de la bitácora no cuadra con el del banco.`);
    return fila("ok", "");
  }).sort((a, b) => b.fechaPago.localeCompare(a.fechaPago) || b.operacion.localeCompare(a.operacion));

  // Nóminas de la bitácora (del mismo tipo de convenio que las listas) que el banco no informa.
  const tipos = new Set([...banco.values()].map(b => b.tipo));
  const soloPanel = panel.filter(n => tipos.has(tipoDe(n)) && !banco.has(S(n.operacion)))
    .sort((a, b) => b.num - a.num);
  const resumen = Object.fromEntries(Object.keys(CATEGORIAS).map(k => [k, filas.filter(f => f.cat === k).length]));
  resumen.soloPanel = soloPanel.length;
  return { filas, soloPanel, resumen };
}

const tipoNota = b => b.tipo === "abonos"
  ? "Descarga su Detalle de Nómina (Remuneraciones → Ver Nómina) y súbelo con Cargar reporte del banco para registrarla."
  : "Descarga su Detalle de Nómina en la vista Ver Documentos y súbelo con Cargar reporte del banco para registrarla.";

// Hoja de Excel del barrido (para ir marcando el avance).
export function barridoHojas(cruce, fmt) {
  const cab = ["Estado del barrido", "Convenio", "N° BancoEstado", "Nombre Nómina", "Fecha pago", "Monto", "Pagos", "Estado en el banco", "Nómina en la bitácora", "Qué hacer"];
  const filas = cruce.filas.map(f => [CATEGORIAS[f.cat].t, f.tipo === "abonos" ? "Remuneraciones" : "Proveedores", Number(f.operacion), f.nombre, fmt(f.fechaPago), { $: f.monto }, f.cantidad, f.estado, f.nomina ? f.nomina.num : "", f.nota]);
  const solo = cruce.soloPanel.map(n => [n.num, tipoDe(n) === "abonos" ? "Remuneraciones" : "Proveedores", S(n.operacion), S(n.fuente), fmt(n.fechaPago || n.fechaCarga), { $: n.total }, n.pagos.length, n.estado]);
  return [
    { nombre: "Barrido", filas: [cab, ...filas], anchos: [22, 16, 15, 36, 12, 15, 7, 18, 12, 90] },
    { nombre: "Solo en la bitácora", filas: [["Nómina", "Tipo", "N° BancoEstado", "Fuente", "Fecha pago", "Monto", "Pagos", "Estado"], ...solo], anchos: [8, 16, 15, 20, 12, 15, 7, 12] }
  ];
}

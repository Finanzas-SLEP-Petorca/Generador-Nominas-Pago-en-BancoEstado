// Normalización, validación y armado de la nómina BancoEstado.
// Funciones puras: no tocan el DOM ni Firestore, así se prueban en Node
// contra el panel de referencia (tests/formato.test.mjs).
// La lógica es la misma de referencia/panel_actual_claude.html.

import { M_BANCO, M_FORMA, M_SECTOR, M_TIPO, NC, DIAS, M_FORMA_ABONO, FORMAS_SIN_CUENTA, FORMAS_SOLO_BE } from "./catalogos.js";

// ---------- normalizadores ----------
export const S = v => v == null ? "" : String(v).trim();
export function dvOf(body) { let s = 0, m = 2; for (let i = body.length - 1; i >= 0; i--) { s += (+body[i]) * m; m = m === 7 ? 2 : m + 1 } const r = 11 - s % 11; return r === 11 ? "0" : r === 10 ? "K" : String(r) }
export function normRut(v) { return S(v).toUpperCase().replace(/[^0-9K]/g, "") }
export function rutOk(r) { return /^\d{6,9}[0-9K]$/.test(r) && dvOf(r.slice(0, -1)) === r.slice(-1) }
export function fmtRut(r) { if (!r || r.length < 2) return r; const b = r.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, "."); return b + "-" + r.slice(-1) }
export function cleanName(v) { return S(v).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/Ñ/g, "N").replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim() }
export const normFuente = v => cleanName(v).slice(0, 30);
export function pad(v, n) { const d = S(v).replace(/\D/g, ""); return d ? d.padStart(n, "0") : "" }
export function normCuenta(v) { if (typeof v === "number") v = Math.round(v).toString(); return S(v).toUpperCase().replace(/[A-Z]/g, "0").replace(/\D/g, "") }
export function parseMonto(v) {
  if (typeof v === "number") return isFinite(v) ? Math.round(v) : NaN;
  let s = S(v).replace(/[$\s]/g, ""); if (!s) return NaN;
  s = s.replace(/,\d{1,2}$/, "").replace(/[.,]/g, "");
  return /^-?\d+$/.test(s) ? parseInt(s, 10) : NaN;
}
// DC opcional (ej. "DC 54"): texto libre, sin espacios repetidos, máx. 30.
export const normDc = v => S(typeof v === "number" ? Math.round(v) : v).replace(/\s+/g, " ").slice(0, 30);
export function validDate(d, m, y) { const t = new Date(Date.UTC(y, m - 1, d)); return y > 1990 && y < 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d }
export function two(n) { return String(n).padStart(2, "0") }
export function parseFecha(v) { // → DDMMAAAA o ""
  if (v instanceof Date && !isNaN(v)) return two(v.getDate()) + two(v.getMonth() + 1) + v.getFullYear();
  if (typeof v === "number" && v > 20000 && v < 80000) { const t = new Date(Math.round((v - 25569) * 864e5)); return two(t.getUTCDate()) + two(t.getUTCMonth() + 1) + t.getUTCFullYear() }
  let s = S(v); if (!s) return "";
  let m;
  if (/^\d{8}$/.test(s)) {
    const a = [+s.slice(0, 2), +s.slice(2, 4), +s.slice(4)];
    if (validDate(a[0], a[1], a[2])) return s;
    const b = [+s.slice(6), +s.slice(4, 6), +s.slice(0, 4)];
    if (validDate(b[0], b[1], b[2])) return two(b[0]) + two(b[1]) + b[2];
    return "";
  }
  if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) { const [, y, mo, d] = m; return validDate(+d, +mo, +y) ? two(d) + two(mo) + y : "" }
  if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/))) { let [, d, mo, y] = m; if (y.length === 2) y = "20" + y; return validDate(+d, +mo, +y) ? two(d) + two(mo) + y : "" }
  return "";
}
export function money(n) { return "$" + Math.round(n).toLocaleString("es-CL") }
export function fmtFecha(f) { return f && f.length === 8 ? f.slice(0, 2) + "/" + f.slice(2, 4) + "/" + f.slice(4) : f }

// ---------- fechas del calendario ----------
export function today(d = new Date()) { return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) }
export function todayISO(d = new Date()) { return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) }
export function fmtISO(s) { if (!s) return ""; const [y, m, d] = s.slice(0, 10).split("-"); return d + "/" + m + "/" + y }
export function isoLocal(ts) { const d = new Date(ts); return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) }
// Resultado del banco: 14:00 del día hábil siguiente a la carga.
// Salta sábados, domingos y los feriados (fechas ISO) de pago_config/general.
export function resultDue(ymd, feriados = []) {
  const fer = new Set(feriados);
  const [y, m, d] = ymd.split("-").map(Number); const t = new Date(y, m - 1, d, 14, 0, 0);
  do { t.setDate(t.getDate() + 1) } while (t.getDay() === 0 || t.getDay() === 6 || fer.has(todayISO(t)));
  return t;
}
// Día hábil siguiente (ISO), saltando fines de semana y feriados.
export function diaHabilSiguiente(ymd, feriados = []) { return todayISO(resultDue(ymd, feriados)) }
// ¿Es día hábil? (no sábado, domingo ni feriado)
export function esHabil(ymd, feriados = []) { const [y, m, d] = ymd.split("-").map(Number); const t = new Date(y, m - 1, d); return t.getDay() !== 0 && t.getDay() !== 6 && !feriados.includes(ymd) }
// Resultado del banco: 14:00 del día de pago de la nómina (si cae en día no
// hábil, del hábil siguiente). Las nóminas sin fecha de pago usan la regla
// anterior: 14:00 del día hábil siguiente a la carga.
export function resultadoDesde(n, feriados = []) {
  if (!n.fechaPago) return resultDue(n.fechaCarga, feriados);
  const [y, m, d] = n.fechaPago.split("-").map(Number); const t = new Date(y, m - 1, d, 14, 0, 0);
  while (!esHabil(todayISO(t), feriados)) t.setDate(t.getDate() + 1);
  return t;
}
// Nombre para mostrar a partir del correo: maria.perez@… → Maria Perez.
export const nombreDe = email => S(email).split("@")[0].split(/[._-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
export function fmtDue(t) { return DIAS[t.getDay()] + " " + two(t.getDate()) + "/" + two(t.getMonth() + 1) + " 14:00" }

// ---------- validación ----------
export function checkProv(p, emailDefecto = "") {
  const e = [], w = [];
  const rut = normRut(p.rut);
  if (!rut) e.push("falta RUT"); else if (!rutOk(rut)) e.push("RUT " + rut + " con dígito verificador inválido");
  if (rut.length > 10) e.push("RUT supera 10 caracteres");
  const nombre = cleanName(p.nombre);
  if (!nombre) e.push("falta razón social");
  if (nombre.length > 60) e.push("razón social supera 60 caracteres");
  if (/\d/.test(nombre)) w.push("la razón social contiene números; el instructivo del banco pide solo letras");
  const email = S(p.email) || S(emailDefecto);
  if (email && (email.length > 40 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) e.push("email inválido o de más de 40 caracteres");
  const banco = pad(p.banco, 3);
  if (!M_BANCO[banco]) e.push("código de banco " + (banco || "vacío") + " no está en la tabla");
  const forma = pad(p.forma, 2);
  if (!M_FORMA[forma]) e.push("forma de pago " + (forma || "vacía") + " no válida (01 o 02)");
  if (forma === "02" && banco !== "012") e.push("forma de pago 02 (cuenta de ahorro) solo sirve con BancoEstado");
  const cuenta = normCuenta(p.cuenta);
  if (!cuenta) e.push("falta número de cuenta");
  if (cuenta.length > 17) e.push("número de cuenta supera 17 dígitos");
  if (banco === "012" && rut && cuenta === rut.replace("K", "0")) w.push("la cuenta parece ser el RUT completo; una Cuenta RUT va sin dígito verificador");
  const sector = pad(p.sector, 2);
  if (!M_SECTOR[sector]) e.push("sector financiero " + (sector || "vacío") + " no válido");
  return { e, w, out: { rut, nombre, email, banco, forma, cuenta, sector } };
}
export function checkDoc(d) {
  const e = [], w = [];
  const rut = normRut(d.rut);
  const fecha = d.fecha;
  if (!fecha) e.push("fecha inválida");
  const monto = d.monto;
  if (!(monto > 0)) e.push("monto debe ser mayor a cero");
  else if (String(monto).length > 10) e.push("monto del documento supera 10 dígitos");
  const ndoc = S(d.ndoc);
  if (!/^\d{1,10}$/.test(ndoc)) e.push("N° de documento debe tener solo números (máx. 10)");
  const tipo = pad(d.tipo, 2);
  if (!M_TIPO[tipo]) e.push("tipo de documento " + (tipo || "vacío") + " no está en la tabla");
  return { e, w, out: { rut, fecha, monto, ndoc, tipo } };
}

// Documentos que ya están en una nómina activa (no anulada) y no rechazados.
// Clave rut|tipo|ndoc → "N" o "N (pagado)".
// Tipo de registro de la bitácora: nómina de proveedores, nómina de remuneraciones
// (abonos) o transferencia electrónica. Una transferencia paga documentos del
// paso 2, un abono de Remuneraciones o nada del panel (pago suelto): n.origen.
export const tipoDe = n => n.tipo === "abonos" ? "abonos" : n.tipo === "transferencia" ? "transferencia" : "proveedores";
export const TIPOS_REGISTRO = { proveedores: "Proveedores", abonos: "Remuneraciones", transferencia: "Transferencias" };
// Ítems con forma de documento (N° doc, tipo, fecha, DC) o de abono (concepto y glosa).
export const conDocumentos = n => tipoDe(n) === "proveedores" || (tipoDe(n) === "transferencia" && n.origen === "documentos");
export const conAbonos = n => tipoDe(n) === "abonos" || (tipoDe(n) === "transferencia" && n.origen === "abonos");

export function activeIndex(nominas) {
  const m = {};
  nominas.forEach(n => { if (n.estado === "anulada" || !conDocumentos(n)) return; n.pagos.forEach(p => { if (p.estado === "rechazado") return; p.docs.forEach(d => { m[p.rut + "|" + d.tipo + "|" + d.ndoc] = n.num + (p.estado === "pagado" ? " (pagado)" : "") }) }) });
  return m;
}

// ---------- construcción de la nómina de una fuente ----------
// ctx = { docs, maestro, nominas, group, email }
export function build(fuente, ctx) {
  const { docs, maestro, nominas, group = true, email = "" } = ctx;
  const issues = [], groups = new Map(); let seq = 0;
  const seen = new Set(), provChecked = {}, ids = [];
  const list = docs.filter(d => d.sel && d.fuente === fuente);
  const act = activeIndex(nominas);
  list.forEach(d => {
    ids.push(d.id);
    const dc = checkDoc(d); const where = `Doc ${S(d.ndoc) || "s/n"} (${fmtRut(dc.out.rut) || "sin RUT"})`;
    dc.e.forEach(m => issues.push({ lvl: "error", where, msg: m }));
    dc.w.forEach(m => issues.push({ lvl: "warn", where, msg: m }));
    const dupKey = dc.out.rut + "|" + dc.out.tipo + "|" + dc.out.ndoc;
    if (seen.has(dupKey)) issues.push({ lvl: "warn", where, msg: "documento repetido en esta nómina" });
    seen.add(dupKey);
    if (act[dupKey]) issues.push({ lvl: "error", where, msg: /pagado/.test(act[dupKey]) ? "este documento ya fue pagado en la nómina N° " + act[dupKey].replace(" (pagado)", "") + ". Quítalo de pendientes." : "este documento ya está en la nómina N° " + act[dupKey] + ", aún sin resultado. Quítalo de pendientes o anula esa nómina si no se cargó." });
    const p = maestro[dc.out.rut];
    if (!p) { issues.push({ lvl: "error", where, msg: "el RUT no está en el maestro de proveedores; agrégalo con sus datos bancarios" }); return }
    if (!provChecked[dc.out.rut]) {
      const pc = checkProv(p, email); provChecked[dc.out.rut] = pc;
      const pw = `Proveedor ${fmtRut(dc.out.rut)}`;
      pc.e.forEach(m => issues.push({ lvl: "error", where: pw, msg: m }));
      pc.w.forEach(m => issues.push({ lvl: "warn", where: pw, msg: m }));
    }
    const po = provChecked[dc.out.rut].out;
    const key = group ? po.rut + "|" + po.banco + "|" + po.cuenta : "#" + (seq++);
    if (!groups.has(key)) groups.set(key, { p: po, docs: [] });
    groups.get(key).docs.push({ ...dc.out, id: d.id, dc: normDc(d.dc) });
  });
  let total = 0, nDocs = 0; const lines = [];
  for (const g of groups.values()) {
    let sum = 0;
    g.docs.forEach(d => { sum += NC.has(d.tipo) ? -d.monto : d.monto });
    if (g.docs.some(d => NC.has(d.tipo))) issues.push({ lvl: "warn", where: `Proveedor ${fmtRut(g.p.rut)}`, msg: "incluye nota de crédito: se descontó del total a pagar. Confirma este tratamiento con tu ejecutivo BancoEstado." });
    if (!(sum > 0)) issues.push({ lvl: "error", where: `Proveedor ${fmtRut(g.p.rut)}`, msg: "el total a pagar queda en cero o negativo" });
    if (String(Math.abs(sum)).length > 13) issues.push({ lvl: "error", where: `Proveedor ${fmtRut(g.p.rut)}`, msg: "el monto total supera 13 dígitos" });
    g.sum = sum; total += sum; nDocs += g.docs.length;
    lines.push({ tipo: 1, f: ["1", g.p.rut, g.p.nombre, g.p.email, g.p.banco, g.p.forma, g.p.cuenta, g.p.sector, String(sum)] });
    g.docs.forEach(d => lines.push({ tipo: 2, f: ["2", d.fecha, String(d.monto), d.ndoc, d.tipo, "", "", "", ""] }));
  }
  const errs = issues.filter(i => i.lvl === "error").length, warns = issues.length - errs;
  return { fuente, issues, lines, total, nBen: groups.size, nDocs: list.length, errs, warns, ids, groups: [...groups.values()] };
}

// Archivo de carga: tabulaciones y CRLF, incluida la última línea.
export function toTxt(lines) { return lines.map(l => l.f.join("\t")).join("\r\n") + "\r\n" }

// Fuentes con documentos marcados, en el orden de la configuración.
export function activeFuentes(docs, fuentes) { const set = new Set(docs.filter(d => d.sel).map(d => d.fuente)); return fuentes.filter(f => set.has(f)).concat([...set].filter(f => !fuentes.includes(f))) }

// Prefijo del archivo: el patrón guardado con AAAAMMDD reemplazado por la fecha.
export function expandPrefijo(patron, fecha = new Date()) { return S(patron).replace(/AAAAMMDD/g, today(fecha)) }
// El nombre siempre termina en _FUENTE. Si el prefijo ya trae una fuente al
// final (ej. …_PROVEEDORES_SEP), se quita para no repetirla (…_SEP_SEP).
const conGuion = f => S(f).replace(/ /g, "_");
export function quitarFuenteFinal(prefijo, fuentes = []) {
  let p = S(prefijo).replace(/\.(txt|xlsx?)$/i, "").replace(/_+$/, "");
  const fs = [...new Set(fuentes.map(conGuion).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (let cambio = true; cambio;) {
    cambio = false;
    for (const f of fs) if (p.toUpperCase().endsWith("_" + f.toUpperCase()) && p.length > f.length + 1) { p = p.slice(0, -(f.length + 1)).replace(/_+$/, ""); cambio = true; break }
  }
  return p;
}
export function fileName(prefijo, f, fecha = new Date(), fuentes = []) { return (quitarFuenteFinal(prefijo, [...fuentes, f]) || today(fecha) + "_PAGO_PROVEEDORES") + "_" + conGuion(f) }
// Nombre para descargar una nómina ya registrada, sin la fuente repetida.
export const nombreNomina = n => fileName(n.archivo, n.fuente);

// Estado visible de una nómina en la bitácora.
// Pago cash o vale vista de remuneraciones: aunque la nómina quede pagada, el banco
// lo deja "Pendiente de cobro" hasta que la persona lo retira. Si no lo retira, los
// fondos vuelven a la cuenta (cobro "devuelto") y el abono se puede volver a pagar.
export const esCobroCaja = (n, p) => n.tipo === "abonos" && FORMAS_SIN_CUENTA.has(p.forma);
export const porCobrar = (n, p) => esCobroCaja(n, p) && p.estado === "pagado" && !p.cobro;
export const noCobrado = (n, p) => esCobroCaja(n, p) && p.estado === "pagado" && p.cobro === "devuelto";

export function nomStatus(n, feriados = [], ahora = Date.now()) {
  if (n.estado === "anulada") return { k: "anulada", t: "Anulada", c: "neu" };
  if (n.estado === "generada") return { k: "generada", t: "Generada, falta cargar", c: "wrn" };
  const pend = n.pagos.filter(p => p.estado === "pendiente").length;
  const rech = n.pagos.filter(p => p.estado === "rechazado");
  if (pend) { const due = resultadoDesde(n, feriados); return ahora < due.getTime() ? { k: "espera", t: "Cargada, resultado desde " + fmtDue(due), c: "neu" } : { k: "revisar", t: "Registrar resultado del banco", c: "err" } }
  const dev = n.pagos.filter(p => noCobrado(n, p));
  const sinR = [...rech, ...dev].filter(p => !p.reint).length;
  const xCobrar = n.pagos.filter(p => porCobrar(n, p)).length;
  const partes = [rech.length ? `${rech.length} rechazo${rech.length > 1 ? "s" : ""}` : "", dev.length ? `${dev.length} no cobrado${dev.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ");
  // Con pagos cash no cobrados el texto se acorta para que quepa en la tabla (el detalle lo explica).
  if (sinR) return { k: "reintegrar", t: dev.length ? `Procesada, ${sinR} por reintegrar` : `Procesada, ${partes}, ${sinR} por reintegrar`, c: "wrn" };
  if (xCobrar) return { k: "cobro", t: `Pagada, ${xCobrar} por cobrar en banco`, c: "wrn" };
  if (partes) return { k: "ok", t: `Procesada, ${partes}`, c: "okk" };
  return { k: "ok", t: tipoDe(n) === "transferencia" ? "Transferencia pagada" : "Procesada, todo pagado", c: "okk" };
}

// =====================================================================
// Nómina de remuneraciones y abonos: planilla "Pago Solo Abonos DET"
// (7 columnas): RUT, nombre, email, banco, forma de pago, cuenta, monto.
// Una línea por pago, sin documentos ni sector.
// =====================================================================

// Valida y normaliza un abono según el instructivo de la planilla de 7 columnas.
export function checkAbono(a, emailDefecto = "") {
  const e = [], w = [];
  const rut = normRut(a.rut);
  if (!rut) e.push("falta RUT"); else if (!rutOk(rut)) e.push("RUT " + rut + " con dígito verificador inválido");
  if (rut.length > 10) e.push("RUT supera 10 caracteres");
  const nombre = cleanName(a.nombre);
  if (!nombre) e.push("falta nombre");
  if (nombre.length > 60) e.push("nombre supera 60 caracteres");
  if (/\d/.test(nombre)) w.push("el nombre contiene números; el instructivo del banco pide solo letras");
  const email = S(a.email) || S(emailDefecto);
  if (email && (email.length > 40 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) e.push("email inválido o de más de 40 caracteres");
  const banco = pad(a.banco, 3);
  if (!M_BANCO[banco]) e.push("código de banco " + (banco || "vacío") + " no está en la tabla");
  const forma = pad(a.forma, 2);
  if (!M_FORMA_ABONO[forma]) e.push("forma de pago " + (forma || "vacía") + " no válida");
  if (FORMAS_SOLO_BE.has(forma) && banco !== "012") e.push("la forma de pago " + forma + " solo sirve con BancoEstado (012)");
  // Vale vista / pago cash: el N° de cuenta va en blanco. CuentaRUT: el RUT sin dígito verificador.
  let cuenta = normCuenta(a.cuenta);
  const sinCuenta = FORMAS_SIN_CUENTA.has(forma);
  if (sinCuenta) { if (cuenta && !/^0+$/.test(cuenta)) w.push("la forma " + forma + " no usa cuenta; se deja en blanco"); cuenta = "" }
  if (forma === "30" && rut) { const cr = rut.slice(0, -1); if (!cuenta) cuenta = cr; else if (cuenta !== cr) w.push("en CuentaRUT la cuenta debe ser el RUT sin dígito verificador (" + cr + ")") }
  if (!cuenta && !sinCuenta) e.push("falta número de cuenta");
  if (cuenta.length > 17) e.push("número de cuenta supera 17 dígitos");
  const monto = a.monto;
  if (!(Number.isInteger(monto) && monto > 0)) e.push("monto debe ser un entero mayor a cero");
  else if (String(monto).length > 13) e.push("monto supera 13 dígitos");
  return { e, w, out: { rut, nombre, email, banco, forma, cuenta, monto } };
}

// Último pago no rechazado a un RUT en nóminas de abonos (para autocompletar
// y avisar si la cuenta cambió: control contra fraude).
export function ultimoAbono(nominas, rut) {
  let ult = null;
  nominas.forEach(n => { if (n.tipo !== "abonos" || n.estado === "anulada") return; n.pagos.forEach(p => { if (p.rut === rut && p.estado !== "rechazado" && (!ult || n.num > ult.num)) ult = { num: n.num, p } }) });
  return ult;
}

// Arma la nómina de abonos de una fuente. ctx = { abonos, nominas, group, email }
export function buildAbonos(fuente, ctx) {
  const { abonos, nominas, group = false, email = "" } = ctx;
  const issues = [], groups = new Map(); let seq = 0;
  const list = abonos.filter(a => a.sel && a.fuente === fuente);
  const ids = list.map(a => a.id), vistos = new Map();
  // Pagos aún sin resultado en otras nóminas de abonos: rut|monto → N°
  const enCurso = {};
  nominas.forEach(n => { if (n.tipo !== "abonos" || n.estado === "anulada") return; n.pagos.forEach(p => { if (p.estado === "pendiente") enCurso[p.rut + "|" + p.monto] = n.num }) });
  list.forEach(a => {
    const c = checkAbono(a, email);
    const where = `${fmtRut(c.out.rut) || "sin RUT"} ${c.out.nombre}`.trim();
    c.e.forEach(m => issues.push({ lvl: "error", where, msg: m }));
    c.w.forEach(m => issues.push({ lvl: "warn", where, msg: m }));
    const k = c.out.rut + "|" + c.out.monto;
    if (vistos.has(k)) issues.push({ lvl: "warn", where, msg: "mismo RUT y monto aparece más de una vez en esta nómina; revisa que no sea un duplicado" });
    vistos.set(k, true);
    if (enCurso[k]) issues.push({ lvl: "warn", where, msg: `ya hay un pago a este RUT por el mismo monto en la nómina N° ${enCurso[k]}, aún sin resultado; revisa que no sea un pago repetido` });
    const ult = ultimoAbono(nominas, c.out.rut);
    const cta = v => /^0*$/.test(S(v)) ? "" : S(v); // "0" y en blanco son lo mismo
    if (ult && (ult.p.banco !== c.out.banco || cta(ult.p.cuenta) !== cta(c.out.cuenta) || (ult.p.forma && ult.p.forma !== c.out.forma)))
      issues.push({ lvl: "warn", where, msg: `los datos bancarios cambiaron respecto del último pago (N° ${ult.num}: banco ${ult.p.banco}, forma ${ult.p.forma || "?"}, cuenta ${ult.p.cuenta || "en blanco"}). Confirma el cambio antes de pagar.` });
    const key = group ? c.out.rut + "|" + c.out.banco + "|" + c.out.forma + "|" + c.out.cuenta : "#" + (seq++);
    if (!groups.has(key)) groups.set(key, { p: { ...c.out, monto: 0 }, docs: [] });
    const g = groups.get(key);
    g.docs.push({ id: a.id, monto: c.out.monto, concepto: S(a.concepto), glosa: S(a.glosa) });
  });
  let total = 0; const lines = [];
  for (const g of groups.values()) {
    const sum = g.docs.reduce((t, d) => t + (Number.isInteger(d.monto) ? d.monto : 0), 0);
    if (String(sum).length > 13) issues.push({ lvl: "error", where: fmtRut(g.p.rut), msg: "el monto del pago supera 13 dígitos" });
    g.sum = sum; g.p.monto = sum; total += sum;
    lines.push({ tipo: 7, f: [g.p.rut, g.p.nombre, g.p.email, g.p.banco, g.p.forma, g.p.cuenta, String(sum)] });
  }
  const errs = issues.filter(i => i.lvl === "error").length, warns = issues.length - errs;
  return { fuente, issues, lines, total, nBen: groups.size, nDocs: list.length, errs, warns, ids, groups: [...groups.values()] };
}

// Concepto sugerido a partir del nombre del archivo importado.
export function conceptoDeNombre(nombre) {
  const t = cleanName(S(nombre).replace(/[_\-.]/g, " "));
  if (/FONDO/.test(t)) return "FONDOS FIJOS";
  if (/CAJA CHICA/.test(t)) return "CAJA CHICA";
  if (/HONORARIO/.test(t)) return "HONORARIOS";
  if (/VIATICO/.test(t)) return "VIATICOS";
  if (/REMUNERA|SUELDO/.test(t)) return "REMUNERACIONES";
  return "";
}

// =====================================================================
// Reporte de pagos: lo que el banco ya pagó, por fecha de pago de la
// nómina (en las nóminas antiguas sin fecha de pago, la de carga).
// =====================================================================

export const fechaReporte = n => n.fechaPago || n.fechaCarga || "";

// ¿El pago es a este beneficiario? Por RUT (con o sin puntos y guion) o por parte del nombre.
export function esBeneficiario(p, q) {
  const t = S(q); if (!t) return true;
  const rut = normRut(t);
  if (/^\d{7,9}[0-9K]$/.test(rut) && rutOk(rut)) return normRut(p.rut) === rut;
  const nom = cleanName(t);
  return !!nom && (cleanName(p.nombre).includes(nom) || (/^\d{4,}$/.test(nom) && normRut(p.rut).startsWith(nom)));
}

// beneficiario: RUT o parte del nombre; deja en cada nómina solo los pagos a ese
// beneficiario (y su total), para ver lo pagado a un proveedor o persona.
export function reportePagos(nominas, { desde = "", hasta = "", fuente = "*", tipo = "*", beneficiario = "" } = {}) {
  const sel = nominas.filter(n => n.estado === "cargada"
    && (fuente === "*" || n.fuente === fuente)
    && (tipo === "*" || tipo === tipoDe(n))
    && (!desde || fechaReporte(n) >= desde) && (!hasta || fechaReporte(n) <= hasta))
    .map(n => { if (!S(beneficiario)) return n; const pagos = n.pagos.filter(p => esBeneficiario(p, beneficiario)); return pagos.length ? { ...n, pagos, total: pagos.reduce((a, p) => a + p.monto, 0) } : null })
    .filter(Boolean)
    .sort((a, b) => fechaReporte(a).localeCompare(fechaReporte(b)) || a.num - b.num);
  const cero = () => ({ nominas: 0, pagado: 0, nPagado: 0, rechazado: 0, nRechazado: 0, pendiente: 0, nPendiente: 0, porCobrar: 0, nPorCobrar: 0 });
  const tot = cero(), grupos = {}, pagados = [], rechazados = [];
  sel.forEach(n => {
    const tipoN = TIPOS_REGISTRO[tipoDe(n)];
    const g = grupos[tipoN + "|" + n.fuente] = grupos[tipoN + "|" + n.fuente] || { tipo: tipoN, fuente: n.fuente, ...cero() };
    g.nominas++; tot.nominas++;
    n.pagos.forEach(p => {
      // Un pago cash no cobrado (fondos devueltos a la cuenta) cuenta con los rechazados.
      const k = noCobrado(n, p) ? "rechazado" : p.estado === "pagado" ? "pagado" : p.estado === "rechazado" ? "rechazado" : "pendiente";
      if (porCobrar(n, p)) { g.porCobrar += p.monto; g.nPorCobrar++; tot.porCobrar += p.monto; tot.nPorCobrar++ }
      const nk = "n" + k[0].toUpperCase() + k.slice(1);
      g[k] += p.monto; g[nk]++; tot[k] += p.monto; tot[nk]++;
      if (k === "pagado") pagados.push({ n, p }); else if (k === "rechazado") rechazados.push({ n, p });
    });
  });
  const resumen = Object.values(grupos).sort((a, b) => a.tipo.localeCompare(b.tipo) || a.fuente.localeCompare(b.fuente));
  return { nominas: sel, resumen, tot, pagados, rechazados };
}

// Tablas del reporte, comunes al Excel y al PDF. Los montos van como { $: número }
// para que cada formato les dé su forma de pesos (y en el Excel se puedan sumar).
const $m = v => ({ $: v });
const tipoRep = n => TIPOS_REGISTRO[tipoDe(n)];
export const periodoReporte = (desde, hasta) => desde || hasta ? `${desde ? fmtISO(desde) : "inicio"} al ${hasta ? fmtISO(hasta) : "hoy"}` : "todas las fechas";

const estadoCobro = (n, p) => !esCobroCaja(n, p) ? "" : p.cobro === "cobrado" ? "Cobrado" + (p.cobroFecha ? " " + fmtISO(p.cobroFecha) : "") : "Pendiente de cobro";

export function reporteTablas(rep) {
  const t = rep.tot;
  const pagado = [];
  rep.pagados.forEach(({ n, p }) => p.docs.forEach((d, i) => pagado.push([
    fmtISO(fechaReporte(n)), n.num, S(n.operacion), tipoRep(n), n.fuente, fmtRut(p.rut), p.nombre, M_BANCO[p.banco] || S(p.banco), S(p.cuenta),
    !conDocumentos(n) ? S(d.concepto || n.concepto) : S(d.ndoc), !conDocumentos(n) ? "" : (M_TIPO[d.tipo] ? d.tipo + " " + M_TIPO[d.tipo] : S(d.tipo)),
    !conDocumentos(n) ? "" : fmtFecha(d.fecha), !conDocumentos(n) ? S(d.glosa) : S(d.dc),
    $m(NC.has(d.tipo) ? -d.monto : d.monto), i === 0 ? $m(p.monto) : null, i === 0 ? estadoCobro(n, p) : ""])));
  return {
    resumen: {
      head: ["TIPO", "FUENTE", "NÓMINAS", "PAGOS PAGADOS", "MONTO PAGADO", "RECHAZADOS", "MONTO RECHAZADO", "PENDIENTES", "MONTO PENDIENTE", "POR COBRAR EN BANCO"],
      body: rep.resumen.map(g => [g.tipo, g.fuente, g.nominas, g.nPagado, $m(g.pagado), g.nRechazado, $m(g.rechazado), g.nPendiente, $m(g.pendiente), $m(g.porCobrar)]),
      foot: ["TOTAL", "", t.nominas, t.nPagado, $m(t.pagado), t.nRechazado, $m(t.rechazado), t.nPendiente, $m(t.pendiente), $m(t.porCobrar)],
    },
    nominas: {
      head: ["N° NÓMINA", "N° BANCOESTADO", "TIPO", "FUENTE", "CONCEPTO", "FECHA CARGA", "FECHA PAGO", "CARGADA POR", "PAGOS", "TOTAL", "PAGADO", "RECHAZADO", "PENDIENTE"],
      body: rep.nominas.map(n => {
        const suma = e => n.pagos.filter(p => p.estado === e).reduce((s, p) => s + p.monto, 0);
        return [n.num, S(n.operacion), tipoRep(n), n.fuente, S(n.concepto), fmtISO(n.fechaCarga), fmtISO(n.fechaPago), S(n.cargadaPor), n.pagos.length, $m(n.total), $m(suma("pagado")), $m(suma("rechazado")), $m(suma("pendiente"))];
      }),
    },
    pagado: {
      head: ["FECHA PAGO", "N° NÓMINA", "N° BANCOESTADO", "TIPO", "FUENTE", "RUT", "BENEFICIARIO", "BANCO", "CUENTA", "N° DOC / CONCEPTO", "TIPO DOC", "FECHA DOC", "DC / GLOSA", "MONTO DOCUMENTO", "TOTAL PAGO", "COBRO EN BANCO"],
      body: pagado,
      foot: ["TOTAL PAGADO", "", "", "", "", "", "", "", "", "", "", "", "", null, $m(t.pagado), t.porCobrar ? "Por cobrar " + money(t.porCobrar) : ""],
    },
    rechazados: {
      head: ["FECHA PAGO", "N° NÓMINA", "N° BANCOESTADO", "TIPO", "FUENTE", "RUT", "BENEFICIARIO", "BANCO", "CUENTA", "MONTO", "MOTIVO", "REINTEGRADO A PENDIENTES"],
      body: rep.rechazados.map(({ n, p }) => [fmtISO(fechaReporte(n)), n.num, S(n.operacion), tipoRep(n), n.fuente, fmtRut(p.rut), p.nombre, M_BANCO[p.banco] || S(p.banco), S(p.cuenta), $m(p.monto), noCobrado(n, p) ? "No cobrado en banco, devuelto a la cuenta" + (p.cobroFecha ? " el " + fmtISO(p.cobroFecha) : "") : S(p.motivo), p.reint ? fmtISO(p.reint) : "No"]),
      foot: ["TOTAL RECHAZADO", "", "", "", "", "", "", "", "", $m(t.rechazado)],
    },
  };
}

// =====================================================================
// Reporte de pago de una nómina (o transferencia): el respaldo de que esa
// nómina se pagó. Usa el mismo cálculo y las mismas tablas del reporte de
// pagos, más la ficha de la nómina y su historial.
// =====================================================================

// Ficha: pares [etiqueta, valor]. meta: { estado (texto), creada (DD/MM/AAAA) }.
export function fichaNomina(n, { estado = "", creada = "" } = {}) {
  const tef = tipoDe(n) === "transferencia";
  const f = [
    [tef ? "Transferencia N°" : "Nómina N°", tef ? S(n.operacion) : String(n.num)],
    [tef ? "Registro N°" : "N° nómina BancoEstado", tef ? String(n.num) : S(n.operacion) || "—"],
    ["Tipo", TIPOS_REGISTRO[tipoDe(n)]],
    ["Fuente", S(n.fuente)],
  ];
  if (S(n.concepto)) f.push(["Concepto", S(n.concepto)]);
  f.push(["Estado", estado]);
  if (tef) {
    f.push(["Fecha y hora", fmtISO(n.fechaPago) + (n.horaTef ? " " + S(n.horaTef) : "")], ["ID TEF", S(n.idTef) || "—"],
      ["Cuenta de origen", S(n.cuentaOrigen) + (n.cuentaNombre ? " (" + S(n.cuentaNombre) + ")" : "")]);
    if (S(n.mensaje)) f.push(["Mensaje al beneficiario", S(n.mensaje)]);
    if (S(n.preparo)) f.push(["Preparó", S(n.preparo)]);
    if (S(n.autorizo)) f.push(["Autorizó", S(n.autorizo)]);
    f.push(["Qué paga", n.origen === "documentos" ? "Documentos pendientes" : n.origen === "abonos" ? "Abonos de Remuneraciones" : "Pago sin documento en el panel"]);
    f.push(["Registrada", creada + (n.creadaPor ? " por " + nombreDe(n.creadaPor) : "")]);
  } else {
    f.push(["Archivo", nombreNomina(n) + ".txt"], ["Generada", creada + (n.creadaPor ? " por " + nombreDe(n.creadaPor) : "")],
      ["Cargada en BancoEstado", n.fechaCarga ? fmtISO(n.fechaCarga) + (n.cargadaPor ? " por " + nombreDe(n.cargadaPor) : "") : "Sin cargar"],
      ["Fecha de pago", n.fechaPago ? fmtISO(n.fechaPago) : "—"]);
  }
  const nDocs = n.pagos.reduce((a, p) => a + (p.docs || []).length, 0);
  f.push(["Pagos", `${n.pagos.length}${conDocumentos(n) ? `, con ${nDocs} documento${nDocs === 1 ? "" : "s"}` : ""}`], ["Total", money(n.total)]);
  if (S(n.obs)) f.push(["Observación", S(n.obs)]);
  return f;
}

// Nombre del archivo del reporte: reporte_pago_nomina_15 o reporte_pago_transferencia_7044834.
export const nombreReporteNomina = n => tipoDe(n) === "transferencia" ? "reporte_pago_transferencia_" + (S(n.operacion) || n.num) : "reporte_pago_nomina_" + n.num;

// Hojas del Excel del reporte de pago de una nómina.
// meta: { estado, creada, historial: [{ fecha, accion, detalle, autor }], generado, por }
export function reporteNominaHojas(n, meta = {}) {
  const rep = reportePagos([n]), T = reporteTablas(rep), t = rep.tot;
  const tabla = x => [x.head, ...x.body, ...(x.foot ? [x.foot] : [])];
  const titulo = tipoDe(n) === "transferencia" ? `REPORTE DE PAGO · TRANSFERENCIA N° ${S(n.operacion)}` : `REPORTE DE PAGO · NÓMINA N° ${n.num}`;
  const nomina = [
    [titulo], ["Generado", (meta.generado || "") + (meta.por ? " por " + meta.por : "")], [],
    ...fichaNomina(n, meta), [],
    ["TOTALES", "MONTO", "PAGOS"],
    ["Pagado", $m(t.pagado), t.nPagado], ["Rechazado", $m(t.rechazado), t.nRechazado], ["Pendiente de resultado", $m(t.pendiente), t.nPendiente],
    ...(t.porCobrar ? [["Por cobrar en banco", $m(t.porCobrar), t.nPorCobrar]] : []),
  ];
  const hist = [["FECHA", "ACCIÓN", "DETALLE", "AUTOR"], ...(meta.historial || []).map(h => [h.fecha, h.accion, h.detalle, h.autor])];
  return [
    { nombre: "Nómina", filas: nomina, anchos: [26, 60, 10] },
    { nombre: "Pagado", filas: tabla(T.pagado), anchos: [11, 10, 14, 15, 12, 13, 34, 26, 14, 18, 22, 11, 14, 16, 14, 20] },
    { nombre: "Rechazados", filas: tabla(T.rechazados), anchos: [11, 10, 14, 15, 12, 13, 34, 26, 14, 14, 30, 14] },
    { nombre: "Historial", filas: hist, anchos: [16, 28, 90, 30] },
  ];
}

// Hojas del Excel del reporte (filas listas para SheetJS).
// meta: { desde, hasta, filtros ("Tipo: … · Fuente: …"), generado, por }
export function reporteHojas(rep, { desde = "", hasta = "", filtros = "", generado = "", por = "" } = {}) {
  const T = reporteTablas(rep);
  const tabla = x => [x.head, ...x.body, ...(x.foot ? [x.foot] : [])];
  const resumen = [
    ["REPORTE DE PAGOS BANCOESTADO"], ["Período (fecha de pago)", periodoReporte(desde, hasta)], ...(filtros ? [["Filtros", filtros]] : []), ["Generado", generado + (por ? " por " + por : "")], [],
    ...tabla(T.resumen), [],
    ["NÓMINAS DEL PERÍODO"], ...tabla(T.nominas),
  ];
  return [
    { nombre: "Resumen", filas: resumen, anchos: [16, 16, 16, 16, 16, 14, 16, 22, 16, 20, 14, 14, 14] },
    { nombre: "Pagado", filas: tabla(T.pagado), anchos: [11, 10, 14, 15, 12, 13, 34, 26, 14, 18, 22, 11, 14, 16, 14, 20] },
    { nombre: "Rechazados", filas: tabla(T.rechazados), anchos: [11, 10, 14, 15, 12, 13, 34, 26, 14, 14, 30, 14] },
  ];
}

// Lectura del Comprobante o Detalle de Transferencia Electrónica que descarga
// BancoEstado. El PDF trae los datos como una imagen (captura de la página del
// banco, RGB comprimido con Flate y una máscara de transparencia): se extrae la
// imagen sin librerías, el OCR la pasa a texto (js/ocr.js) y aquí se leen los
// campos de ese texto. Funciones puras, probadas en tests/comprobante.test.mjs.

import { BANCOS } from "./catalogos.js";
import { S, normRut, rutOk, fmtRut, parseMonto, cleanName } from "./formato.js";

// ---------- imagen dentro del PDF ----------
const latin1 = new TextDecoder("latin1");

// Diccionario << ... >> que empieza en i (admite diccionarios anidados).
function diccionario(txt, i) {
  let n = 0, j = i;
  while (j < txt.length) {
    if (txt.startsWith("<<", j)) { n++; j += 2 }
    else if (txt.startsWith(">>", j)) { n--; j += 2; if (!n) return { dic: txt.slice(i + 2, j - 2), fin: j } }
    else j++;
  }
  return null;
}
const num = (dic, k) => { const m = dic.match(new RegExp("/" + k + "\\s+(\\d+)(?!\\s+\\d+\\s+R)")); return m ? +m[1] : null };
const ref = (dic, k) => { const m = dic.match(new RegExp("/" + k + "\\s+(\\d+)\\s+\\d+\\s+R")); return m ? +m[1] : null };
const nombre = (dic, k) => { const m = dic.match(new RegExp("/" + k + "\\s*/(\\w+)")); return m ? m[1] : "" };

// Objetos del PDF con su diccionario y, si tienen, los bytes del stream.
export function objetosPdf(bytes) {
  const txt = latin1.decode(bytes), objs = new Map(), re = /(\d+)\s+\d+\s+obj\b/g;
  let m;
  while ((m = re.exec(txt))) {
    const ini = txt.indexOf("<<", m.index);
    const sig = txt.indexOf("endobj", m.index);
    if (ini < 0 || (sig >= 0 && ini > sig)) continue;
    const d = diccionario(txt, ini);
    if (!d) continue;
    const o = { dic: d.dic };
    const s = txt.slice(d.fin).match(/^\s*stream(\r\n|\n|\r)/);
    if (s) {
      const desde = d.fin + s[0].length;
      // /Length directo si calza con endstream; si no (o es una referencia), se busca endstream.
      let largo = num(d.dic, "Length");
      if (largo == null || !/^\s*endstream/.test(txt.slice(desde + largo, desde + largo + 20))) {
        largo = txt.indexOf("endstream", desde) - desde;
        if (txt[desde + largo - 1] === "\n") largo--;
        if (txt[desde + largo - 1] === "\r") largo--; // el fin de línea antes de endstream no es parte de los datos
      }
      if (largo < 0) break; // PDF cortado
      o.datos = bytes.subarray(desde, desde + largo);
      re.lastIndex = desde + largo;
    } else re.lastIndex = d.fin;
    objs.set(+m[1], o);
  }
  return objs;
}

async function inflar(datos) {
  const flujo = new Blob([datos]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(flujo).arrayBuffer());
}

// Deshace el predictor PNG (/Predictor 10 a 15) de un stream Flate.
function sinPredictor(d, dic, colores, ancho) {
  const p = num(dic, "Predictor") || 1;
  if (p < 10) return d;
  const bpp = colores, fila = ancho * colores, out = new Uint8Array(fila * Math.floor(d.length / (fila + 1)));
  for (let y = 0, i = 0; i + fila < d.length + 1 && y * fila < out.length; y++) {
    const f = d[i++], o = y * fila;
    for (let x = 0; x < fila; x++, i++) {
      const a = x >= bpp ? out[o + x - bpp] : 0, b = y ? out[o - fila + x] : 0, c = x >= bpp && y ? out[o - fila + x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      out[o + x] = d[i] + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0);
    }
  }
  return out;
}

async function pixeles(o, colores, ancho, alto) {
  const filtro = nombre(o.dic, "Filter");
  if (filtro !== "FlateDecode" || num(o.dic, "BitsPerComponent") !== 8) return null;
  const d = sinPredictor(await inflar(o.datos), o.dic, colores, ancho);
  return d.length >= ancho * alto * colores ? d : null;
}

// La imagen más grande del PDF en RGB comprimido con Flate, sobre fondo blanco.
// Devuelve { width, height, data } (RGBA, como ImageData) o null.
export async function imagenComprobante(bytes) {
  const objs = objetosPdf(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const imgs = [...objs.values()].filter(o => o.datos && /\/Subtype\s*\/Image/.test(o.dic) && nombre(o.dic, "ColorSpace") === "DeviceRGB" && nombre(o.dic, "Filter") === "FlateDecode")
    .map(o => ({ o, w: num(o.dic, "Width"), h: num(o.dic, "Height") })).filter(x => x.w > 0 && x.h > 0).sort((a, b) => b.w * b.h - a.w * a.h);
  for (const { o, w, h } of imgs) {
    const rgb = await pixeles(o, 3, w, h).catch(() => null);
    if (!rgb) continue;
    const m = objs.get(ref(o.dic, "SMask"));
    const alfa = m && m.datos ? await pixeles(m, 1, w, h).catch(() => null) : null;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < w * h; i++, j += 3) {
      const a = alfa ? alfa[i] / 255 : 1;
      data[i * 4] = rgb[j] * a + 255 * (1 - a); data[i * 4 + 1] = rgb[j + 1] * a + 255 * (1 - a); data[i * 4 + 2] = rgb[j + 2] * a + 255 * (1 - a); data[i * 4 + 3] = 255;
    }
    return { width: w, height: h, data };
  }
  return null;
}

// ---------- campos del texto (salida del OCR) ----------
const ROTULOS = /^(Fecha Transacci|Cuenta Origen|Beneficiario|Monto|Mensaje a Beneficiario|Etapas|Intervinientes|Rut\s+Nombre|\d\. Preparaci)/i;
const fechaISO = (d, m, a) => `${a}-${m}-${d}`;

// Código del banco a partir del nombre que muestra BancoEstado: el nombre
// exacto del catálogo, una de sus partes ("BANCO DE CHILE / A. EDWARDS / ...")
// o una parte distintiva contenida en el nombre ("BANCO SANTANDER-CHILE").
const OTROS_NOMBRES = { "BANCOESTADO": "012", "BANCO ESTADO": "012", "BANCO DE CREDITO E INVERSIONES": "016", "BANCO ITAU CHILE": "039", "SCOTIABANK CHILE": "014", "BANCO BICE": "028" };
export function codigoBanco(nom) {
  const n = cleanName(nom);
  if (!n) return "";
  if (OTROS_NOMBRES[n]) return OTROS_NOMBRES[n];
  const partes = BANCOS.map(([c, t]) => [c, t.split("/").map(cleanName).filter(Boolean)]);
  const exacto = partes.find(([, ps]) => ps.includes(n));
  if (exacto) return exacto[0];
  const genericas = new Set(["BANCO", "BANCO DE CHILE"]);
  const contiene = partes.find(([, ps]) => ps.some(p => p.length >= 5 && !genericas.has(p) && ` ${n} `.includes(` ${p.replace(/^BANCO /, "")} `)));
  return contiene ? contiene[0] : "";
}

// Lee los datos de la transferencia. Devuelve los campos y una lista de
// avisos (lo que no se pudo leer o no cuadra); con avisos, la persona revisa.
export function leerComprobante(texto) {
  const lineas = S(texto).split(/\r?\n/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const todo = lineas.join("\n"), avisos = [];
  const tras = re => { const i = lineas.findIndex(l => re.test(l)); return i < 0 ? [] : lineas.slice(i + 1) };
  const hasta = arr => { const k = arr.findIndex(l => ROTULOS.test(l)); return k < 0 ? arr : arr.slice(0, k) };

  const t = { operacion: "", idTef: "", fecha: "", hora: "", estado: "", cuentaOrigen: "", cuentaNombre: "", alias: "", monto: NaN, concepto: "", mensaje: "", intervinientes: [], preparo: "", autorizo: "",
    benef: { rut: "", nombre: "", banco: "", bancoNombre: "", tipoCuenta: "", cuenta: "" } };

  let m = todo.match(/Transferencia\s+Electr\S*\s*\|?\s*N\S{0,2}\s*(\d{4,})/i);
  if (m) t.operacion = m[1];
  m = todo.match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{1,2}):(\d{2})\s+(\d{6,})\s+([A-Za-zÁÉÍÓÚáéíóú]+)/);
  if (m) { t.fecha = fechaISO(m[1], m[2], m[3]); t.hora = m[4].padStart(2, "0") + ":" + m[5]; t.idTef = m[6]; t.estado = m[7] }
  m = (tras(/^Cuenta Origen/i)[0] || "").match(/^(\d[\d\s-]{4,})\s*\|\s*(.*)$/);
  if (m) { t.cuentaOrigen = m[1].replace(/\D/g, ""); t.cuentaNombre = m[2].trim() }

  // Beneficiario: alias (primera línea) y "NOMBRE | RUT | BANCO | Tipo de cuenta N°".
  const ben = hasta(tras(/^Beneficiario/i));
  const iPipe = ben.findIndex(l => (l.match(/\|/g) || []).length >= 2);
  if (iPipe >= 0) {
    const p = ben[iPipe].split("|").map(x => x.trim());
    const iRut = p.findIndex(x => /^\d{1,2}\.?\d{3}\.?\d{3}-?[\dkK]$/.test(x));
    if (iRut >= 0) {
      t.benef.rut = normRut(p[iRut]);
      t.benef.nombre = p.slice(0, iRut).join(" ").trim();
      t.benef.bancoNombre = S(p[iRut + 1]);
      const c = S(p.slice(iRut + 2).join(" ")).match(/^(.*?)\s*(\d{3,})$/);
      if (c) { t.benef.tipoCuenta = c[1].trim(); t.benef.cuenta = c[2].replace(/^0+(?=\d)/, "") }
    }
    t.alias = ben.slice(0, iPipe).filter(l => !/@|O\w+\.\w{2,3};?$/.test(l)).join(" ");
  }
  t.benef.banco = codigoBanco(t.benef.bancoNombre);
  if (!t.benef.nombre) t.benef.nombre = t.alias;

  m = (tras(/^Monto\b/i)[0] || "").match(/^\$\s*([\d.,]+)\s*(.*)$/);
  if (m) { t.monto = parseMonto(m[1]); t.concepto = m[2].trim() }
  const msj = hasta(tras(/^Mensaje a Beneficiario/i))[0];
  if (msj) t.mensaje = msj;

  // Intervinientes: RUT, nombre, fecha - hora y acción (Preparación, Autorización 1, 2...).
  for (const l of tras(/^Intervinientes/i)) {
    const x = l.match(/^(\d{1,2}\.?\d{3}\.?\d{3}-?[\dkK])\s+(.+?)\s+\d{2}\/\d{2}\/\d{4}\s*-\s*\d{1,2}:\d{2}\s+(Preparaci\S*|Autorizaci\S*\s*\d*)/i);
    if (x) t.intervinientes.push({ rut: normRut(x[1]), nombre: x[2].replace(/\s*\.{2,}$|\s*…$/, "…").trim(), accion: /^Prep/i.test(x[3]) ? "Preparación" : "Autorización" + (x[3].match(/\d+/) ? " " + x[3].match(/\d+/)[0] : "") });
  }
  t.preparo = t.intervinientes.filter(i => i.accion === "Preparación").map(i => i.nombre).join(", ");
  t.autorizo = t.intervinientes.filter(i => i.accion !== "Preparación").map(i => i.nombre).join(", ");

  // Controles: lo que falta o no cuadra queda como aviso.
  if (!/^\d{5,}$/.test(t.operacion)) avisos.push("No se leyó el N° de transferencia.");
  if (!t.fecha) avisos.push("No se leyó la fecha de la transacción.");
  if (t.estado && !/^autorizada$/i.test(t.estado)) avisos.push(`El banco informa la transferencia como “${t.estado}”, no autorizada.`);
  if (!t.cuentaOrigen) avisos.push("No se leyó la cuenta de origen.");
  if (!t.benef.rut) avisos.push("No se leyó el RUT del beneficiario.");
  else if (!rutOk(t.benef.rut)) avisos.push(`El RUT del beneficiario leído (${fmtRut(t.benef.rut)}) no tiene un dígito verificador válido.`);
  if (/cuenta\s*rut/i.test(t.benef.tipoCuenta) && t.benef.rut && t.benef.cuenta && t.benef.cuenta !== t.benef.rut.slice(0, -1)) avisos.push("La CuentaRUT leída no coincide con el RUT del beneficiario.");
  if (t.benef.bancoNombre && !t.benef.banco) avisos.push(`Banco del beneficiario no reconocido: ${t.benef.bancoNombre}.`);
  if (!(t.monto > 0)) avisos.push("No se leyó el monto.");
  if (!t.concepto) avisos.push("No se leyó el concepto.");
  t.intervinientes.filter(i => !rutOk(i.rut)).forEach(i => avisos.push(`RUT de ${i.nombre} leído con dígito verificador inválido.`));
  return { ...t, avisos };
}

// ¿El texto parece un comprobante o detalle de transferencia de BancoEstado?
export const esComprobante = texto => /Transferencia\s+Electr/i.test(texto) && /Cuenta\s+Origen/i.test(texto);

// Combinación de pendientes que suma exactamente el monto (hasta 16 ítems).
// valor(x) da el monto con signo (las notas de crédito restan). Devuelve los
// ítems o null si no hay una única combinación.
export function combinacionExacta(items, monto, valor = x => x.monto) {
  if (!(monto > 0) || !items.length || items.length > 16) return null;
  const v = items.map(valor), total = v.reduce((a, b) => a + b, 0);
  if (total === monto) return items.slice();
  let hallada = null, n = 0;
  for (let mask = 1; mask < 1 << items.length; mask++) {
    let s = 0;
    for (let i = 0; i < items.length; i++) if (mask & (1 << i)) s += v[i];
    if (s === monto && ++n === 1) hallada = mask;
    if (n > 1) return null;
  }
  return hallada == null ? null : items.filter((_, i) => hallada & (1 << i));
}

// Minimal .xlsx reader on top of jszip (already a dependency, loaded on
// demand like backup.js does) + the browser's DOMParser - the browser
// counterpart of read_xlsx() in tools/rvtools2cypher/rvtools2cypher.py.
// Returns { sheetName: [ { header: cellValue, ... }, ... ] }; date-styled
// numeric cells come back as Date objects, everything else as strings.
import { toDateTime } from './common.js';

const DATE_NUMFMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('Invalid XML inside the .xlsx file');
  return doc;
}

function byTag(node, tag) {
  return Array.from(node.getElementsByTagNameNS('*', tag));
}

function attr(el, name) {
  // attributes may be namespaced (r:id) or not, depending on the writer
  return el.getAttribute(name) ?? el.getAttribute(name.split(':').pop())
    ?? Array.from(el.attributes).find((a) => a.localName === name.split(':').pop())?.value ?? null;
}

function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

function textOf(el) {
  return byTag(el, 't').map((t) => t.textContent).join('');
}

function dateStyleIds(stylesXml) {
  const out = new Set();
  if (!stylesXml) return out;
  const doc = parseXml(stylesXml);
  const custom = {};
  for (const f of byTag(doc, 'numFmt')) custom[Number(attr(f, 'numFmtId'))] = attr(f, 'formatCode') || '';
  const cellXfs = byTag(doc, 'cellXfs')[0];
  if (!cellXfs) return out;
  byTag(cellXfs, 'xf').forEach((xf, i) => {
    const fid = Number(attr(xf, 'numFmtId') || 0);
    if (DATE_NUMFMT_IDS.has(fid)) out.add(String(i));
    else if (custom[fid] !== undefined) {
      const code = custom[fid].replace(/"[^"]*"|\[[^\]]*\]|\\./g, '').toLowerCase();
      if (/[ymdh]/.test(code) && !code.includes('#') && !code.includes('0')) out.add(String(i));
    }
  });
  return out;
}

export async function readXlsx(file) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const read = (path) => (zip.file(path) ? zip.file(path).async('string') : Promise.resolve(null));

  const shared = [];
  const sharedXml = await read('xl/sharedStrings.xml');
  if (sharedXml) for (const si of byTag(parseXml(sharedXml), 'si')) shared.push(textOf(si));
  const dateStyles = dateStyleIds(await read('xl/styles.xml'));

  const workbook = parseXml(await read('xl/workbook.xml'));
  const rels = parseXml(await read('xl/_rels/workbook.xml.rels'));
  const relTarget = {};
  for (const r of byTag(rels, 'Relationship')) relTarget[attr(r, 'Id')] = attr(r, 'Target');

  const sheets = {};
  for (const s of byTag(workbook, 'sheet')) {
    const target = relTarget[attr(s, 'r:id')] || '';
    const member = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const xml = await read(member);
    if (!xml) continue;
    const doc = parseXml(xml);
    const rows = [];
    let header = null;
    for (const row of byTag(doc, 'row')) {
      const cells = {};
      let auto = 0;
      for (const c of byTag(row, 'c')) {
        auto += 1;
        const ref = attr(c, 'r');
        const idx = ref ? colIndex(ref) : auto;
        const t = attr(c, 't');
        let val = null;
        if (t === 'inlineStr') {
          const is = byTag(c, 'is')[0];
          val = is ? textOf(is) : null;
        } else {
          const v = byTag(c, 'v')[0];
          if (v && v.textContent !== null) {
            if (t === 's') val = shared[Number(v.textContent)];
            else if (t === 'b') val = v.textContent === '1' ? 'True' : 'False';
            else {
              val = v.textContent;
              if (t !== 'str' && t !== 'e' && dateStyles.has(attr(c, 's'))) {
                const d = toDateTime(val);
                if (d) val = d;
              }
            }
          }
        }
        if (val !== null && val !== '') cells[idx] = val;
      }
      if (header === null) {
        if (Object.keys(cells).length === 0) continue;
        header = {};
        for (const [i, v] of Object.entries(cells)) header[i] = String(v).trim();
        continue;
      }
      const obj = {};
      for (const [i, v] of Object.entries(cells)) if (header[i] !== undefined) obj[header[i]] = v;
      rows.push(obj);
    }
    sheets[attr(s, 'name')] = rows;
  }
  return sheets;
}

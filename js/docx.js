// docx.js — app.py 中 update_docx / generate_document / get_monitor_info /
// safe_filename 的移植。同一份代码在浏览器与 Node 中运行，差异只在注入的
// 依赖里：
//   deps.JSZip —— 浏览器用 CDN 的全局 JSZip，Node 用 npm 的 jszip。
//   deps.dom   —— { parse(xmlString) -> Document, serialize(doc) -> string }；
//                 浏览器用原生 DOMParser/XMLSerializer，Node 用 @xmldom/xmldom。
//
// DOM 操作一律用「命名空间 URI + localName」匹配 w: 元素，与 Python
// ElementTree 按命名空间查找的行为一致，不依赖具体前缀写法。

import { validateDateString } from './extract.js';

export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// ---------- 小型 DOM 辅助（浏览器 DOM 与 @xmldom 通用） ----------

function isElement(node) {
  return node && node.nodeType === 1;
}

function isW(node, localName) {
  return isElement(node) && node.localName === localName && node.namespaceURI === W_NS;
}

function childElements(el) {
  return Array.from(el.childNodes || []).filter(isElement);
}

function childrenByTag(el, localName) {
  return childElements(el).filter((node) => isW(node, localName));
}

function descendantsByTag(el, localName) {
  const out = [];
  (function walk(node) {
    for (const child of Array.from(node.childNodes || [])) {
      if (!isElement(child)) continue;
      if (isW(child, localName)) out.push(child);
      walk(child);
    }
  })(el);
  return out;
}

function firstDescendantByTag(el, localName) {
  for (const child of Array.from(el.childNodes || [])) {
    if (!isElement(child)) continue;
    if (isW(child, localName)) return child;
    const found = firstDescendantByTag(child, localName);
    if (found) return found;
  }
  return null;
}

function paragraphText(paragraph) {
  return descendantsByTag(paragraph, 't')
    .map((node) => node.textContent || '')
    .join('');
}

function documentRoot(doc) {
  return doc.documentElement || doc;
}

function firstTable(root) {
  return firstDescendantByTag(root, 'tbl');
}

function tableRows(table) {
  return childrenByTag(table, 'tr');
}

function rowCells(row) {
  return childrenByTag(row, 'tc');
}

// ---------- 与 app.py 一一对应的函数 ----------

export function setCellContent(cell, paragraphs) {
  // 替换单元格文本，同时保留单元格、段落与文字的样式（同 app.py）。
  const doc = cell.ownerDocument;
  const oldParagraphs = childrenByTag(cell, 'p');
  const prototype = oldParagraphs.length ? oldParagraphs[0] : doc.createElementNS(W_NS, 'w:p');
  const ppr = childrenByTag(prototype, 'pPr')[0] || null;
  const firstRun = firstDescendantByTag(prototype, 'r');
  const rpr = firstRun ? childrenByTag(firstRun, 'rPr')[0] || null : null;

  for (const child of Array.from(cell.childNodes || [])) {
    if (!isW(child, 'tcPr')) cell.removeChild(child);
  }

  for (const paragraphTextValue of paragraphs) {
    const paragraph = doc.createElementNS(W_NS, 'w:p');
    if (ppr) paragraph.appendChild(ppr.cloneNode(true));
    const run = doc.createElementNS(W_NS, 'w:r');
    paragraph.appendChild(run);
    if (rpr) run.appendChild(rpr.cloneNode(true));
    const lines = String(paragraphTextValue).split('\n');
    lines.forEach((line, index) => {
      if (index) run.appendChild(doc.createElementNS(W_NS, 'w:br'));
      const textNode = doc.createElementNS(W_NS, 'w:t');
      textNode.setAttributeNS(XML_NS, 'xml:space', 'preserve');
      textNode.textContent = line;
      run.appendChild(textNode);
    });
    cell.appendChild(paragraph);
  }
}

export function makeParagraph(text, prototype) {
  // 以原型段落的样式（pPr 与首个 run 的 rPr）新建一个段落（同 app.py）。
  const doc = prototype.ownerDocument;
  const paragraph = doc.createElementNS(W_NS, 'w:p');
  const ppr = childrenByTag(prototype, 'pPr')[0] || null;
  if (ppr) paragraph.appendChild(ppr.cloneNode(true));
  const firstRun = firstDescendantByTag(prototype, 'r');
  const rpr = firstRun ? childrenByTag(firstRun, 'rPr')[0] || null : null;
  const run = doc.createElementNS(W_NS, 'w:r');
  paragraph.appendChild(run);
  if (rpr) run.appendChild(rpr.cloneNode(true));
  const textNode = doc.createElementNS(W_NS, 'w:t');
  textNode.setAttributeNS(XML_NS, 'xml:space', 'preserve');
  textNode.textContent = text;
  run.appendChild(textNode);
  return paragraph;
}

export function replaceBetween(cell, startTitle, endTitle, newText) {
  // 把两个标题段落之间的段落替换为新内容（一行一段）。找到标题并完成
  // 替换时返回 true；newText 为空/空白时保持模板原文不动（同 app.py）。
  if (newText === null || newText === undefined) return false;
  if (!String(newText).trim()) return false;
  const paras = childrenByTag(cell, 'p');
  const texts = paras.map((p) => paragraphText(p).trim());
  let startIdx = null;
  let endIdx = null;
  for (let index = 0; index < paras.length; index++) {
    if (startIdx === null && texts[index] === startTitle) {
      startIdx = index;
    } else if (startIdx !== null && texts[index] === endTitle) {
      endIdx = index;
      break;
    }
  }
  if (startIdx === null || endIdx === null || endIdx <= startIdx + 1) return false;

  const prototype = paras[startIdx];
  const lines = String(newText).split('\n').filter((line) => line.trim());
  const newParagraphs = lines.map((line) => makeParagraph(line, prototype));

  for (let index = endIdx - 1; index > startIdx; index--) {
    cell.removeChild(paras[index]);
  }
  const reference = paras[endIdx];
  for (const newParagraph of newParagraphs) {
    cell.insertBefore(newParagraph, reference);
  }
  return true;
}

export function getMonitorInfoFromXml(documentXml, dom) {
  // 从模板 document.xml 中提取默认的一类/二类信息（供界面预填，同 app.py
  // 的 get_monitor_info，只是输入改为已解出的 document.xml 文本）。
  const root = documentRoot(dom.parse(documentXml));
  const table = firstTable(root);
  if (!table) return { first_class: '', second_class: '' };
  const rows = tableRows(table);
  if (rows.length < 12) return { first_class: '', second_class: '' };
  const cell = rowCells(rows[11])[1];
  const texts = childrenByTag(cell, 'p').map((p) => paragraphText(p).trim());

  function collect(startTitle, endTitle) {
    let start = null;
    for (let index = 0; index < texts.length; index++) {
      if (texts[index] === startTitle) {
        start = index;
      } else if (start !== null && texts[index] === endTitle) {
        return texts.slice(start + 1, index).filter((item) => item);
      }
    }
    return [];
  }

  const first = collect('一类信息：', '二类信息：');
  const second = collect('二类信息：', '中队信息');
  return { first_class: first.join('\n'), second_class: second.join('\n') };
}

export async function updateDocx(templateBytes, options, deps) {
  // 返回生成好的 .docx 字节（Uint8Array）。options:
  // { date, flights, selectedAirports, firstClass = null, secondClass = null }
  const { JSZip, dom } = deps;
  const { date, flights, selectedAirports } = options;
  const firstClass = options.firstClass ?? null;
  const secondClass = options.secondClass ?? null;

  const zip = await JSZip.loadAsync(templateBytes);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('模板中缺少 word/document.xml');
  const xmlString = await documentFile.async('string');

  const doc = dom.parse(xmlString);
  const root = documentRoot(doc);
  const table = firstTable(root);
  if (!table) throw new Error('模板中未找到航前信息表格');
  const rows = tableRows(table);
  if (rows.length < 12) throw new Error('模板表格结构与预期不符');

  const dateCells = rowCells(rows[6]);
  const airportCells = rowCells(rows[10]);
  if (dateCells.length < 2 || airportCells.length < 2) {
    throw new Error('模板目标单元格与预期不符');
  }

  setCellContent(dateCells[0], [`日期：${date}`]);
  setCellContent(dateCells[1], [`航班号（航线）：${flights}`]);
  const airportParagraphs = selectedAirports.map((airport) => {
    const title = [airport.short_name || '', airport.icao || '', airport.name || '']
      .filter((part) => part)
      .join(' ');
    return `${title}\n${(airport.details || '').trim()}`;
  });
  setCellContent(airportCells[1], airportParagraphs);

  if (firstClass !== null || secondClass !== null) {
    const monitorCells = rowCells(rows[11]);
    if (monitorCells.length < 2) throw new Error('模板监控信息单元格与预期不符');
    const monitorCell = monitorCells[1];
    replaceBetween(monitorCell, '一类信息：', '二类信息：', firstClass);
    replaceBetween(monitorCell, '二类信息：', '中队信息', secondClass);
  }

  // @xmldom 的序列化会带上原文档的 XML 声明、浏览器不会；统一剥掉已有
  // 声明再补一个，避免出现两个声明导致文档损坏。
  const serialized = dom.serialize(doc).replace(/^\s*<\?xml[\s\S]*?\?>/, '');
  zip.file('word/document.xml', XML_DECLARATION + serialized);
  const output = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

  // 与 app.py 相同的生成后复核：重新打开成品，确认日期与航班号都在。
  const checkZip = await JSZip.loadAsync(output);
  const checkDoc = dom.parse(await checkZip.file('word/document.xml').async('string'));
  const checkText = descendantsByTag(documentRoot(checkDoc), 't')
    .map((node) => node.textContent || '')
    .join('');
  if (!checkText.includes(date) || !checkText.includes(flights)) {
    throw new Error('生成后的字段复核失败');
  }
  return output;
}

export function safeFilename(value, maxLength = 80) {
  const cleaned = String(value)
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^[._]+/, '')
    .replace(/[._]+$/, '');
  return cleaned.slice(0, maxLength) || '航前文档';
}

export async function generateDocument(payload, deps) {
  // deps: { airports, templateBytes, JSZip, dom }
  // 返回 { filename, bytes, airports: [名称...], warnings: [...] }。
  // 校验顺序与报错文案与 app.py 的 generate_document 一致。
  const { airports, templateBytes, JSZip, dom } = deps;
  const date = String(payload.date ?? '').trim();
  const flights = String(payload.flights ?? '').trim();
  const airportIds = payload.airport_ids;
  // 空/空白表示「保留模板原文」，避免预填内容被意外清空（同 app.py）。
  const cleanOptional = (value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
  };
  const firstClass = cleanOptional(payload.first_class);
  const secondClass = cleanOptional(payload.second_class);

  if (!date) throw new Error('请填写日期');
  validateDateString(date);
  if (!flights) throw new Error('请填写航班号');
  if (!Array.isArray(airportIds) || !airportIds.length) {
    throw new Error('请至少选择一个机场');
  }

  const mapping = new Map(airports.map((item) => [item.id, item]));
  const missing = airportIds.filter((id) => !mapping.has(id));
  if (missing.length) throw new Error(`机场库中找不到：${missing.join('、')}`);
  const selected = airportIds.map((id) => mapping.get(id));

  // 机场库条目被标记待核查、或没有细则内容的机场，不能悄悄进入正式
  // 文档：以警告形式提示机组核对（同 app.py）。
  const warnings = [];
  for (const airport of selected) {
    const label = airport.name || airport.id;
    if (!String(airport.details || '').trim()) {
      warnings.push(`${label} 在机场库中没有细则内容，生成文档中该机场只有标题，请核对`);
    } else if (airport.needs_review) {
      warnings.push(`${label} 的机场库条目被标记为待核查，请核对四字码与细则后再使用`);
    }
  }

  const bytes = await updateDocx(
    templateBytes,
    { date, flights, selectedAirports: selected, firstClass, secondClass },
    { JSZip, dom },
  );
  return {
    filename: safeFilename(`航前信息简述表_${date}_${flights}`) + '.docx',
    bytes,
    airports: selected.map((item) => item.name),
    warnings,
  };
}

// 供测试与打包脚本复用的 DOM 遍历（与 Python 测试里读单元格的方式对应）。
export const _dom = {
  childrenByTag,
  descendantsByTag,
  firstDescendantByTag,
  paragraphText,
  documentRoot,
  firstTable,
  tableRows,
  rowCells,
};

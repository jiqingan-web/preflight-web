// app.js — 纯网页版界面逻辑。原服务端版的 /api/ocr、/api/extract、
// /api/generate 与访问口令（key）机制全部去掉：OCR 用 Tesseract.js 在
// 本机浏览器内跑（chi_sim+eng、psm 6，与原服务端 tesseract 调用一致），
// 提取与 Word 生成分别调用 js/extract.js 与 js/docx.js 在本地完成。
//
// 数据加载：优先 fetch 同目录的 data.enc（加密包）→ 口令门 → WebCrypto
// 在内存中解密；不存在 data.enc 时回退到明文 data.json + template.docx
//（本地开发用，tools/pack.mjs --plain 产出）。

import { extractHints } from './extract.js';
import { generateDocument } from './docx.js';
import { decryptBundle, base64Decode } from './crypto.js';

const $ = (id) => document.getElementById(id);
const browserDom = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'text/xml'),
  serialize: (doc) => new XMLSerializer().serializeToString(doc),
};

let airportData = [];
let templateBytes = null;
let currentFile = null;
let generatedFile = null; // { blob, filename, url }
const selected = new Set();

function status(message, error = false) {
  $('status').textContent = message;
  $('status').className = 'status' + (error ? ' error' : '');
}

function byId(id) {
  return airportData.find((a) => a.id === id);
}

function applyAirports(ids) {
  selected.clear();
  (ids || []).forEach((id) => {
    if (byId(id)) selected.add(id);
  });
  renderAirports();
}

function renderAirports() {
  const chips = Array.from(selected)
    .map((id) => {
      const a = byId(id);
      if (!a) return '';
      const warn = a.needs_review || !(a.details || '').trim() ? '<small style="color:var(--red)">待核查</small>' : '';
      return `<span class="airport-chip">${a.short_name || a.name} · ${a.icao}<small>${a.name}</small>${warn}</span>`;
    })
    .join('');
  $('airports').innerHTML = chips || '<div class="empty">选择截图后自动匹配机场</div>';
}

function applyValues(values) {
  if (values.date) {
    $('date').value = values.date;
    $('date').classList.add('filled');
  }
  if (values.flights) {
    $('flights').value = values.flights;
    $('flights').classList.add('filled');
  }
  applyAirports(values.airport_ids);
}

function applyHints(hints) {
  applyValues(hints);
  renderDutyPicker(hints);
}

function renderDutyPicker(hints) {
  const field = $('dutyField');
  const picker = $('dutyPicker');
  picker.innerHTML = '';
  const groups = hints.groups || [];
  if (groups.length < 2) {
    field.style.display = 'none';
    return;
  }
  field.style.display = '';
  const options = [{ label: '全部合并', values: hints, active: true }];
  groups.forEach((group) => options.push({ label: group.date, values: group, active: false }));
  options.forEach((option) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'duty-chip' + (option.active ? ' active' : '');
    btn.textContent = option.label;
    btn.onclick = () => {
      picker.querySelectorAll('.duty-chip').forEach((chip) => chip.classList.remove('active'));
      btn.classList.add('active');
      applyValues(option.values);
    };
    picker.appendChild(btn);
  });
}

// ---------- OCR：Tesseract.js v5（chi_sim+eng，psm 6） ----------

let tesseractPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractPromise) return tesseractPromise;
  tesseractPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => reject(new Error('网页识别组件加载失败，请检查网络。'));
    document.head.appendChild(script);
  });
  return tesseractPromise;
}

let ocrWorkerPromise = null;
function getOcrWorker() {
  if (ocrWorkerPromise) return ocrWorkerPromise;
  ocrWorkerPromise = (async () => {
    const Tesseract = await loadTesseract();
    const worker = await Tesseract.createWorker('chi_sim+eng');
    // 与原服务端一致：tesseract -l chi_sim+eng --psm 6。
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    return worker;
  })();
  return ocrWorkerPromise;
}

async function browserOcr(file) {
  const worker = await getOcrWorker();
  status('正在本机识别截图（首次需下载识别模型，稍慢）…');
  const result = await worker.recognize(file);
  return result.data.text.trim();
}

// ---------- 主流程 ----------

async function autoRun() {
  $('result').className = 'result';
  generatedFile = null;
  try {
    if (!templateBytes) {
      status('数据尚未解锁或加载完成。', true);
      return;
    }
    if (currentFile) {
      status('正在识别截图并自动生成，请保持页面打开…');
      const text = await browserOcr(currentFile);
      $('ocrText').value = text;
      applyHints(extractHints(text, airportData));
    } else {
      const text = $('ocrText').value.trim();
      if (!text) {
        status('请先从相册选择一张航班截图。', true);
        return;
      }
      status('正在根据文字自动匹配并生成…');
      applyHints(extractHints(text, airportData));
    }
    if (!selected.size) {
      status('没有识别到机场，请检查截图或补充文字。', true);
      return;
    }
    await generate();
  } catch (e) {
    status(e.message, true);
  }
}

async function generate() {
  const airport_ids = Array.from(selected);
  $('generateBtn').disabled = true;
  $('generateBtn').textContent = '正在生成…';
  $('result').className = 'result';
  status('正在写入模板并校验 Word 文件…');
  try {
    const result = await generateDocument(
      {
        date: $('date').value,
        flights: $('flights').value,
        airport_ids,
        first_class: $('firstClass').value,
        second_class: $('secondClass').value,
      },
      { airports: airportData, templateBytes, JSZip: window.JSZip, dom: browserDom },
    );
    const blob = new Blob([result.bytes], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    if (generatedFile && generatedFile.url) URL.revokeObjectURL(generatedFile.url);
    generatedFile = { blob, filename: result.filename, url: URL.createObjectURL(blob) };
    $('download').href = generatedFile.url;
    $('download').setAttribute('download', generatedFile.filename);
    $('result').className = 'result show';
    const warnings = result.warnings || [];
    status(
      `已自动填写：日期 ${$('date').value}，航班号 ${$('flights').value}；机场 ${result.airports.join('、')}。请校对后保存 Word。` +
        (warnings.length ? ` ⚠ ${warnings.join('；')}` : ''),
      warnings.length > 0,
    );
    $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    status(e.message, true);
  } finally {
    $('generateBtn').disabled = false;
    $('generateBtn').textContent = '重新生成（用当前信息）';
  }
}

async function shareWord() {
  if (!generatedFile) {
    status('请先生成 Word 文档。', true);
    return;
  }
  try {
    const file = new File([generatedFile.blob], generatedFile.filename, { type: generatedFile.blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: '航前信息简述表' });
      status('已打开系统分享菜单，可选择“存储到文件”或 Word。');
    } else {
      const link = document.createElement('a');
      link.href = generatedFile.url;
      link.setAttribute('download', generatedFile.filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      status('已请求下载。可在浏览器下载列表中找到 Word 文档。');
    }
  } catch (e) {
    if (e.name !== 'AbortError') status(e.message, true);
  }
}

function setFile(file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    status('图片超过 20 MB，请压缩后再试。', true);
    return;
  }
  currentFile = file;
  $('drop').classList.add('has-image');
  $('preview').src = URL.createObjectURL(file);
  status('截图已载入，点击“一键识别并生成 Word”。');
}

$('file').addEventListener('change', (e) => setFile(e.target.files[0]));
['dragenter', 'dragover'].forEach((name) =>
  $('drop').addEventListener(name, (e) => {
    e.preventDefault();
    $('drop').classList.add('drag');
  }),
);
['dragleave', 'drop'].forEach((name) =>
  $('drop').addEventListener(name, (e) => {
    e.preventDefault();
    $('drop').classList.remove('drag');
  }),
);
$('drop').addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));
$('autoBtn').addEventListener('click', autoRun);
$('generateBtn').addEventListener('click', generate);
$('shareBtn').addEventListener('click', shareWord);

// ---------- 数据加载与口令门 ----------

function startApp(bundle) {
  airportData = bundle.airports;
  templateBytes = bundle.templateBytes;
  renderAirports();
  const monitor = bundle.monitor || {};
  if (monitor.first_class) {
    $('firstClass').value = monitor.first_class;
    $('firstClass').classList.add('filled');
  }
  if (monitor.second_class) {
    $('secondClass').value = monitor.second_class;
    $('secondClass').classList.add('filled');
  }
  $('gate').style.display = 'none';
}

let pendingEnvelope = null;

async function unlock() {
  const passphrase = $('passphrase').value;
  if (!passphrase) {
    $('gateStatus').textContent = '请输入口令。';
    $('gateStatus').className = 'status error';
    return;
  }
  $('unlockBtn').disabled = true;
  $('gateStatus').textContent = '正在解密…';
  $('gateStatus').className = 'status';
  try {
    const plainBytes = await decryptBundle(pendingEnvelope, passphrase);
    const bundle = JSON.parse(new TextDecoder().decode(plainBytes));
    startApp({
      airports: bundle.airports,
      monitor: bundle.monitor,
      templateBytes: base64Decode(bundle.templateDocx),
    });
    status('数据已解锁。模板中的个人信息、自我评价及近期重要文件将保持不变。');
  } catch (_) {
    $('gateStatus').textContent = '口令不正确，请重新输入。';
    $('gateStatus').className = 'status error';
  } finally {
    $('unlockBtn').disabled = false;
  }
}

$('unlockBtn').addEventListener('click', unlock);
$('passphrase').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') unlock();
});

async function init() {
  // 加密包优先：GitHub Pages 发布的是 data.enc。
  try {
    const response = await fetch('data.enc', { cache: 'no-store' });
    if (response.ok) {
      pendingEnvelope = JSON.parse(await response.text());
      $('gate').style.display = '';
      $('passphrase').focus();
      return;
    }
  } catch (_) {
    /* 继续尝试明文模式 */
  }
  // 明文回退（本地开发）：data.json + template.docx。
  try {
    const dataResponse = await fetch('data.json', { cache: 'no-store' });
    if (!dataResponse.ok) throw new Error('未找到数据文件（data.enc / data.json），请先运行打包脚本：node tools/pack.mjs。');
    const data = await dataResponse.json();
    const templateResponse = await fetch('template.docx', { cache: 'no-store' });
    if (!templateResponse.ok) throw new Error('未找到模板文件 template.docx。');
    startApp({
      airports: data.airports,
      monitor: data.monitor,
      templateBytes: new Uint8Array(await templateResponse.arrayBuffer()),
    });
  } catch (e) {
    status(e.message, true);
  }
}

init();

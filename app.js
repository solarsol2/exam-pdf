'use strict';

/* =========================================================
 * 패스노트 PassNote — 교안 요약 & 예상문제 생성기
 * - Gemini API를 브라우저에서 직접 호출 (서버 없음)
 * - API 키는 최초 1회 입력 후 localStorage에 저장
 * ========================================================= */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const KEY_STORE = 'passnote.geminiKey';
const MODEL_STORE = 'passnote.lastModel';
const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
// 한 번의 요청에 직접 담을 수 있는 원본 크기 (base64 변환 시 약 1.33배 → 요청 20MB 한도 안쪽)
const INLINE_LIMIT = 13 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 240000;
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];

const DIFFICULTY = {
  easy: { label: '쉬움', desc: '핵심 개념과 정의를 정확히 알고 있는지 확인하는 기본 문제', prompt: '쉬움: 교안의 핵심 개념·정의·용어를 그대로 확인하는 기본 문제. 오답 보기는 명확히 틀린 내용으로 구성.' },
  medium: { label: '보통', desc: '개념을 이해하고 서로 구분·비교할 수 있는지 묻는 문제', prompt: '보통: 개념의 이해·비교·구분을 묻는 문제. 오답은 교안의 다른 개념과 헷갈릴 만한 그럴듯한 보기로 구성.' },
  hard: { label: '어려움', desc: '여러 개념을 종합하거나 사례에 적용해야 하는 응용 문제', prompt: '어려움: 여러 개념을 종합하거나 새로운 사례·상황에 적용해야 하는 응용·추론 문제. 오답은 부분적으로만 맞는 매력적인 보기로 구성.' },
};

/* ---------------- 상태 ---------------- */
const state = {
  key: null,
  models: null,          // 순위가 매겨진 모델 목록 [{id, outLimit}]
  files: [],             // File[]
  difficulty: 'medium',
  content: null,         // AI에 보낼 교안 내용(parts) — 문제 재생성에 재사용
  fileNames: [],
  summary: null,
  quiz: null,            // { difficulty, questions[], model }
  quizView: { mode: 'solve', answers: {}, graded: false, subset: null, regenDiff: 'medium', loading: false },
  busy: false,
  lastAction: null,
};

/* ---------------- 유틸 ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+?)`/g, '<code>$1</code>');
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};
const memKey = { value: null }; // localStorage가 막힌 환경 대비

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function fileKind(file) {
  const n = file.name.toLowerCase();
  if (n.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
  if (n.endsWith('.pptx')) return 'pptx';
  if (n.endsWith('.ppt')) return 'ppt';
  return 'other';
}

/* =========================================================
 * Gemini API
 * ========================================================= */
class GeminiError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.kind = kind; // auth | quota | model | server | network | safety | parse | bad
    this.detail = detail || '';
  }
}

async function apiCall(path, key, body, signal) {
  const url = `${API_BASE}/${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
  let res;
  try {
    res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new GeminiError('server', '응답 시간이 너무 오래 걸렸어요.', 'timeout');
    throw new GeminiError('network', '인터넷 연결 또는 Google 서버 접속에 실패했어요.', String(e));
  }
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* 무시 */ }
  if (res.ok) return data;

  const err = data?.error || {};
  const msg = err.message || raw || `HTTP ${res.status}`;
  const reason = (err.details || []).map((d) => d.reason).filter(Boolean).join(',');
  const detail = `HTTP ${res.status} ${err.status || ''} ${reason}\n${msg}`;
  const low = msg.toLowerCase();

  if (/api[_ ]?key/i.test(msg) || /API_KEY/.test(reason) || res.status === 401) {
    throw new GeminiError('auth', 'API 키가 올바르지 않아요. 키를 다시 확인해 주세요.', detail);
  }
  if (res.status === 403) {
    if (/model/i.test(msg)) throw new GeminiError('model', '이 키로는 해당 모델을 쓸 수 없어요.', detail);
    throw new GeminiError('auth', '이 키에 Gemini API 사용 권한이 없어요. (키 제한 설정 또는 API 미사용 설정)', detail);
  }
  if (res.status === 429) throw new GeminiError('quota', '사용량 한도에 도달했어요.', detail);
  if (res.status === 404) throw new GeminiError('model', '모델을 찾을 수 없어요.', detail);
  if (res.status >= 500) throw new GeminiError('server', 'Google AI 서버가 일시적으로 바빠요.', detail);
  if (/location is not supported|user location/i.test(low)) {
    throw new GeminiError('auth', '현재 접속 지역에서는 Gemini API를 사용할 수 없어요.', detail);
  }
  if (res.status === 413 || /too large|exceeds the maximum|payload size/i.test(low)) {
    throw new GeminiError('bad', '파일이 너무 커서 한 번에 보낼 수 없어요.', detail);
  }
  // 그 외 400 오류: 모델별 지원 차이(JSON 모드 등)일 가능성이 높아 다음 모델로 넘김
  throw new GeminiError('model', '이 모델에서 요청을 처리하지 못했어요.', detail);
}

/** 키로 사용 가능한 모델을 조회하고, 품질·속도 기준으로 순위를 매긴다 */
async function listModels(key) {
  const all = [];
  let token = '';
  for (let i = 0; i < 5; i++) {
    const data = await apiCall(`models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, key);
    all.push(...(data?.models || []));
    token = data?.nextPageToken;
    if (!token) break;
  }
  return rankModels(all);
}

function rankModels(models) {
  const EXCLUDE = /(embed|aqa|tts|image|imagen|veo|live|audio|native|robotics|computer-use|learnlm|gemma|nano|banana|vision|thinking-exp|-8b|deep-research|lyria|genie)/i;
  const cands = models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), outLimit: m.outputTokenLimit || 0, inLimit: m.inputTokenLimit || 0 }))
    .filter((m) => /^gemini-/i.test(m.id) && !EXCLUDE.test(m.id))
    .filter((m) => !m.inLimit || m.inLimit >= 30000);

  const ver = (id) => { const v = id.match(/gemini-(\d+(?:\.\d+)?)/i); return v ? parseFloat(v[1]) : 0; };
  const maxVer = Math.max(0, ...cands.map((m) => ver(m.id)));
  const score = (m) => {
    const id = m.id.toLowerCase();
    let v = ver(id);
    if (!v && id.includes('latest')) v = maxVer - 0.05; // gemini-flash-latest 같은 별칭
    let tier = 0;
    if (id.includes('flash-lite')) tier = 1;
    else if (id.includes('flash')) tier = 3;   // 속도·무료 한도 면에서 가장 안정적
    else if (id.includes('pro')) tier = 2;
    let s = v * 10 + tier;
    if (/preview|exp/.test(id)) s -= 1.5;
    if (/-\d{3}$|-\d{2}-\d{4}$|-\d{4}$/.test(id)) s -= 0.2; // 날짜·버전 고정판은 별칭보다 약간 뒤로
    if (/^gemini-1\.0|gemini-pro$/.test(id)) s -= 20;
    return s;
  };
  cands.sort((a, b) => score(b) - score(a));
  const seen = new Set();
  return cands.filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));
}

async function ensureModels() {
  if (state.models?.length) return state.models;
  try {
    const ranked = await listModels(state.key);
    state.models = ranked.length ? ranked : FALLBACK_MODELS.map((id) => ({ id, outLimit: 0 }));
  } catch (e) {
    if (e.kind === 'auth') throw e;
    state.models = FALLBACK_MODELS.map((id) => ({ id, outLimit: 0 }));
  }
  return state.models;
}

function parseJSON(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(t); } catch { /* 계속 */ }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) {
    const sub = t.slice(s, e + 1);
    try { return JSON.parse(sub); } catch { /* 계속 */ }
    try { return JSON.parse(sub.replace(/,\s*([}\]])/g, '$1')); } catch { /* 계속 */ }
  }
  throw new GeminiError('parse', 'AI 응답 형식이 올바르지 않아요.', t.slice(0, 500));
}

/**
 * 모델 자동 전환 + 재시도를 포함한 생성 호출
 * @returns {{data:any, model:string}}
 */
async function generate({ parts, system, json = true, temperature = 0.4, validate, onModel }) {
  const models = await ensureModels();
  const last = store.get(MODEL_STORE);
  const order = [...models];
  const li = order.findIndex((m) => m.id === last);
  if (li > 0) order.unshift(order.splice(li, 1)[0]);
  const tryList = order.slice(0, 7);

  let lastErr = null;
  let quotaHits = 0;
  for (const m of tryList) {
    for (let attempt = 0; attempt < 2; attempt++) {
      onModel?.(m.id);
      const generationConfig = { temperature };
      if (json) generationConfig.responseMimeType = 'application/json';
      if (m.outLimit) generationConfig.maxOutputTokens = Math.min(m.outLimit, 65536);
      const body = {
        contents: [{ role: 'user', parts }],
        generationConfig,
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      try {
        const data = await apiCall(`models/${m.id}:generateContent`, state.key, body, ctrl.signal);
        const cand = data?.candidates?.[0];
        if (!cand) {
          const br = data?.promptFeedback?.blockReason;
          if (br) throw new GeminiError('safety', 'AI가 이 교안 내용의 처리를 거부했어요.', `blockReason: ${br}`);
          throw new GeminiError('parse', 'AI 응답이 비어 있어요.', JSON.stringify(data).slice(0, 300));
        }
        const text = (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
        if (!text.trim()) {
          if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION'].includes(cand.finishReason)) {
            throw new GeminiError('safety', 'AI가 이 교안 내용의 처리를 거부했어요.', `finishReason: ${cand.finishReason}`);
          }
          throw new GeminiError('parse', 'AI 응답이 비어 있어요.', `finishReason: ${cand.finishReason}`);
        }
        const out = json ? parseJSON(text) : text;
        const checked = validate ? validate(out) : out;
        store.set(MODEL_STORE, m.id);
        return { data: checked, model: m.id };
      } catch (e) {
        clearTimeout(timer);
        const err = e instanceof GeminiError ? e : new GeminiError('parse', e.message || 'AI 응답을 처리하지 못했어요.', String(e));
        lastErr = err;
        if (err.kind === 'auth' || err.kind === 'network' || err.kind === 'bad') throw err;
        if (err.kind === 'quota') { quotaHits++; break; }          // 다음 모델로
        if (err.kind === 'model') break;                            // 다음 모델로
        if (err.kind === 'safety') break;                           // 다른 모델은 허용할 수도 있음
        if (attempt === 0) { await sleep(1200); continue; }        // server/parse → 같은 모델 1회 재시도
        break;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  if (quotaHits && lastErr?.kind === 'quota') {
    throw new GeminiError('quota', '이 API 키의 사용량 한도(무료 한도 포함)에 도달했어요. 1~2분 뒤 다시 시도하거나 다른 키를 사용해 주세요.', lastErr.detail);
  }
  throw lastErr || new GeminiError('server', 'AI 응답을 받지 못했어요.');
}

/* =========================================================
 * 파일 준비 (PDF 분할 · PPTX 추출)
 * ========================================================= */

/** 파일들을 AI에 보낼 수 있는 단위(unit)로 변환. unit = { label, parts[], bytes } */
async function prepareUnits(files, onStatus) {
  const units = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const kind = fileKind(f);
    onStatus?.(`${f.name} 읽는 중 (${i + 1}/${files.length})`);
    if (kind === 'pdf') units.push(...(await pdfUnits(f)));
    else if (kind === 'pptx') units.push(...(await pptxUnits(f, onStatus)));
  }
  if (!units.length) throw new GeminiError('bad', '파일에서 읽을 수 있는 내용을 찾지 못했어요.');
  return units;
}

async function pdfUnits(file) {
  if (file.size <= INLINE_LIMIT) {
    return [{
      label: file.name,
      bytes: file.size,
      parts: [
        { text: `\n[첨부 교안: ${file.name} (PDF) — 출처 표기는 이 PDF의 쪽 번호 기준]` },
        { inlineData: { mimeType: 'application/pdf', data: await blobToBase64(file) } },
      ],
    }];
  }
  // 큰 PDF → 쪽 단위로 나눠서 여러 조각으로 만든다
  if (!window.PDFLib) throw new GeminiError('bad', 'PDF 처리 도구를 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.');
  const { PDFDocument } = window.PDFLib;
  let src;
  try {
    src = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
  } catch (e) {
    throw new GeminiError('bad', `"${file.name}" PDF를 열 수 없어요. (암호가 걸려 있거나 손상된 파일일 수 있어요)`, String(e));
  }
  const total = src.getPageCount();
  const perPage = file.size / Math.max(1, total);
  let step = Math.max(1, Math.floor((INLINE_LIMIT * 0.85) / perPage));
  const units = [];
  let start = 0;
  let skipped = 0;
  while (start < total) {
    const end = Math.min(total, start + step);
    const doc = await PDFDocument.create();
    const pages = await doc.copyPages(src, Array.from({ length: end - start }, (_, k) => start + k));
    pages.forEach((p) => doc.addPage(p));
    const bytes = await doc.save({ useObjectStreams: true });
    if (bytes.length > INLINE_LIMIT && end - start > 1) { step = Math.max(1, Math.floor((end - start) / 2)); continue; }
    if (bytes.length > INLINE_LIMIT) { skipped++; start = end; continue; }
    units.push({
      label: `${file.name} ${start + 1}~${end}쪽`,
      bytes: bytes.length,
      parts: [
        { text: `\n[첨부 교안: ${file.name} — 원본 ${start + 1}~${end}쪽 부분. 이 조각의 1쪽 = 원본 ${start + 1}쪽. 출처는 원본 쪽 번호로 표기]` },
        { inlineData: { mimeType: 'application/pdf', data: await blobToBase64(new Blob([bytes], { type: 'application/pdf' })) } },
      ],
    });
    start = end;
  }
  if (!units.length) throw new GeminiError('bad', `"${file.name}"의 페이지가 너무 커서 처리할 수 없어요.`);
  if (skipped) toast(`용량이 너무 큰 ${skipped}개 쪽은 건너뛰었어요.`);
  return units;
}

async function downscaleImage(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const max = 1024;
    const r = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (bmp.width < 60 || bmp.height < 60) return null; // 아이콘 수준 이미지 제외
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * r);
    c.height = Math.round(bmp.height * r);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const out = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.72));
    return out;
  } catch {
    return null; // EMF/WMF 등 브라우저가 못 읽는 형식은 건너뜀
  }
}

function xmlText(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const paras = [...doc.getElementsByTagName('a:p')];
  const lines = paras.map((p) => [...p.getElementsByTagName('a:t')].map((t) => t.textContent).join('')).map((s) => s.trim()).filter(Boolean);
  return { doc, text: lines.join('\n') };
}

function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

async function readRels(zip, partPath) {
  const dir = partPath.split('/').slice(0, -1).join('/');
  const name = partPath.split('/').pop();
  const relFile = zip.file(`${dir}/_rels/${name}.rels`);
  if (!relFile) return [];
  const doc = new DOMParser().parseFromString(await relFile.async('string'), 'application/xml');
  return [...doc.getElementsByTagName('Relationship')].map((r) => ({
    id: r.getAttribute('Id'),
    type: r.getAttribute('Type') || '',
    target: r.getAttribute('Target') || '',
    external: r.getAttribute('TargetMode') === 'External',
  }));
}

async function pptxUnits(file, onStatus) {
  if (!window.JSZip) throw new GeminiError('bad', 'PPT 처리 도구를 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.');
  let zip;
  try { zip = await window.JSZip.loadAsync(await file.arrayBuffer()); } catch (e) {
    throw new GeminiError('bad', `"${file.name}" PPT 파일을 열 수 없어요. 손상되었거나 암호가 걸려 있을 수 있어요.`, String(e));
  }
  // 슬라이드 순서: presentation.xml 기준
  let slidePaths = [];
  const presFile = zip.file('ppt/presentation.xml');
  if (presFile) {
    const rels = await readRels(zip, 'ppt/presentation.xml');
    const pres = new DOMParser().parseFromString(await presFile.async('string'), 'application/xml');
    const ids = [...pres.getElementsByTagName('p:sldId')].map((n) => n.getAttribute('r:id'));
    slidePaths = ids.map((id) => rels.find((r) => r.id === id)).filter(Boolean).map((r) => resolvePath('ppt/presentation.xml', r.target));
  }
  if (!slidePaths.length) {
    slidePaths = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  }
  if (!slidePaths.length) throw new GeminiError('bad', `"${file.name}"에서 슬라이드를 찾지 못했어요.`);

  const usedMedia = new Set();
  const units = [];
  let cur = { label: '', bytes: 0, parts: [], from: 1, to: 1 };
  let imgCount = 0;
  const flush = () => {
    if (!cur.parts.length) return;
    cur.label = `${file.name} 슬라이드 ${cur.from}~${cur.to}`;
    cur.parts.unshift({ text: `\n[첨부 교안: ${file.name} (PPT) 슬라이드 ${cur.from}~${cur.to} — 출처는 "슬라이드 N"으로 표기]` });
    units.push(cur);
  };

  for (let i = 0; i < slidePaths.length; i++) {
    const sp = slidePaths[i];
    const sf = zip.file(sp);
    if (!sf) continue;
    if (i % 5 === 0) onStatus?.(`${file.name} 슬라이드 읽는 중 (${i + 1}/${slidePaths.length})`);
    const { text } = xmlText(await sf.async('string'));
    const rels = await readRels(zip, sp);

    let notes = '';
    const noteRel = rels.find((r) => r.type.endsWith('/notesSlide'));
    if (noteRel) {
      const nf = zip.file(resolvePath(sp, noteRel.target));
      if (nf) notes = xmlText(await nf.async('string')).text.replace(/^\d+$/gm, '').trim();
    }

    const slideParts = [{ text: `\n--- 슬라이드 ${i + 1} ---\n${text || '(글자 없음)'}${notes ? `\n[발표자 노트] ${notes}` : ''}` }];
    let slideBytes = slideParts[0].text.length * 3;

    const imgRels = rels.filter((r) => r.type.endsWith('/image') && !r.external);
    for (const r of imgRels) {
      if (imgCount >= 80) break;
      const mp = resolvePath(sp, r.target);
      if (usedMedia.has(mp)) continue; // 반복 로고 등 중복 제외
      usedMedia.add(mp);
      const mf = zip.file(mp);
      if (!mf) continue;
      const raw = await mf.async('blob');
      if (raw.size < 6000) continue;
      const small = await downscaleImage(raw);
      if (!small) continue;
      const data = await blobToBase64(small);
      slideParts.push({ text: `(슬라이드 ${i + 1}의 그림)` }, { inlineData: { mimeType: 'image/jpeg', data } });
      slideBytes += small.size;
      imgCount++;
    }

    if (cur.parts.length && cur.bytes + slideBytes > INLINE_LIMIT) {
      flush();
      cur = { label: '', bytes: 0, parts: [], from: i + 1, to: i + 1 };
    }
    if (!cur.parts.length) cur.from = i + 1;
    cur.parts.push(...slideParts);
    cur.bytes += slideBytes;
    cur.to = i + 1;
  }
  flush();
  return units;
}

/* =========================================================
 * 프롬프트
 * ========================================================= */
const SYSTEM = `당신은 대학·자격증 교육 전문 교수이자 시험 출제위원입니다.
사용자가 첨부한 교안(PDF/PPT)만을 근거로 작업합니다. 교안에 없는 내용을 지어내지 마세요.
모든 출력은 반드시 한국어로 작성하세요. 전문 용어는 필요하면 괄호 안에 원어를 함께 적습니다. (예: 정규화(Normalization))
교안의 분야(과목)를 스스로 판단하여 그 분야의 시험 관점에서 중요한 내용을 골라냅니다.`;

function summaryPrompt() {
  return `첨부된 교안 전체를 읽고, 학생이 시험 공부에 바로 쓸 수 있는 "요약 노트"를 만들어 주세요.

[작성 원칙]
- 교안의 흐름(단원·목차)을 따라 빠짐없이 정리하세요. 교안 분량에 비례해 sections는 4~14개로 나눕니다.
- 각 section의 points는 3~7개. 한 항목은 1~2문장의 완결된 설명으로 쓰고, 핵심 키워드는 **굵게** 표시하세요.
- 수식·공식·절차·비교 기준이 있으면 반드시 포함하세요.
- source는 해당 내용이 있는 위치입니다. PDF는 "p.3~5", PPT는 "슬라이드 4~6" 형식.
- keyTerms는 시험에 나올 핵심 용어 6~14개.
- examPoints는 "이 부분이 시험에 나올 가능성이 높다"는 포인트 4~8개.

[출력: 아래 JSON 형식만 출력]
{
  "field": "교안의 분야 (예: 컴퓨터공학 > 데이터베이스)",
  "title": "교안 제목 (교안에 없으면 내용에 맞게 지음)",
  "oneLine": "교안 전체를 한 문장으로 요약",
  "overview": "교안 전체 개요 3~5문장",
  "sections": [
    { "title": "단원/주제명", "source": "p.3~5", "summary": "이 단원의 요지 1~2문장", "points": ["핵심 내용", "..."] }
  ],
  "keyTerms": [ { "term": "용어", "definition": "정의 1~2문장" } ],
  "examPoints": ["시험 포인트", "..."]
}`;
}

function quizPrompt(difficulty, avoid = []) {
  const d = DIFFICULTY[difficulty] || DIFFICULTY.medium;
  return `첨부된 교안 내용만을 근거로 객관식 4지선다 예상문제를 정확히 10개 출제해 주세요.

[난이도] ${d.prompt}

[출제 원칙]
- 교안 전체 범위에서 고르게 출제하고, 같은 개념을 중복 출제하지 마세요.
- 보기는 정확히 4개. 정답은 반드시 1개뿐이어야 하며, 보기 길이·형식을 비슷하게 맞추세요.
- "모두 정답", "정답 없음" 같은 보기는 쓰지 마세요.
- 보기 텍스트 앞에 ①, 1), A. 같은 번호를 붙이지 마세요.
- explanation: 정답인 이유를 교안 내용을 근거로 2~3문장으로 설명.
- wrongReasons: 4개 보기 각각에 대한 설명 배열 (choices와 같은 순서). 정답 보기는 "정답", 오답 보기는 왜 틀렸는지 1문장.
- source: 문제의 근거 위치와 단원명. PDF는 "p.12 · 단원명", PPT는 "슬라이드 7 · 단원명" 형식.
- answer: 정답 보기의 번호 (1~4).${avoid.length ? `\n- 아래 기존 문제와 겹치지 않는 새로운 문제를 내세요:\n${avoid.map((q, i) => `  ${i + 1}. ${q}`).join('\n')}` : ''}

[출력: 아래 JSON 형식만 출력]
{
  "questions": [
    {
      "question": "문제",
      "choices": ["보기1", "보기2", "보기3", "보기4"],
      "answer": 2,
      "explanation": "정답 해설",
      "wrongReasons": ["오답 이유", "정답", "오답 이유", "오답 이유"],
      "source": "p.12 · 단원명"
    }
  ]
}`;
}

const NOTES_PROMPT = `첨부된 교안 조각의 내용을 빠짐없이 상세한 학습 노트로 옮겨 적어 주세요.
- 이후 이 노트만으로 요약과 시험 문제를 만들 것이므로 정의, 개념, 수식, 절차, 예시, 비교, 표·그림의 핵심 정보를 모두 포함하세요.
- 각 항목 앞에 위치를 표기하세요. PDF는 [p.원본쪽번호], PPT는 [슬라이드 N].
- 한국어로 작성하고, 일반 텍스트(마크다운 목록)로만 출력하세요.`;

/* ---------------- 응답 검증 ---------------- */
function validateSummary(o) {
  if (!o || typeof o !== 'object') throw new GeminiError('parse', '요약 형식 오류');
  const sections = Array.isArray(o.sections) ? o.sections.filter((s) => s && (s.title || s.points)) : [];
  if (!sections.length) throw new GeminiError('parse', '요약 내용이 비어 있어요.');
  return {
    field: String(o.field || '').trim(),
    title: String(o.title || '').trim() || '교안 요약 노트',
    oneLine: String(o.oneLine || '').trim(),
    overview: String(o.overview || '').trim(),
    sections: sections.map((s) => ({
      title: String(s.title || '').trim(),
      source: String(s.source || '').trim(),
      summary: String(s.summary || '').trim(),
      points: (Array.isArray(s.points) ? s.points : [s.points]).filter(Boolean).map(String),
    })),
    keyTerms: (Array.isArray(o.keyTerms) ? o.keyTerms : []).filter((t) => t && t.term).map((t) => ({ term: String(t.term), definition: String(t.definition || '') })),
    examPoints: (Array.isArray(o.examPoints) ? o.examPoints : []).filter(Boolean).map(String),
  };
}

function stripNum(s) {
  return String(s ?? '').replace(/^\s*(?:[①②③④]|\(?[1-4A-Da-d][).]|[1-4]\s*번[.)]?)\s*/, '').trim();
}

function validateQuiz(o) {
  const arr = Array.isArray(o) ? o : Array.isArray(o?.questions) ? o.questions : [];
  const zeroBased = arr.some((q) => Number(q?.answer) === 0);
  const qs = [];
  for (const q of arr) {
    if (!q || !q.question || !Array.isArray(q.choices) || q.choices.length < 4) continue;
    const choices = q.choices.slice(0, 4).map(stripNum);
    let ans = Number(q.answer);
    if (!Number.isFinite(ans)) {
      const idx = choices.findIndex((c) => stripNum(q.answer) === c);
      ans = idx >= 0 ? idx + 1 : NaN;
    } else if (zeroBased) ans += 1;
    if (!(ans >= 1 && ans <= 4)) continue;
    const wr = Array.isArray(q.wrongReasons) ? q.wrongReasons.slice(0, 4).map((x) => String(x ?? '')) : [];
    while (wr.length < 4) wr.push('');
    qs.push({
      question: String(q.question).trim(),
      choices,
      answer: ans - 1, // 내부적으로 0~3
      explanation: String(q.explanation || '').trim(),
      wrongReasons: wr,
      source: String(q.source || '').trim(),
    });
  }
  if (qs.length < 10) throw new GeminiError('parse', `문제가 ${qs.length}개만 생성되었어요.`);
  return qs.slice(0, 10).map(shuffleChoices);
}

/** 보기 순서를 섞어 정답 위치가 한쪽으로 몰리지 않게 한다 */
function shuffleChoices(q) {
  const idx = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return {
    ...q,
    choices: idx.map((i) => q.choices[i]),
    wrongReasons: idx.map((i) => q.wrongReasons[i]),
    answer: idx.indexOf(q.answer),
  };
}

/* =========================================================
 * 진행 상황 UI
 * ========================================================= */
const progress = {
  timer: null,
  start: 0,
  steps: [],
  init(defs) {
    this.steps = defs.map((d) => ({ ...d, status: 'wait', sub: '' }));
    this.start = Date.now();
    clearInterval(this.timer);
    this.timer = setInterval(() => { $('#elapsed').textContent = `${Math.floor((Date.now() - this.start) / 1000)}초`; }, 500);
    $('#elapsed').textContent = '0초';
    this.render();
  },
  set(id, status, sub) {
    const s = this.steps.find((x) => x.id === id);
    if (!s) return;
    if (status) s.status = status;
    if (sub !== undefined) s.sub = sub;
    this.render();
  },
  stop() { clearInterval(this.timer); },
  render() {
    $('#steps').innerHTML = this.steps.map((s) => `
      <li class="${s.status}"><span class="ico"></span><span>${esc(s.label)}${s.sub ? `<span class="sub">${esc(s.sub)}</span>` : ''}</span></li>`).join('');
  },
};

/* =========================================================
 * 메인 흐름
 * ========================================================= */
function show(id, on = true) { $(id).hidden = !on; }

async function analyze() {
  if (state.busy) return;
  if (!state.key) { openKeyCard(); return; }
  if (!state.files.length) return;
  state.busy = true;
  state.lastAction = analyze;
  show('#uploadCard', false); show('#errorCard', false); show('#resultSection', false); show('#hero', false);
  show('#progressCard', true);
  window.scrollTo({ top: 0, behavior: 'smooth' });

  progress.init([
    { id: 'read', label: '교안 파일 읽기' },
    { id: 'model', label: 'Gemini AI 연결' },
    { id: 'big', label: '교안 내용 분석' },
    { id: 'summary', label: '요약 노트 작성' },
    { id: 'quiz', label: `예상문제 10개 출제 (난이도: ${DIFFICULTY[state.difficulty].label})` },
  ]);

  try {
    progress.set('read', 'run');
    const units = await prepareUnits(state.files, (m) => progress.set('read', null, m));
    const totalBytes = units.reduce((a, u) => a + u.bytes, 0);
    progress.set('read', 'done', `${state.files.length}개 파일 · ${fmtSize(totalBytes)} 전송 준비 완료`);

    progress.set('model', 'run', '사용 가능한 모델 확인 중');
    const models = await ensureModels();
    progress.set('model', 'done', `연결됨 · 우선 모델 ${models[0]?.id || '-'}`);

    // 용량이 작으면 한 번에, 크면 조각별로 노트를 만든 뒤 합친다
    let content;
    if (totalBytes <= INLINE_LIMIT) {
      content = units.flatMap((u) => u.parts);
      progress.set('big', 'done', '교안 전체를 한 번에 분석합니다');
    } else {
      const batches = [];
      let cur = [];
      let size = 0;
      for (const u of units) {
        if (cur.length && size + u.bytes > INLINE_LIMIT) { batches.push(cur); cur = []; size = 0; }
        cur.push(u); size += u.bytes;
      }
      if (cur.length) batches.push(cur);
      const notes = [];
      for (let i = 0; i < batches.length; i++) {
        const labels = batches[i].map((u) => u.label).join(', ');
        progress.set('big', 'run', `대용량 교안을 나눠 읽는 중 (${i + 1}/${batches.length}) · ${labels}`);
        const { data } = await generate({
          parts: [...batches[i].flatMap((u) => u.parts), { text: NOTES_PROMPT }],
          system: SYSTEM, json: false, temperature: 0.2,
        });
        notes.push(`## ${labels}\n${data}`);
      }
      content = [{ text: `[첨부 교안 상세 노트 — 원본 교안: ${state.files.map((f) => f.name).join(', ')}]\n\n${notes.join('\n\n')}` }];
      progress.set('big', 'done', `${batches.length}개 조각으로 나눠 분석 완료`);
    }
    state.content = content;
    state.fileNames = state.files.map((f) => f.name);

    progress.set('summary', 'run', 'AI가 요약 중…');
    progress.set('quiz', 'run', 'AI가 출제 중…');
    const sumP = generate({
      parts: [...content, { text: summaryPrompt() }], system: SYSTEM, temperature: 0.3, validate: validateSummary,
      onModel: (m) => progress.set('summary', null, `${m} 모델로 작성 중…`),
    }).then((r) => { progress.set('summary', 'done', `완료 · ${r.model}`); return r; });
    const quizP = generate({
      parts: [...content, { text: quizPrompt(state.difficulty) }], system: SYSTEM, temperature: 0.6, validate: validateQuiz,
      onModel: (m) => progress.set('quiz', null, `${m} 모델로 출제 중…`),
    }).then((r) => { progress.set('quiz', 'done', `완료 · ${r.model}`); return r; });

    const [sum, quiz] = await Promise.all([sumP, quizP]);
    state.summary = sum.data;
    state.summaryModel = sum.model;
    state.quiz = { difficulty: state.difficulty, questions: quiz.data, model: quiz.model };
    resetQuizView();
    state.quizView.regenDiff = state.difficulty;
    progress.stop();
    show('#progressCard', false);
    renderResult();
  } catch (e) {
    progress.stop();
    showError(e);
  } finally {
    state.busy = false;
  }
}

async function regenerateQuiz() {
  if (state.quizView.loading || !state.content) return;
  const diff = state.quizView.regenDiff;
  state.quizView.loading = true;
  renderQuiz();
  try {
    const avoid = state.quiz?.questions.map((q) => q.question) || [];
    const r = await generate({
      parts: [...state.content, { text: quizPrompt(diff, avoid) }], system: SYSTEM, temperature: 0.8, validate: validateQuiz,
    });
    state.quiz = { difficulty: diff, questions: r.data, model: r.model };
    resetQuizView();
    state.quizView.regenDiff = diff;
    toast(`새 예상문제 10개를 만들었어요 (${DIFFICULTY[diff].label})`);
  } catch (e) {
    state.quizView.loading = false;
    renderQuiz();
    toast(friendly(e).msg);
    return;
  }
  state.quizView.loading = false;
  renderQuiz();
  $('#tab-quiz').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function friendly(e) {
  const kind = e?.kind || 'unknown';
  const map = {
    auth: { title: 'API 키를 확인해 주세요', msg: e.message, key: true },
    quota: { title: '사용량 한도에 도달했어요', msg: e.message, key: true },
    network: { title: '네트워크 연결 문제', msg: '인터넷 연결을 확인한 뒤 다시 시도해 주세요.' },
    safety: { title: 'AI가 처리를 거부했어요', msg: '교안 내용 중 일부가 AI 안전 정책에 걸렸어요. 다른 교안으로 시도해 주세요.' },
    parse: { title: 'AI 응답이 불완전했어요', msg: '일시적인 문제일 수 있어요. 다시 시도해 주세요.' },
    bad: { title: '파일을 처리할 수 없어요', msg: e.message },
    model: { title: '사용 가능한 AI 모델이 없어요', msg: '이 API 키로 사용할 수 있는 Gemini 모델을 찾지 못했어요. 다른 키를 사용해 보세요.', key: true },
    server: { title: 'AI 서버가 바빠요', msg: 'Google AI 서버가 일시적으로 응답하지 않아요. 잠시 후 다시 시도해 주세요.' },
  };
  return map[kind] || { title: '문제가 생겼어요', msg: e?.message || '알 수 없는 오류가 발생했어요.' };
}

function showError(e) {
  console.error(e);
  const f = friendly(e);
  show('#progressCard', false);
  $('#errorTitle').textContent = f.title;
  $('#errorMsg').textContent = f.msg;
  $('#errorDetail').textContent = e?.detail || String(e?.stack || e);
  $('#errorDetailWrap').hidden = !e?.detail && !e?.stack;
  $('#errorKeyBtn').hidden = !f.key;
  show('#errorCard', true);
  show('#uploadCard', true);
}

/* =========================================================
 * 결과 렌더링
 * ========================================================= */
function renderResult() {
  const s = state.summary;
  $('#metaChips').innerHTML = [
    s.field ? `<span class="chip field">📚 ${esc(s.field)}</span>` : '',
    `<span class="chip">📄 ${esc(state.fileNames.length > 1 ? `${state.fileNames[0]} 외 ${state.fileNames.length - 1}개` : state.fileNames[0])}</span>`,
    `<span class="chip">🤖 ${esc(state.summaryModel)}</span>`,
  ].join('');
  $('#docTitle').textContent = s.title;
  $('#oneLine').textContent = s.oneLine;
  $('#oneLine').hidden = !s.oneLine;
  renderSummary();
  renderQuiz();
  switchTab('summary');
  show('#uploadCard', false);
  show('#resultSection', true);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderSummary() {
  const s = state.summary;
  const html = [];
  html.push(`<section class="card"><h3 class="sec-title">🧭 전체 개요</h3><p class="overview">${md(s.overview)}</p>
    <nav class="toc">${s.sections.map((x, i) => `<a href="#unit-${i}">${i + 1}. ${esc(x.title)}</a>`).join('')}</nav></section>`);

  html.push(`<section class="card"><h3 class="sec-title">📒 단원별 핵심 정리 <span class="muted small">(${s.sections.length}개 단원)</span></h3>
    ${s.sections.map((x, i) => `
      <details class="unit" id="unit-${i}" ${i < 3 ? 'open' : ''}>
        <summary><span class="unit-no">${i + 1}</span><span class="unit-title">${esc(x.title)}</span>${x.source ? `<span class="unit-src">${esc(x.source)}</span>` : ''}</summary>
        <div class="unit-body">
          ${x.summary ? `<p>${md(x.summary)}</p>` : ''}
          <ul>${x.points.map((p) => `<li>${md(p)}</li>`).join('')}</ul>
        </div>
      </details>`).join('')}
    <div class="row-btns"><button class="btn" type="button" data-units="open">모두 펼치기</button><button class="btn" type="button" data-units="close">모두 접기</button></div>
  </section>`);

  if (s.keyTerms.length) {
    html.push(`<section class="card"><h3 class="sec-title">🔑 핵심 용어</h3><div class="terms">
      ${s.keyTerms.map((t) => `<div class="term"><b>${esc(t.term)}</b><span>${md(t.definition)}</span></div>`).join('')}</div></section>`);
  }
  if (s.examPoints.length) {
    html.push(`<section class="card"><h3 class="sec-title">🎯 시험에 나올 포인트</h3><ul class="exam-points">
      ${s.examPoints.map((p) => `<li><span>${md(p)}</span></li>`).join('')}</ul></section>`);
  }
  html.push(`<section class="card" style="text-align:center"><p style="margin:0 0 12px;font-weight:700">요약을 다 읽었다면 실력을 확인해 보세요</p>
    <button class="btn primary" type="button" data-goto="quiz">📝 예상문제 10개 풀러 가기</button></section>`);
  $('#tab-summary').innerHTML = html.join('');
}

function resetQuizView() {
  const keepMode = state.quizView?.mode || 'solve';
  state.quizView = { ...state.quizView, mode: keepMode, answers: {}, graded: false, subset: null, loading: false };
}

function renderQuiz() {
  const qz = state.quiz;
  const v = state.quizView;
  if (!qz) return;
  const list = v.subset || qz.questions.map((_, i) => i);
  const review = v.mode === 'review';
  const answered = list.filter((i) => v.answers[i] !== undefined).length;
  const correct = list.filter((i) => v.answers[i] === qz.questions[i].answer).length;
  const wrongIdx = list.filter((i) => v.answers[i] !== qz.questions[i].answer);

  const html = [];
  html.push(`<section class="card"><div class="quiz-bar">
      <div><strong>객관식 4지선다 · ${qz.questions.length}문제</strong> <span class="chip">난이도 ${esc(DIFFICULTY[qz.difficulty].label)}</span>${v.subset ? ' <span class="chip field">틀린 문제 다시 풀기</span>' : ''}</div>
      <div class="seg" role="tablist" aria-label="보기 방식">
        <button type="button" data-mode="solve" class="${!review ? 'on' : ''}">✍️ 풀이 모드</button>
        <button type="button" data-mode="review" class="${review ? 'on' : ''}">✅ 정답·해설 보기</button>
      </div>
    </div></section>`);

  if (!review && v.graded) {
    const total = list.length;
    const pct = Math.round((correct / total) * 100);
    const msg = pct === 100 ? '완벽해요! 모든 문제를 맞혔어요 🎉' : pct >= 80 ? '아주 좋아요! 틀린 문제의 해설만 확인해 보세요.' : pct >= 50 ? '절반 이상 맞혔어요. 해설과 요약 노트를 다시 보면 금방 올라가요.' : '요약 노트를 한 번 더 읽고 다시 도전해 보세요!';
    html.push(`<section class="card"><div class="score-banner">
        <div class="score-num">${correct}<small> / ${total}</small></div>
        <div class="score-msg"><strong>${pct}점</strong><br />${msg}</div>
      </div>
      <div class="row-btns">
        <button class="btn" type="button" data-act="retry">↺ 처음부터 다시 풀기</button>
        ${wrongIdx.length ? `<button class="btn primary" type="button" data-act="wrong">✗ 틀린 문제만 다시 풀기 (${wrongIdx.length})</button>` : ''}
      </div></section>`);
  }

  list.forEach((qi, n) => {
    const q = qz.questions[qi];
    const pick = v.answers[qi];
    const showAns = review || v.graded;
    const isOk = pick === q.answer;
    const cls = !review && v.graded ? (isOk ? 'correct' : 'wrong') : '';
    html.push(`<article class="q ${cls}">
      <div class="q-head"><span class="q-no">Q${v.subset ? n + 1 : qi + 1}</span>
        <div class="q-text">${md(q.question)}${!review && v.graded ? (isOk ? '<span class="q-tag ok">정답</span>' : `<span class="q-tag no">${pick === undefined ? '미응답' : '오답'}</span>`) : ''}</div></div>
      <div class="choices">
        ${q.choices.map((c, ci) => {
          const c2 = [];
          if (!review && pick === ci && !v.graded) c2.push('sel');
          if (showAns && ci === q.answer) c2.push('is-answer');
          if (!review && v.graded && pick === ci && ci !== q.answer) c2.push('is-wrong-pick');
          return `<button type="button" class="choice ${c2.join(' ')}" data-q="${qi}" data-c="${ci}" ${showAns ? 'disabled' : ''}><span class="cn">${ci + 1}</span><span>${md(c)}</span></button>`;
        }).join('')}
      </div>
      ${showAns ? `<div class="explain">
          <div class="ans">정답 ${q.answer + 1}번${!review && pick !== undefined && !isOk ? ` <span class="muted" style="font-weight:600">· 내가 고른 답 ${pick + 1}번</span>` : ''}</div>
          <p>${md(q.explanation)}</p>
          <ul class="wr">${q.wrongReasons.map((w, wi) => (wi === q.answer || !w ? '' : `<li><b>${wi + 1}번 ✗</b> ${md(w)}</li>`)).join('')}</ul>
          ${q.source ? `<div class="src">📍 출제 근거: <b>${esc(q.source)}</b></div>` : ''}
        </div>` : ''}
    </article>`);
  });

  if (!review && !v.graded) {
    html.push(`<div class="quiz-footer"><button class="btn primary big" type="button" data-act="grade" style="max-width:420px">채점하기 (${answered}/${list.length} 응답)</button></div>`);
  }

  html.push(`<section class="card"><div class="regen">
      <p>🔄 같은 교안으로 새 문제 10개 만들기</p>
      <div class="regen-row">
        ${v.loading ? '<span class="loading-inline"><span class="spinner"></span>새 문제를 출제하는 중…</span>' : `
        <div class="seg" id="regenSeg">${Object.entries(DIFFICULTY).map(([k, d]) => `<button type="button" data-regen="${k}" class="${v.regenDiff === k ? 'on' : ''}">${d.label}</button>`).join('')}</div>
        <button class="btn primary" type="button" data-act="regen">새 문제 만들기</button>`}
      </div>
    </div></section>`);

  $('#tab-quiz').innerHTML = html.join('');
}

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  $('#tab-summary').hidden = name !== 'summary';
  $('#tab-quiz').hidden = name !== 'quiz';
}

/* =========================================================
 * API 키 관리
 * ========================================================= */
function loadKey() {
  state.key = store.get(KEY_STORE) || memKey.value || null;
  refreshKeyUI();
}

function refreshKeyUI() {
  const has = !!state.key;
  $('#keyChip').hidden = !has;
  $('#keyCard').hidden = has;
  $('#uploadStep').textContent = has ? 'STEP 1' : 'STEP 2';
  updateAnalyzeBtn();
}

function openKeyCard(fromChange = false) {
  $('#keyCard').hidden = false;
  $('#keyCancelWrap').hidden = !(fromChange && state.key);
  $('#keyInput').value = '';
  $('#keyMsg').textContent = '';
  $('#keyCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => $('#keyInput').focus(), 300);
}

async function saveKey(ev) {
  ev.preventDefault();
  const raw = $('#keyInput').value.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
  const msg = $('#keyMsg');
  msg.className = 'form-msg';
  if (!raw) { msg.textContent = 'API 키를 입력해 주세요.'; msg.classList.add('err'); return; }
  const btn = $('#keySave');
  btn.disabled = true;
  btn.textContent = '확인 중…';
  try {
    const ranked = await listModels(raw);
    state.models = ranked.length ? ranked : FALLBACK_MODELS.map((id) => ({ id, outLimit: 0 }));
    commitKey(raw);
    msg.textContent = '';
    toast(`API 키가 저장되었어요 · 사용 가능한 모델 ${ranked.length}개`);
  } catch (e) {
    if (e.kind === 'auth') {
      msg.textContent = e.message;
      msg.classList.add('err');
    } else {
      // 네트워크 등 일시 문제: 키는 저장하고 실제 분석 시 다시 확인
      state.models = null;
      commitKey(raw);
      toast('API 키를 저장했어요 (연결 확인은 분석할 때 다시 시도해요)');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '키 확인 후 저장';
  }
}

function commitKey(k) {
  state.key = k;
  if (!store.set(KEY_STORE, k)) memKey.value = k;
  store.del(MODEL_STORE);
  refreshKeyUI();
}

function deleteKey() {
  store.del(KEY_STORE); store.del(MODEL_STORE);
  memKey.value = null;
  state.key = null;
  state.models = null;
  refreshKeyUI();
  toast('저장된 API 키를 삭제했어요');
}

function openKeyDialog() {
  const k = state.key || '';
  $('#keyMasked').textContent = k.length > 10 ? `${k.slice(0, 6)}••••••${k.slice(-4)}` : '••••';
  $('#keyModelInfo').textContent = state.models?.length ? `우선 사용 모델: ${state.models.slice(0, 3).map((m) => m.id).join(', ')}` : '';
  const dlg = $('#keyDialog');
  if (dlg.showModal) dlg.showModal(); else if (confirm('저장된 API 키를 삭제할까요?')) deleteKey();
}

/* =========================================================
 * 파일 선택
 * ========================================================= */
function addFiles(list) {
  const msg = $('#fileMsg');
  msg.className = 'form-msg';
  msg.textContent = '';
  const errs = [];
  for (const f of list) {
    const kind = fileKind(f);
    if (kind === 'ppt') { errs.push(`"${f.name}": 옛날 PPT(.ppt) 형식은 지원하지 않아요. PowerPoint에서 .pptx 또는 PDF로 저장해 올려 주세요.`); continue; }
    if (kind === 'other') { errs.push(`"${f.name}": PDF 또는 PPTX 파일만 올릴 수 있어요.`); continue; }
    if (state.files.some((x) => x.name === f.name && x.size === f.size)) continue;
    if (state.files.length >= MAX_FILES) { errs.push(`파일은 최대 ${MAX_FILES}개까지 올릴 수 있어요.`); break; }
    const total = state.files.reduce((a, x) => a + x.size, 0) + f.size;
    if (total > MAX_TOTAL_BYTES) { errs.push(`"${f.name}": 파일 합계가 100MB를 넘어요.`); continue; }
    if (f.size === 0) { errs.push(`"${f.name}": 빈 파일이에요.`); continue; }
    state.files.push(f);
  }
  if (errs.length) { msg.textContent = errs.join(' '); msg.classList.add('err'); }
  renderFiles();
}

function renderFiles() {
  $('#fileList').innerHTML = state.files.map((f, i) => {
    const k = fileKind(f);
    return `<li><span class="ftype ${k}">${k.toUpperCase()}</span><span class="fname" title="${esc(f.name)}">${esc(f.name)}</span><span class="fsize">${fmtSize(f.size)}</span><button class="fremove" type="button" data-rm="${i}" aria-label="삭제">×</button></li>`;
  }).join('');
  updateAnalyzeBtn();
}

function updateAnalyzeBtn() {
  const btn = $('#analyzeBtn');
  const hint = $('#analyzeHint');
  btn.disabled = !state.key || !state.files.length || state.busy;
  if (!state.key) hint.innerHTML = '위에서 Gemini API 키를 먼저 저장해 주세요.';
  else if (!state.files.length) hint.textContent = '교안 파일을 첨부해 주세요.';
  else hint.textContent = `파일 ${state.files.length}개 · 요약 노트와 ${DIFFICULTY[state.difficulty].label} 난이도 문제 10개를 만듭니다.`;
}

function setDifficulty(d) {
  state.difficulty = d;
  $$('#diffSeg button').forEach((b) => { b.classList.toggle('on', b.dataset.diff === d); b.setAttribute('aria-checked', b.dataset.diff === d); });
  $('#diffDesc').textContent = `${DIFFICULTY[d].label}: ${DIFFICULTY[d].desc}`;
  updateAnalyzeBtn();
}

function resetForNewDoc() {
  state.files = [];
  state.content = null;
  state.summary = null;
  state.quiz = null;
  renderFiles();
  show('#resultSection', false); show('#errorCard', false);
  show('#hero', true); show('#uploadCard', true);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* =========================================================
 * 이벤트 연결
 * ========================================================= */
function bind() {
  $('#keyForm').addEventListener('submit', saveKey);
  $('#keyToggle').addEventListener('click', () => {
    const i = $('#keyInput');
    i.type = i.type === 'password' ? 'text' : 'password';
    $('#keyToggle').textContent = i.type === 'password' ? '보기' : '숨기기';
  });
  $('#keyCancel').addEventListener('click', () => { $('#keyCard').hidden = true; });
  $('#keyChip').addEventListener('click', openKeyDialog);
  $('#keyDialog').addEventListener('close', () => {
    const v = $('#keyDialog').returnValue;
    if (v === 'delete') { deleteKey(); openKeyCard(); }
    if (v === 'change') openKeyCard(true);
  });
  $('#footerKeyDelete').addEventListener('click', () => { if (!state.key) { toast('저장된 키가 없어요'); return; } deleteKey(); openKeyCard(); });

  const fi = $('#fileInput');
  fi.addEventListener('change', () => { addFiles([...fi.files]); fi.value = ''; });
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => addFiles([...(e.dataTransfer?.files || [])]));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  $('#fileList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    state.files.splice(Number(b.dataset.rm), 1);
    renderFiles();
  });

  $('#diffSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-diff]'); if (b) setDifficulty(b.dataset.diff); });
  $('#analyzeBtn').addEventListener('click', analyze);
  $('#retryBtn').addEventListener('click', () => { show('#errorCard', false); (state.lastAction || analyze)(); });
  $('#errorKeyBtn').addEventListener('click', () => { show('#errorCard', false); openKeyCard(true); });
  $('#newDocBtn').addEventListener('click', resetForNewDoc);

  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('#tab-summary').addEventListener('click', (e) => {
    const u = e.target.closest('[data-units]');
    if (u) $$('#tab-summary details.unit').forEach((d) => { d.open = u.dataset.units === 'open'; });
    const g = e.target.closest('[data-goto]');
    if (g) { switchTab('quiz'); $('.result-head').scrollIntoView({ behavior: 'smooth' }); }
  });

  $('#tab-quiz').addEventListener('click', (e) => {
    const v = state.quizView;
    const c = e.target.closest('.choice');
    if (c && !c.disabled) {
      v.answers[Number(c.dataset.q)] = Number(c.dataset.c);
      const y = window.scrollY;
      renderQuiz();
      window.scrollTo(0, y);
      return;
    }
    const m = e.target.closest('[data-mode]');
    if (m) { v.mode = m.dataset.mode; renderQuiz(); return; }
    const r = e.target.closest('[data-regen]');
    if (r) { v.regenDiff = r.dataset.regen; renderQuiz(); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act;
    if (act === 'grade') {
      const list = v.subset || state.quiz.questions.map((_, i) => i);
      const left = list.filter((i) => v.answers[i] === undefined).length;
      if (left && !confirm(`아직 ${left}문제를 풀지 않았어요. 그래도 채점할까요?`)) return;
      v.graded = true;
      renderQuiz();
      $('.result-head').scrollIntoView({ behavior: 'smooth' });
    } else if (act === 'retry') {
      v.answers = {}; v.graded = false; v.subset = null;
      renderQuiz();
      $('.result-head').scrollIntoView({ behavior: 'smooth' });
    } else if (act === 'wrong') {
      const list = v.subset || state.quiz.questions.map((_, i) => i);
      const wrong = list.filter((i) => v.answers[i] !== state.quiz.questions[i].answer);
      v.subset = wrong; v.answers = {}; v.graded = false;
      renderQuiz();
      $('.result-head').scrollIntoView({ behavior: 'smooth' });
    } else if (act === 'regen') {
      regenerateQuiz();
    }
  });

  window.addEventListener('beforeunload', (e) => { if (state.busy) { e.preventDefault(); e.returnValue = ''; } });
}

document.addEventListener('DOMContentLoaded', () => {
  bind();
  setDifficulty('medium');
  loadKey();
  renderFiles();
});

'use strict';

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

// ─── 定数 ────────────────────────────────────────────────────────────────────

const SEEN_DOCS_PATH = path.join(__dirname, 'seen_docs.json');

// 実行日（システム日付）
const NOW = new Date();
const TODAY = [
  NOW.getFullYear(),
  String(NOW.getMonth() + 1).padStart(2, '0'),
  String(NOW.getDate()).padStart(2, '0'),
].join('-'); // YYYY-MM-DD
const TODAY_COMPACT = TODAY.replace(/-/g, ''); // YYYYMMDD

const EDINET_API_BASE = 'https://disclosure.edinet-api.go.jp/api/v2';
const TDNET_BASE = 'https://www.release.tdnet.info';

// TDnet フィルタ用キーワード
const TOB_KEYWORDS = ['公開買付', '意見表明', 'TOB', '対抗公開買付'];

// ─── .env 手動読み込み ────────────────────────────────────────────────────────

function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

// ─── seen_docs.json ───────────────────────────────────────────────────────────

function loadSeenDocs() {
  try {
    return JSON.parse(fs.readFileSync(SEEN_DOCS_PATH, 'utf8'));
  } catch {
    return { edinet: [], tdnet: [] };
  }
}

function saveSeenDocs(seen) {
  fs.writeFileSync(SEEN_DOCS_PATH, JSON.stringify(seen, null, 2), 'utf8');
}

// ─── EDINET ───────────────────────────────────────────────────────────────────

async function fetchEdinetDocs(date) {
  const apiKey = process.env.EDINET_API_KEY;
  if (!apiKey) {
    console.log('  [SKIP] EDINET_API_KEY 未設定。.env に EDINET_API_KEY を設定すると取得できます。');
    console.log('         取得先: https://api.edinet-fsa.go.jp/');
    return [];
  }

  const url =
    `${EDINET_API_BASE}/documents.json` +
    `?date=${date}&type=2&Subscription-Key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'disclosure-fetcher/1.0' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`EDINET API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const results = data.results || [];

  // 意見表明報告書 (ordinanceCode=06, formCode=290)
  // 公開買付届出書  (ordinanceCode=06, formCode=240) も含める
  // formCode が不確かな場合のフォールバックとして docDescription のキーワードも確認
  return results.filter(
    (doc) =>
      doc.ordinanceCode === '06' ||
      doc.formCode === '290' ||
      doc.formCode === '240' ||
      (doc.docDescription || '').includes('意見表明') ||
      (doc.docDescription || '').includes('公開買付'),
  );
}

// ─── TDnet ────────────────────────────────────────────────────────────────────

async function fetchTdnetDocs(dateCompact) {
  const url = `${TDNET_BASE}/inbs/I_list_001_${dateCompact}.html`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'disclosure-fetcher/1.0' },
  });
  if (!res.ok) throw new Error(`TDnet HTTP ${res.status}`);
  const html = await res.text();
  return parseTdnetHtml(html, dateCompact);
}

function parseTdnetHtml(html, dateCompact) {
  const disclosures = [];
  const seenIds = new Set();

  // <tr>…</tr> を順に処理
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;

  while ((trMatch = trRe.exec(html)) !== null) {
    const rowHtml = trMatch[1];

    // <td>…</td> をすべて抽出（テキストのみ）
    const cells = [];
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRe.exec(rowHtml)) !== null) {
      const text = tdMatch[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
      cells.push(text);
    }

    if (cells.length < 4) continue;

    // TDnet のカラム想定: 時刻 | コード | 会社名 | タイトル | …
    const [timeCol, codeCol, companyCol, titleCol] = cells;

    // 時刻カラムの確認（HH:MM 形式）
    if (!/^\d{1,2}:\d{2}/.test(timeCol)) continue;
    if (!titleCol) continue;

    // TOB キーワードフィルタ
    const isTob = TOB_KEYWORDS.some(
      (kw) => titleCol.includes(kw) || companyCol.includes(kw),
    );
    if (!isTob) continue;

    // PDF リンクからドキュメント ID を抽出
    const pdfMatch = rowHtml.match(/href="([^"]*\/([A-Z0-9]{14,})[^"]*)"/i);
    const docId = pdfMatch
      ? pdfMatch[2]
      : `${dateCompact}_${codeCol}_${timeCol.replace(':', '')}`;

    if (seenIds.has(docId)) continue;
    seenIds.add(docId);

    const pdfHref = pdfMatch ? pdfMatch[1] : null;
    const pdfLink = pdfHref
      ? pdfHref.startsWith('http')
        ? pdfHref
        : `${TDNET_BASE}${pdfHref.startsWith('/') ? '' : '/'}${pdfHref}`
      : null;

    disclosures.push({
      docId,
      time: timeCol,
      code: codeCol,
      company: companyCol,
      title: titleCol,
      pdfLink,
    });
  }

  return disclosures;
}

// ─── AI 要約 ──────────────────────────────────────────────────────────────────

async function generateSummary(newEdinet, newTdnet) {
  if (!process.env.OPENAI_API_KEY) {
    console.log('  [SKIP] OPENAI_API_KEY 未設定のため AI 要約をスキップします。');
    return null;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const items = [
    ...newEdinet.map((d) => ({
      source: 'EDINET',
      docId: d.docID,
      filerName: d.filerName,
      docDescription: d.docDescription,
      submitDateTime: d.submitDateTime,
      edinetCode: d.edinetCode,
      secCode: d.secCode,
    })),
    ...newTdnet.map((d) => ({
      source: 'TDnet',
      docId: d.docId,
      company: d.company,
      code: d.code,
      title: d.title,
      time: d.time,
      pdfLink: d.pdfLink,
    })),
  ];

  const prompt = `以下は本日のTOB（株式公開買付け）関連の新着開示書類の一覧です。
各書類について、投資家・M&A実務者向けに日本語で簡潔に要約してください。

${JSON.stringify(items, null, 2)}

各書類を以下の形式でまとめてください：

---
■ [会社名]
- 種類: [書類の種類]
- 開示日時: [日時]
- 概要: [書類の内容・TOBの状況（書類の種類と会社名から推測できる範囲で記載）]
- リンク: [PDF URLがあれば記載。なければ「EDINET で閲覧可」等]
---
`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2000,
    temperature: 0.3,
  });

  return completion.choices[0].message.content;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  loadDotEnv();

  const hr = '='.repeat(60);
  const hr2 = '-'.repeat(60);

  console.log(`\n${hr}`);
  console.log(`  TOB関連開示情報 新着チェック  [${TODAY}]`);
  console.log(`${hr}\n`);

  const seen = loadSeenDocs();

  // ── EDINET ──
  console.log('【EDINET】意見表明報告書 / 公開買付届出書');
  let edinetDocs = [];
  try {
    edinetDocs = await fetchEdinetDocs(TODAY);
    console.log(`  取得: ${edinetDocs.length} 件`);
  } catch (err) {
    console.error(`  エラー: ${err.message}`);
  }
  const newEdinet = edinetDocs.filter((d) => !seen.edinet.includes(d.docID));
  console.log(`  新着: ${newEdinet.length} 件\n`);

  // ── TDnet ──
  console.log('【TDnet】TOB関連適時開示');
  let tdnetDocs = [];
  try {
    tdnetDocs = await fetchTdnetDocs(TODAY_COMPACT);
    console.log(`  取得: ${tdnetDocs.length} 件`);
  } catch (err) {
    console.error(`  エラー: ${err.message}`);
  }
  const newTdnet = tdnetDocs.filter((d) => !seen.tdnet.includes(d.docId));
  console.log(`  新着: ${newTdnet.length} 件\n`);

  // ── 結果表示 ──
  console.log(hr2);
  const totalNew = newEdinet.length + newTdnet.length;

  if (totalNew === 0) {
    console.log('\n  新着書類はありません。\n');
    console.log(hr);
    return;
  }

  console.log(`\n  新着 ${totalNew} 件\n`);

  if (newEdinet.length > 0) {
    console.log('■ EDINET 新着');
    for (const doc of newEdinet) {
      console.log(`  • ${doc.filerName}  /  ${doc.docDescription || '（種類不明）'}`);
      console.log(`    提出日時: ${doc.submitDateTime}  DocID: ${doc.docID}`);
    }
    console.log();
  }

  if (newTdnet.length > 0) {
    console.log('■ TDnet 新着');
    for (const doc of newTdnet) {
      console.log(`  • [${doc.code}] ${doc.company}  /  ${doc.title}  (${doc.time})`);
      if (doc.pdfLink) console.log(`    PDF: ${doc.pdfLink}`);
    }
    console.log();
  }

  // ── AI 要約 ──
  console.log(hr2);
  console.log('【AI 要約】\n');
  const summary = await generateSummary(newEdinet, newTdnet);
  if (summary) {
    console.log(summary);
  }

  // ── seen_docs.json 更新 ──
  seen.edinet = [...new Set([...seen.edinet, ...newEdinet.map((d) => d.docID)])];
  seen.tdnet = [...new Set([...seen.tdnet, ...newTdnet.map((d) => d.docId)])];
  saveSeenDocs(seen);
  console.log(`\n  seen_docs.json を更新しました。\n`);
  console.log(hr);
}

main().catch((err) => {
  console.error('\n致命的エラー:', err);
  process.exit(1);
});

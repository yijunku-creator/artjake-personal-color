// 아트제이크 퍼스널컬러 — 메일 발송 + 진단 기록(노션)용 Google Apps Script
// 스튜디오 구글 계정의 Gmail로 결과 메일을 보내고, 진단 측정값(사진 제외)을 노션 데이터베이스에 쌓습니다.
// 노션 토큰은 코드에 쓰지 않고 [프로젝트 설정 → 스크립트 속성]의 NOTION_TOKEN에 둡니다.
// 설정 방법: 같은 폴더의 설정방법.md

// 앱의 config.js MAIL_KEY와 같은 값 (실제 값은 Apps Script 쪽과 config.js에만 둠)
const KEY = 'artjake-color-change-me';
const SENDER_NAME = '아트제이크 퍼스널컬러';
const NOTION_DB = '9165beb42a2048d38b1e3e9b041fd16c'; // 노션 '퍼스널컬러 진단 기록'
const NOTION_VERSION = '2022-06-28';

const TYPE_NAMES = {
  springLight: '봄 웜 라이트', springBright: '봄 웜 브라이트', summerLight: '여름 쿨 라이트', summerMute: '여름 쿨 뮤트',
  autumnMute: '가을 웜 뮤트', autumnDeep: '가을 웜 딥', winterBright: '겨울 쿨 브라이트', winterDeep: '겨울 쿨 딥',
};
const TYPE_IDS = Object.fromEntries(Object.entries(TYPE_NAMES).map(([k, v]) => [v, k]));
const MAKEUP = { none: '맨얼굴', base: '베이스', full: '풀메이크업' };
const HAIR = { natural: '원래 머리색', dyed: '염색·탈색' };
const NUM_COLS = ['skinL', 'skinA', 'skinB', 'skinHue', 'skinChroma', 'hairL', 'hairA', 'hairB', 'irisL', 'irisA', 'irisB',
  'lipL', 'lipA', 'lipB', 'browL', 'browA', 'browB', 'warmth', 'light', 'clarity', 'contrast', 'gainR', 'gainG', 'gainB', 'frames'];

// 배포 전에 한 번 실행: Gmail·외부 요청 권한 승인 + 노션 연결 확인
function authorize() {
  Logger.log('오늘 남은 발송 가능 수: ' + MailApp.getRemainingDailyQuota());
  const db = notion_('get', '/databases/' + NOTION_DB);
  Logger.log('노션 연결 확인: ' + (db.title && db.title[0] ? db.title[0].plain_text : NOTION_DB));
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.key !== KEY) throw new Error('인증 키가 맞지 않아요');
    switch (d.action || 'mail') {
      case 'mail': return reply(sendMail_(d));
      case 'log': return reply(logRow_(d.row));
      case 'list': return reply(listRows_());
      case 'label': return reply(labelRow_(d.id, d.actual, d.memo));
      default: throw new Error('알 수 없는 요청');
    }
  } catch (err) {
    return reply({ ok: false, error: String(err.message || err) });
  }
}

function sendMail_(d) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.to || '')) throw new Error('메일 주소 형식이 맞지 않아요');
  const options = { name: SENDER_NAME, htmlBody: d.html };
  if (d.image) {
    options.inlineImages = {
      card: Utilities.newBlob(Utilities.base64Decode(d.image), 'image/jpeg', 'personal-color.jpg'),
    };
  }
  MailApp.sendEmail(d.to, d.subject, d.text || '', options);
  return { ok: true, remaining: MailApp.getRemainingDailyQuota() };
}

// ---------- 노션 ----------
function notion_(method, path, body) {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('노션 토큰(NOTION_TOKEN)이 설정되지 않았어요');
  const res = UrlFetchApp.fetch('https://api.notion.com/v1' + path, {
    method: method,
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, 'Notion-Version': NOTION_VERSION },
    payload: body ? JSON.stringify(body) : undefined,
    muteHttpExceptions: true,
  });
  const j = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() >= 300) throw new Error('노션 오류: ' + (j.message || res.getResponseCode()));
  return j;
}
const text_ = (s) => ({ rich_text: s ? [{ text: { content: String(s).slice(0, 1900) } }] : [] });
const select_ = (name) => ({ select: name ? { name: name } : null });
const plain_ = (p) => (p && (p.rich_text || p.title) || []).map((t) => t.plain_text).join('');

function logRow_(row) {
  if (!row || !row.id) throw new Error('기록 내용이 없어요');
  // 같은 기록이 두 번 들어오지 않게 (오프라인 재전송 대비)
  const dup = notion_('post', '/databases/' + NOTION_DB + '/query', {
    filter: { property: '기록 ID', rich_text: { equals: row.id } }, page_size: 1,
  });
  if (dup.results.length) return { ok: true, duplicate: true };

  const when = new Date(row.time || Date.now());
  const props = {
    '기록': { title: [{ text: { content: Utilities.formatDate(when, 'Asia/Seoul', 'MM/dd HH:mm') + ' · ' + (TYPE_NAMES[row.predicted] || row.predicted) } }] },
    '진단 시각': { date: { start: when.toISOString() } },
    '예측 타입': select_(TYPE_NAMES[row.predicted]),
    '두번째 타입': select_(TYPE_NAMES[row.second]),
    '일치도': { number: Number(row.matchPct) || null },
    '화장': select_(MAKEUP[row.makeup]),
    '머리': select_(HAIR[row.hair]),
    '컬러렌즈': { checkbox: row.lens === 'yes' },
    '피부색': text_(row.skinHex),
    '기록 ID': text_(row.id),
  };
  NUM_COLS.forEach((c) => { const v = Number(row[c]); props[c] = { number: row[c] === '' || row[c] == null || isNaN(v) ? null : v }; });
  notion_('post', '/pages', { parent: { database_id: NOTION_DB }, properties: props });
  return { ok: true };
}

function listRows_() {
  const rows = [];
  let cursor;
  do {
    const j = notion_('post', '/databases/' + NOTION_DB + '/query', {
      sorts: [{ property: '진단 시각', direction: 'ascending' }], page_size: 100, start_cursor: cursor,
    });
    j.results.forEach((pg) => {
      const p = pg.properties, sel = (k) => (p[k] && p[k].select ? p[k].select.name : '');
      const row = {
        id: pg.id, url: pg.url, recordId: plain_(p['기록 ID']),
        time: p['진단 시각'] && p['진단 시각'].date ? p['진단 시각'].date.start : pg.created_time,
        predicted: TYPE_IDS[sel('예측 타입')] || '', actual: TYPE_IDS[sel('실제 타입')] || '', second: TYPE_IDS[sel('두번째 타입')] || '',
        matchPct: p['일치도'] ? p['일치도'].number : '',
        makeup: Object.keys(MAKEUP).find((k) => MAKEUP[k] === sel('화장')) || '',
        hair: Object.keys(HAIR).find((k) => HAIR[k] === sel('머리')) || '',
        lens: p['컬러렌즈'] && p['컬러렌즈'].checkbox ? 'yes' : 'no',
        skinHex: plain_(p['피부색']), memo: plain_(p['메모']),
      };
      row.match = row.actual ? (row.actual === row.predicted ? 1 : 0) : '';
      NUM_COLS.forEach((c) => { row[c] = p[c] ? p[c].number : ''; });
      rows.push(row);
    });
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor && rows.length < 1000);
  return { ok: true, dbUrl: 'https://www.notion.so/' + NOTION_DB, rows: rows };
}

function labelRow_(pageId, actual, memo) {
  if (!pageId) throw new Error('기록을 찾지 못했어요');
  const props = {};
  if (actual !== undefined) props['실제 타입'] = select_(TYPE_NAMES[actual]);
  if (memo !== undefined) props['메모'] = text_(memo);
  notion_('patch', '/pages/' + pageId, { properties: props });
  return { ok: true };
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

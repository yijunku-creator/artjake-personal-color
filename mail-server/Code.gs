// 아트제이크 퍼스널컬러 — 진단 결과 메일 발송용 Google Apps Script
// 스튜디오 구글 계정의 Gmail로 발송합니다. (무료, 개인 계정 기준 하루 100통)
// 설정 방법: 같은 폴더의 설정방법.md

// 앱의 config.js MAIL_KEY와 같은 값으로 바꿔주세요.
const KEY = 'artjake-color-change-me';
const SENDER_NAME = '아트제이크 퍼스널컬러';

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.key !== KEY) throw new Error('인증 키가 맞지 않아요');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.to || '')) throw new Error('메일 주소 형식이 맞지 않아요');

    const options = { name: SENDER_NAME, htmlBody: d.html };
    if (d.image) {
      options.inlineImages = {
        card: Utilities.newBlob(Utilities.base64Decode(d.image), 'image/jpeg', 'personal-color.jpg'),
      };
    }
    MailApp.sendEmail(d.to, d.subject, d.text || '', options);
    return reply({ ok: true, remaining: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return reply({ ok: false, error: String(err.message || err) });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// 배포 전에 한 번 실행해서 Gmail 발송 권한을 승인하는 용도
function authorize() {
  Logger.log('오늘 남은 발송 가능 수: ' + MailApp.getRemainingDailyQuota());
}

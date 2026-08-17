import { startQrRegistration, qrStatus, finishQrRegistration } from './qr-out/qr-entry.js';
const root = '/home/luoke/.lark-channel';
const r = await startQrRegistration(root);
console.log('MARKER_URL=' + r.qrUrl);
console.log('MARKER_SESSION=' + r.sessionId);
for (let i = 0; i < 120; i++) {
  await new Promise((res) => setTimeout(res, 3000));
  const st = qrStatus(r.sessionId);
  if (st.status === 'scanned' || st.status === 'done') {
    console.log('MARKER_SCANNED');
    const fin = await finishQrRegistration({ sessionId: r.sessionId, agentKind: 'openclaw', profile: 'openclaw-test' }, root);
    console.log('MARKER_FINISHED=' + JSON.stringify(fin));
    process.exit(0);
  }
  if (st.status === 'error') {
    console.log('MARKER_ERROR=' + st.error);
    process.exit(1);
  }
}
console.log('MARKER_TIMEOUT');
process.exit(1);

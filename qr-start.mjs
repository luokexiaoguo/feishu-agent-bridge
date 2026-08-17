import { startQrRegistration } from './qr-out/qr-entry.js';
const r = await startQrRegistration('/home/luoke/.lark-channel');
console.log('SESSION:', r.sessionId);
console.log('URL:', r.qrUrl);
console.log('EXPIRE:', r.expireIn);

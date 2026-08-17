type TenantBrand = 'feishu' | 'lark';

/**
 * QR app-creation session. Mirrors the terminal `runRegistrationWizard`:
 * `registerApp` yields a QR URL to scan and resolves with fresh app
 * credentials once the user finishes creating the app in Feishu. Two phases so
 * the agent/profile choice is applied at scan time, not baked into the QR:
 *   start  → shows the QR (poll {@link qrStatus} for 'scanned')
 *   finish → writes the profile from the created app creds + chosen agent/profile
 * The App Secret lives only in the session (localhost, short TTL) between the
 * two, and is cleared right after the profile is written.
 */
interface QrSession {
    status: 'pending' | 'scanned' | 'done' | 'error';
    qrUrl: string;
    expireIn: number;
    app?: {
        appId: string;
        appSecret: string;
        tenant: TenantBrand;
    };
    /** App/bot name from the created app (for the confirm-step prefill). */
    botName?: string;
    /** Sanitized + de-duped profile name suggestion derived from botName. */
    suggestedProfile?: string;
    profile?: string;
    error?: string;
    createdAt: number;
}
/**
 * Begin a QR registration. Resolves once the QR URL is ready (so the client can
 * render it); the app is created out-of-band when the user scans — track via
 * {@link qrStatus}, then call {@link finishQrRegistration}.
 */
declare function startQrRegistration(rootDir?: string): Promise<{
    sessionId: string;
    qrUrl: string;
    expireIn: number;
}>;
declare function qrStatus(sessionId: string): {
    status: QrSession['status'];
    profile?: string;
    botName?: string;
    suggestedProfile?: string;
    error?: string;
};
/** Write the profile once the app is created (status 'scanned'). Idempotent. */
declare function finishQrRegistration(body: unknown, rootDir?: string): Promise<{
    profile: string;
}>;

export { finishQrRegistration, qrStatus, startQrRegistration };

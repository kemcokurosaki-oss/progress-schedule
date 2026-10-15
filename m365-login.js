// Microsoft 365 ログイン（ログイン機能を持たないアプリ向けの共通部品）
// 使い方: Supabase のクライアントを作った直後に M365Login.init(client, { appName: '進捗管理表' }) を呼ぶ。
//
// 完全移行スイッチ M365_ONLY を true にすると、ログインしないと閲覧できなくなる（ログイン画面を閉じられない状態で出す）。
// ログイン画面は「Microsoftでサインイン」だけで、パスワード欄は非常用に URL へ ?pw=1 を付けたときだけ表示する。
// false の間は、URL に ?ms=1 を付けたときだけログイン画面を出す（動作確認用）。
(function () {
    const M365_ONLY = false;

    const qs = new URLSearchParams(window.location.search);
    const GATE          = M365_ONLY || qs.has('ms');
    const SHOW_PASSWORD = !M365_ONLY || qs.has('pw');

    const CSS = `
#m365_login_overlay { position: fixed; inset: 0; background: rgba(15, 23, 42, .55); z-index: 2147483000;
    display: none; align-items: center; justify-content: center; font-family: 'メイリオ', Meiryo, sans-serif; }
#m365_login_overlay.open { display: flex; }
#m365_login_dialog { background: #fff; border-radius: 10px; padding: 28px 26px; width: 320px; box-shadow: 0 12px 40px rgba(0,0,0,.3); }
#m365_login_dialog h2 { margin: 0 0 18px; font-size: 15px; text-align: center; color: #333; }
#m365_login_dialog .m365-ms-btn { width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 10px; background: #fff; color: #1f1f1f; border: 1px solid #c8cfda; border-radius: 6px;
    font-size: 14px; font-weight: bold; cursor: pointer; font-family: inherit; }
#m365_login_dialog .m365-ms-btn:hover { background: #f3f6fa; }
#m365_login_dialog .m365-divider { display: flex; align-items: center; gap: 8px; margin: 14px 0 12px; color: #999; font-size: 11px; }
#m365_login_dialog .m365-divider::before, #m365_login_dialog .m365-divider::after { content: ''; flex: 1; border-top: 1px solid #e0e0e0; }
#m365_login_dialog input { width: 100%; padding: 8px 10px; margin-bottom: 10px; border: 1px solid #ccc; border-radius: 4px;
    font-size: 13px; box-sizing: border-box; font-family: inherit; }
#m365_login_dialog .m365-pw-btn { width: 100%; padding: 9px; background: #3498db; color: #fff; border: none; border-radius: 4px;
    font-size: 13px; cursor: pointer; font-family: inherit; }
#m365_login_dialog .m365-error { color: #e74c3c; font-size: 12px; margin-top: 10px; min-height: 0; }
#m365_user_chip { position: fixed; right: 10px; bottom: 10px; z-index: 2147482000; background: rgba(255,255,255,.95);
    border: 1px solid #d0d7e2; border-radius: 16px; padding: 4px 6px 4px 12px; font-size: 12px; color: #333;
    font-family: 'メイリオ', Meiryo, sans-serif; display: none; align-items: center; gap: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.12); }
#m365_user_chip button { border: none; background: #eef2f7; border-radius: 12px; padding: 3px 10px; font-size: 11px; cursor: pointer; font-family: inherit; }
`;

    const MS_LOGO = '<svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>';

    let client = null;

    function el(id) { return document.getElementById(id); }

    function build(appName) {
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        const overlay = document.createElement('div');
        overlay.id = 'm365_login_overlay';
        overlay.innerHTML = `
<div id="m365_login_dialog">
    <h2></h2>
    <button type="button" class="m365-ms-btn" id="m365_ms_btn">${MS_LOGO}Microsoftでサインイン</button>
    <div id="m365_pw_area" style="display:none">
        <div class="m365-divider"><span>または（非常用）</span></div>
        <input type="email" id="m365_email" placeholder="メールアドレス" autocomplete="email">
        <input type="password" id="m365_password" placeholder="パスワード" autocomplete="current-password">
        <button type="button" class="m365-pw-btn" id="m365_pw_btn">ログイン</button>
    </div>
    <div class="m365-error" id="m365_error"></div>
</div>`;
        overlay.querySelector('h2').textContent = `${appName} ログイン`;
        document.body.appendChild(overlay);

        const chip = document.createElement('div');
        chip.id = 'm365_user_chip';
        chip.innerHTML = '<span id="m365_user_name"></span><button type="button" id="m365_logout_btn">ログアウト</button>';
        document.body.appendChild(chip);

        el('m365_pw_area').style.display = SHOW_PASSWORD && M365_ONLY ? '' : 'none';
        el('m365_ms_btn').addEventListener('click', signInMicrosoft);
        el('m365_pw_btn').addEventListener('click', signInPassword);
        el('m365_password').addEventListener('keydown', (e) => { if (e.key === 'Enter') signInPassword(); });
        el('m365_logout_btn').addEventListener('click', async () => {
            if (!confirm('ログアウトしますか？')) return;
            await client.auth.signOut();
            location.reload();
        });
    }

    function showError(msg) { el('m365_error').textContent = msg; }

    async function signInMicrosoft() {
        const { error } = await client.auth.signInWithOAuth({
            provider: 'azure',
            options: { scopes: 'email', redirectTo: window.location.origin + window.location.pathname }
        });
        if (error) showError('Microsoftでのログインを開始できませんでした');
    }

    async function signInPassword() {
        const email = el('m365_email').value.trim();
        const password = el('m365_password').value;
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) { showError('メールアドレスまたはパスワードが正しくありません'); return; }
        location.reload(); // 未ログインでは読めなかったデータを読み込み直す
    }

    function oauthErrorFromUrl() {
        const p = new URLSearchParams(window.location.hash.replace('#', '?'));
        const err = p.get('error') || qs.get('error');
        if (!err) return null;
        return 'Microsoftでのログインに失敗しました（' + (p.get('error_description') || qs.get('error_description') || err) + '）';
    }

    function render(session) {
        const user = session?.user;
        if (user) {
            const meta = user.user_metadata || {};
            el('m365_user_name').textContent = meta.full_name || meta.name || user.email;
            el('m365_user_chip').style.display = 'flex';
            el('m365_login_overlay').classList.remove('open');
        } else {
            el('m365_user_chip').style.display = 'none';
            if (GATE) el('m365_login_overlay').classList.add('open');
        }
    }

    window.M365Login = {
        M365_ONLY,
        init(supabaseClient, { appName }) {
            client = supabaseClient;
            const start = () => {
                build(appName);
                const oauthError = oauthErrorFromUrl();
                client.auth.onAuthStateChange((event, session) => {
                    if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'SIGNED_OUT') render(session);
                    if (oauthError && event === 'INITIAL_SESSION') {
                        el('m365_login_overlay').classList.add('open');
                        showError(oauthError);
                        history.replaceState(null, '', window.location.pathname);
                    }
                });
            };
            if (document.body) start();
            else document.addEventListener('DOMContentLoaded', start);
        },
    };
})();

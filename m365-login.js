// Microsoft 365 ログイン（ログイン機能を持たないアプリ向けの共通部品）
// 使い方: Supabase のクライアントを作った直後に M365Login.init(client, { appName: '進捗管理表', mountAfter: '#refresh-btn' }) を呼ぶ。
// mountAfter に指定したボタンのすぐ右に、ログイン中の人のアイコンを置く（押すと名前とログアウトを表示）。
// 指定が無い・見つからないときは画面の右下に置く。
//
// 完全移行スイッチ M365_ONLY を true にすると、ログインしないと閲覧できなくなる（ログイン画面を閉じられない状態で出す）。
// ログイン画面は「Microsoftでサインイン」だけで、パスワード欄は非常用に URL へ ?pw=1 を付けたときだけ表示する。
// false の間は、URL に ?ms=1 を付けたときだけログイン画面を出す（動作確認用）。
// Microsoft でのログイン後、新規作成のときは Supabase が別のアプリ（Site URL）に戻してしまうことがある。
// ログインを始めたページを m365_return_to に覚えておき、違うページに戻ってきたらトークンごと元のページへ送る
(function () {
    const ret = localStorage.getItem('m365_return_to');
    if (!ret) return;
    const fromLogin = /access_token=|error=/.test(location.hash) || /[?&](code|error)=/.test(location.search);
    if (!fromLogin) return;
    localStorage.removeItem('m365_return_to');
    if (ret !== location.origin + location.pathname) location.replace(ret + location.search + location.hash);
})();
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
#m365_user_chip { position: relative; display: none; align-items: center; margin-left: 6px; vertical-align: middle;
    font-family: 'メイリオ', Meiryo, sans-serif; }
#m365_user_chip.m365-floating { position: fixed; right: 10px; bottom: 10px; z-index: 2147482000; margin: 0; }
#m365_user_btn { width: 28px; height: 28px; border-radius: 50%; border: 1px solid #c8cfda; background: #fff; color: #2f6fb0;
    display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; }
#m365_user_btn:hover { background: #f3f6fa; }
#m365_user_menu { display: none; position: absolute; right: 0; top: calc(100% + 6px); z-index: 2147482001; min-width: 200px;
    background: #fff; border: 1px solid #d0d7e2; border-radius: 8px; padding: 10px 12px; box-shadow: 0 6px 20px rgba(0,0,0,.18);
    font-size: 12px; color: #333; text-align: left; }
#m365_user_chip.m365-floating #m365_user_menu { top: auto; bottom: calc(100% + 6px); }
#m365_user_menu.open { display: block; }
#m365_user_menu .m365-user-email { color: #888; font-size: 11px; margin-top: 2px; word-break: break-all; }
#m365_user_menu button { margin-top: 10px; width: 100%; border: none; background: #eef2f7; border-radius: 6px; padding: 6px 10px;
    font-size: 12px; cursor: pointer; font-family: inherit; color: #333; }
`;

    const MS_LOGO = '<svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>';

    let client = null;

    function el(id) { return document.getElementById(id); }

    const USER_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>';

    function build(appName, mountAfter) {
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

        const chip = document.createElement('span');
        chip.id = 'm365_user_chip';
        chip.innerHTML = `<button type="button" id="m365_user_btn" title="ログイン中のユーザー">${USER_ICON}</button>
<div id="m365_user_menu"><div id="m365_user_name"></div><div class="m365-user-email" id="m365_user_email"></div>
<button type="button" id="m365_logout_btn">ログアウト</button></div>`;
        const anchor = mountAfter ? document.querySelector(mountAfter) : null;
        if (anchor) anchor.insertAdjacentElement('afterend', chip);
        else { chip.classList.add('m365-floating'); document.body.appendChild(chip); }
        el('m365_user_btn').addEventListener('click', (e) => { e.stopPropagation(); el('m365_user_menu').classList.toggle('open'); });
        el('m365_user_menu').addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', () => el('m365_user_menu').classList.remove('open'));

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
        localStorage.setItem('m365_return_to', window.location.origin + window.location.pathname);
        const { error } = await client.auth.signInWithOAuth({
            provider: 'azure',
            options: { scopes: 'openid profile email', redirectTo: window.location.origin + window.location.pathname }
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
            el('m365_user_email').textContent = user.email;
            el('m365_user_chip').style.display = 'inline-flex';
            el('m365_login_overlay').classList.remove('open');
        } else {
            el('m365_user_chip').style.display = 'none';
            if (GATE) el('m365_login_overlay').classList.add('open');
        }
    }

    window.M365Login = {
        M365_ONLY,
        init(supabaseClient, { appName, mountAfter }) {
            client = supabaseClient;
            const start = () => {
                build(appName, mountAfter);
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

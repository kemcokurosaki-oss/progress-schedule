// Microsoft 365 ログインの共通部品（工程表アプリ群で同じファイルを使う）
//
// ■ M365Login.init(client, { appName, mountAfter, floating, canEdit })
//   ログイン機能を持たないアプリ向け。ログイン画面と、ログイン中のユーザー表示をまとめて用意する。
//   完全移行スイッチ M365_ONLY を true にすると、ログインしないと閲覧できなくなる（ログイン画面を閉じられない状態で出す）。
//   ログイン画面は「Microsoftでサインイン」だけで、パスワード欄は非常用に URL へ ?pw=1 を付けたときだけ表示する。
//   false の間は、URL に ?ms=1 を付けたときだけログイン画面を出す（動作確認用）。
//
// ■ M365Login.mountUserChip(client, { mountAfter, floating, canEdit, hideWhenLoggedIn })
//   ログイン中のユーザー表示だけを置く（ログイン画面は各アプリのものを使う場合）。
//
// ユーザー表示: 人のアイコン＋フルネーム。押すと、フルネーム・メールアドレス・権限（編集できます／閲覧のみ）・ログアウト。
//   mountAfter: このボタンのすぐ右に置く（CSS セレクター）。floating: 'bottom-left' / 'bottom-right'（画面の隅に固定）
//   canEdit(email): 編集できる人なら true。hideWhenLoggedIn: ログイン中は隠す要素（元のログイン／ログアウトボタンなど）
//   名前は Microsoft 365 の表示名を使う（届かないときはメールアドレスの @ より前）。通知や担当者の照合には使わない。

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
#m365_user_chip.m365-floating { position: fixed; bottom: 10px; z-index: 2147482000; margin: 0; }
#m365_user_chip.m365-floating-right { right: 10px; }
#m365_user_chip.m365-floating-left { left: 10px; }
#m365_user_btn { height: 28px; max-width: 200px; border: none; background: transparent; color: inherit;
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer; padding: 0 4px 0 0; font-size: 12px; font-family: inherit; }
#m365_user_btn .m365-user-icon { width: 26px; height: 26px; border-radius: 50%; border: 1px solid #c8cfda; background: #fff;
    color: #2f6fb0; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
#m365_user_btn:hover .m365-user-icon { background: #f3f6fa; }
#m365_user_btn .m365-user-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#m365_user_menu { display: none; position: fixed; z-index: 2147482001; min-width: 220px; max-width: 320px;
    background: #fff; border: 1px solid #d0d7e2; border-radius: 8px; padding: 10px 12px; box-shadow: 0 6px 20px rgba(0,0,0,.18);
    font-size: 12px; color: #333; text-align: left; }
#m365_user_menu.open { display: block; }
#m365_user_menu .m365-user-name { font-weight: bold; }
#m365_user_menu .m365-user-email { color: #888; font-size: 11px; margin-top: 2px; word-break: break-all; }
#m365_user_menu .m365-user-role { margin-top: 8px; display: inline-flex; align-items: center; gap: 4px; font-size: 11px;
    padding: 1px 8px 1px 6px; border-radius: 10px; }
#m365_user_menu .m365-user-role.edit { background: #e8f5e9; color: #2e7d32; }
#m365_user_menu .m365-user-role.view { background: #eef2f7; color: #8a94a6; }
#m365_user_menu button { margin-top: 10px; width: 100%; border: none; background: #eef2f7; border-radius: 6px; padding: 6px 10px;
    font-size: 12px; cursor: pointer; font-family: inherit; color: #333; }
`;

    const MS_LOGO = '<svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>';
    const PENCIL_ICON    = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
    const NO_PENCIL_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/><line x1="3" y1="3" x2="21" y2="21"/></svg>';
    const USER_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>';

    function el(id) { return document.getElementById(id); }

    let styleAdded = false;
    function addStyle() {
        if (styleAdded) return;
        styleAdded = true;
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    function whenReady(fn) {
        if (document.body) fn();
        else document.addEventListener('DOMContentLoaded', fn);
    }

    // Microsoft 365 の表示名。パスワードでログインした人など、名前が届いていないときは空
    function m365Name(user) {
        const meta = user.user_metadata || {};
        return meta.full_name || meta.name || '';
    }
    // 表示名: Microsoft 365 でログインしていればフルネーム。まだなら DB（profiles）の登録名、それも無ければメールの @ より前
    async function resolveDisplayName(client, user) {
        const fromM365 = m365Name(user);
        if (fromM365) return fromM365;
        try {
            const { data } = await client.from('profiles').select('name').eq('id', user.id).maybeSingle();
            if (data?.name) return data.name;
        } catch (_) { /* 読めなくても下の表示にする */ }
        return String(user.email || '').split('@')[0];
    }

    // ===== ログイン中のユーザー表示 =====
    function mountUserChip(client, { mountAfter, floating = 'bottom-right', canEdit, hideWhenLoggedIn } = {}) {
        whenReady(() => {
            addStyle();
            const chip = document.createElement('span');
            chip.id = 'm365_user_chip';
            chip.innerHTML = `<button type="button" id="m365_user_btn" title="ログイン中のユーザー"><span class="m365-user-icon">${USER_ICON}</span><span class="m365-user-label" id="m365_user_label"></span></button>
<div id="m365_user_menu"><div class="m365-user-name" id="m365_user_name"></div><div class="m365-user-email" id="m365_user_email"></div>
<span class="m365-user-role" id="m365_user_role"></span>
<button type="button" id="m365_logout_btn">ログアウト</button></div>`;
            const anchor = mountAfter ? document.querySelector(mountAfter) : null;
            if (anchor) anchor.insertAdjacentElement('afterend', chip);
            else {
                chip.classList.add('m365-floating', floating === 'bottom-left' ? 'm365-floating-left' : 'm365-floating-right');
                document.body.appendChild(chip);
            }

            let currentUser = null;
            const renderRole = () => {
                if (!currentUser) return;
                const editable = typeof canEdit === 'function' ? !!canEdit(currentUser.email || '') : false;
                const role = el('m365_user_role');
                role.innerHTML = (editable ? PENCIL_ICON : NO_PENCIL_ICON) + '<span>編集</span>';
                role.title = editable ? '編集できます' : '閲覧のみ（編集はできません）';
                role.className = 'm365-user-role ' + (editable ? 'edit' : 'view');
            };
            // メニューは押したボタンの位置を基準に画面へ重ねて出す（親の要素で切れたり、はみ出したりしないように）
            const placeMenu = () => {
                const menu = el('m365_user_menu');
                const r = el('m365_user_btn').getBoundingClientRect();
                const w = menu.offsetWidth, h = menu.offsetHeight, gap = 6;
                const top = r.bottom + gap + h <= window.innerHeight ? r.bottom + gap : Math.max(gap, r.top - gap - h);
                const left = Math.min(Math.max(gap, r.left), window.innerWidth - w - gap);
                menu.style.top = top + 'px';
                menu.style.left = left + 'px';
            };
            el('m365_user_btn').addEventListener('click', (e) => {
                e.stopPropagation();
                renderRole(); // 権限は開いたときに判定する（アプリ側の判定が後から決まることがあるため）
                const menu = el('m365_user_menu');
                menu.classList.toggle('open');
                if (menu.classList.contains('open')) placeMenu();
            });
            window.addEventListener('resize', () => el('m365_user_menu').classList.remove('open'));
            el('m365_user_menu').addEventListener('click', (e) => e.stopPropagation());
            document.addEventListener('click', () => el('m365_user_menu').classList.remove('open'));
            el('m365_logout_btn').addEventListener('click', async () => {
                if (!confirm('ログアウトしますか？')) return;
                await client.auth.signOut();
                location.reload();
            });

            client.auth.onAuthStateChange((event, session) => setTimeout(() => {
                if (event !== 'INITIAL_SESSION' && event !== 'SIGNED_IN' && event !== 'SIGNED_OUT' && event !== 'USER_UPDATED') return;
                currentUser = session?.user || null;
                const hide = hideWhenLoggedIn ? document.querySelector(hideWhenLoggedIn) : null;
                if (currentUser) {
                    const user = currentUser;
                    resolveDisplayName(client, user).then((name) => {
                        if (currentUser !== user) return;
                        el('m365_user_label').textContent = name;
                        el('m365_user_name').textContent = name;
                    });
                    el('m365_user_email').textContent = currentUser.email || '';
                    renderRole();
                    chip.style.display = 'inline-flex';
                    if (hide) hide.style.display = 'none';
                } else {
                    chip.style.display = 'none';
                    el('m365_user_menu').classList.remove('open');
                    if (hide) hide.style.display = '';
                }
            }, 0));
        });
    }

    // ===== ログイン画面（ログイン機能を持たないアプリ向け） =====
    function init(client, { appName, mountAfter, floating, canEdit } = {}) {
        whenReady(() => {
            addStyle();
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

            const showError = (msg) => { el('m365_error').textContent = msg; };
            el('m365_pw_area').style.display = SHOW_PASSWORD && M365_ONLY ? '' : 'none';
            el('m365_ms_btn').addEventListener('click', async () => {
                localStorage.setItem('m365_return_to', window.location.origin + window.location.pathname);
                const { error } = await client.auth.signInWithOAuth({
                    provider: 'azure',
                    options: { scopes: 'openid profile email', redirectTo: window.location.origin + window.location.pathname }
                });
                if (error) showError('Microsoftでのログインを開始できませんでした');
            });
            const signInPassword = async () => {
                const email = el('m365_email').value.trim();
                const password = el('m365_password').value;
                const { error } = await client.auth.signInWithPassword({ email, password });
                if (error) { showError('メールアドレスまたはパスワードが正しくありません'); return; }
                location.reload(); // 未ログインでは読めなかったデータを読み込み直す
            };
            el('m365_pw_btn').addEventListener('click', signInPassword);
            el('m365_password').addEventListener('keydown', (e) => { if (e.key === 'Enter') signInPassword(); });

            const p = new URLSearchParams(window.location.hash.replace('#', '?'));
            const err = p.get('error') || qs.get('error');
            const oauthError = err ? 'Microsoftでのログインに失敗しました（' + (p.get('error_description') || qs.get('error_description') || err) + '）' : null;

            client.auth.onAuthStateChange((event, session) => {
                if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
                    if (session?.user) overlay.classList.remove('open');
                    else if (GATE) overlay.classList.add('open');
                }
                if (oauthError && event === 'INITIAL_SESSION') {
                    overlay.classList.add('open');
                    showError(oauthError);
                    history.replaceState(null, '', window.location.pathname);
                }
            });
        });
        mountUserChip(client, { mountAfter, floating, canEdit });
    }

    window.M365Login = { M365_ONLY, init, mountUserChip, m365Name, PENCIL_ICON, NO_PENCIL_ICON };
})();

// 進捗管理表：全体工程表と同じ Supabase(tasks テーブル)を参照する閲覧専用アプリ
// 認証なし・読み取り専用（tasks_select_public_read ポリシーにより anon で SELECT 可能）
const S_URL = "https://dgekjzkrybrswsxlcbvh.supabase.co";
const S_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRnZWtqemtyeWJyc3dzeGxjYnZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4ODQ3MjIsImV4cCI6MjA4NDQ2MDcyMn0.BsEj53lV3p76yE9fMPTaLn7ocKTNzYPTqIAnBafYItU";
const supabaseClient = supabase.createClient(S_URL, S_KEY, { auth: { persistSession: false } });

// 全体工程表のタスク見出し(parent)を、工程管理者が追う代表工程列にマッピング
// 2000番台以外は parent（見出し）が空/案件固有のため、textKeywords でタスク名から推定する
// 点検案件（D200・4T08・3T13など）は「受入→解体・清掃→検査→報告書」の順で製作より先に進むため、
// 点検専用の4工程は通常12工程より前に並べる。通常の製作案件では該当タスクが存在しないため「―」表示になる
const STAGES = [
    { key: "pmReceive",   label: "受入",         parents: [], textKeywords: ["納入日"], isInspection: true },
    { key: "pmTeardown",  label: "解体・清掃",   parents: [], textKeywords: ["解体"], isInspection: true },
    { key: "pmInspect",   label: "検査",         parents: ["診断"], exactKeywords: ["検査"], isInspection: true },
    { key: "pmReport",    label: "報告書",       parents: [], textKeywords: ["報告書"], isInspection: true },
    { key: "order",       label: "受注",         parents: ["受注"], textKeywords: ["受注日", "受注説明会"] },
    { key: "plan",        label: "計画承認",     parents: ["基本設計＆計画承認"], textKeywords: ["計画設計", "計画図", "客先承認", "外形図", "電気図面設計", "電気図面客先提出"] },
    { key: "longlead",    label: "長納期手配",   parents: ["長納期品手配"], textKeywords: ["長納期"], taskTypes: ["long_lead_item"] },
    { key: "drawing",     label: "出図・手配",   parents: ["出図＆部品手配"], textKeywords: ["出図", "製作品納期", "購入品納期", "部品製作", "部品加工", "神戸送り開始日", "外注支給"], taskTypes: ["drawing"] },
    { key: "electric",    label: "電気設計",     parents: ["電気設計＆電気品手配"], textKeywords: ["最終電気図面", "電気品手配", "電気品納期"] },
    { key: "panel",       label: "盤製作",       parents: ["盤製作"], textKeywords: ["盤組立", "盤製作"] },
    { key: "assembly",    label: "組立",         parents: ["組立全体"], textKeywords: ["機械組立", "電気艤装"] },
    { key: "inspection",  label: "外観検査",     parents: ["外観検査"], textKeywords: ["外観検査", "簡易検査"] },
    { key: "trial",       label: "試運転",       parents: ["試運転"], textKeywords: ["試運転"] },
    { key: "witness",     label: "客先立会",     parents: ["客先立会"], textKeywords: ["客先立会"] },
    { key: "shipmeeting", label: "出荷確認会議", parents: ["出荷確認会議"], textKeywords: ["出荷確認会議"] },
    { key: "shipping",    label: "出荷",         parents: ["出荷"], textKeywords: ["出荷準備", "工場出荷"] },
];
const STAGE_PARENT_MAP = {};
STAGES.forEach(s => s.parents.forEach(p => { STAGE_PARENT_MAP[p] = s.key; }));
const STAGE_TASK_TYPE_MAP = {};
STAGES.forEach(s => (s.taskTypes || []).forEach(tt => { STAGE_TASK_TYPE_MAP[tt] = s.key; }));

// 操業工程表など各部門アプリ独自の内部管理用タスク（担当者名・プログラム/画面等の細目）は
// 12工程・その他のどちらにも該当させず、進捗管理表からは完全に非表示にする
const EXCLUDED_TASK_TYPES = new Set(["operation", "planning", "field_trip", "business_trip"]);

/**
 * parent(見出し)・task_typeで振り分けできないタスクを、タスク名から工程列に推定する。
 * exactKeywords（完全一致）を先に判定するのは、点検専用の「検査」が通常案件の
 * 「外観検査」「簡易検査」に部分一致してしまう（"検査".includes)を防ぐため。
 */
function matchStageByText(text) {
    const t = (text || "").trim();
    for (const s of STAGES) {
        if (s.exactKeywords && s.exactKeywords.includes(t)) return s.key;
    }
    for (const s of STAGES) {
        if (s.textKeywords && s.textKeywords.some(kw => t.includes(kw))) return s.key;
    }
    return null;
}

/**
 * 振り分け優先順位：① parent(見出し) → ② task_type（設計工程表等の部門アプリ由来） → ③ タスク名
 * → ④ どれにも当たらず major_item が「製管」（部品名タスクなど）は長納期手配に含める
 */
function matchStageForTask(task) {
    return STAGE_PARENT_MAP[task.parent] || STAGE_TASK_TYPE_MAP[task.task_type] || matchStageByText(task.text)
        || (task.major_item === "製管" ? "longlead" : null);
}

const STATUS_LABEL = { done: "済", delayed: "遅延", inprogress: "進行中", notstarted: "未着手", none: "—" };

let rawTasks = [];
let completedProjectNumbers = new Set(); // completed_projects に登録済み（＝完了済み）の工事番号
let projectRows = [];
let currentSearch = "";
let currentGroupFilter = "all";   // all | 2000 | 3000 | 4000 | d | other
let currentStatusFilter = "all";  // all | delayed | inprogress | done
let currentSort = "number";       // delay | shipping | number
let showInspectionCols = true;    // 点検専用4列（受入・解体清掃・検査・報告書）の表示/非表示
let expandedSet = new Set();
let refetchTimer = null;
let realtimeChannel = null;

/** トグルの状態に応じて、実際に表の列として出す工程一覧を返す */
function visibleStages() {
    return showInspectionCols ? STAGES : STAGES.filter(s => !s.isInspection);
}
function totalCols() {
    return 8 + visibleStages().length; // トグル + 工事番号 + 客先 + 出荷予定日 + 進捗 + 状態 + 点検列開閉 + 工程列 + その他
}

/** 点検専用4列（受入・解体清掃・検査・報告書）の開閉トグル */
function toggleInspectionColumns() {
    showInspectionCols = !showInspectionCols;
    buildTableHead();
    renderTable();
}
window.toggleInspectionColumns = toggleInspectionColumns;

function pad2(n) { return String(n).padStart(2, "0"); }
function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fmtDate(s) {
    if (!s) return "";
    const parts = String(s).slice(0, 10).split("-");
    if (parts.length !== 3) return s;
    return `${parts[0].slice(2)}/${parts[1]}/${parts[2]}`;
}
function daysDiff(dateStr, base) {
    if (!dateStr) return null;
    const a = new Date(dateStr + "T00:00:00");
    const b = new Date(base + "T00:00:00");
    return Math.round((a - b) / 86400000);
}
function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function fetchAllTasks() {
    const pageSize = 1000;
    let from = 0;
    let out = [];
    while (true) {
        const { data, error } = await supabaseClient
            .from("tasks")
            .select("id, project_number, customer_name, project_details, major_item, machine, unit, text, parent, task_type, owner, main_owner, start_date, end_date, is_completed, status, is_business_trip, is_archived")
            .eq("is_archived", false)
            .or("is_business_trip.is.null,is_business_trip.eq.false")
            .range(from, from + pageSize - 1);
        if (error) throw error;
        out = out.concat(data || []);
        if (!data || data.length < pageSize) break;
        from += pageSize;
    }
    return out;
}

async function fetchCompletedProjectNumbers() {
    const { data, error } = await supabaseClient.from("completed_projects").select("project_number");
    if (error) { console.error(error); return new Set(); }
    return new Set((data || []).map(r => (r.project_number || "").trim()).filter(Boolean));
}

function classifyTask(task, today) {
    if (task.is_completed) return "done";
    if (task.end_date && task.end_date < today) return "delayed";
    if (task.start_date && task.start_date <= today) return "inprogress";
    return "notstarted";
}

function buildProjectRows(tasks) {
    const today = todayStr();
    const map = new Map();

    tasks.forEach(t => {
        const pn = (t.project_number || "").trim();
        if (!pn) return;
        if (completedProjectNumbers.has(pn)) return; // 完了済み（completed_projects登録済み）は対象外
        if (EXCLUDED_TASK_TYPES.has(t.task_type)) return; // 操業工程表など部門アプリ独自の内部タスクは非表示
        if (!map.has(pn)) {
            const stages = {};
            STAGES.forEach(s => { stages[s.key] = []; });
            map.set(pn, { project_number: pn, customer_name: "", project_details: "", stages, otherTasks: [], allTasks: [] });
        }
        const proj = map.get(pn);
        if (!proj.customer_name && t.customer_name) proj.customer_name = t.customer_name;
        if (!proj.project_details && t.project_details) proj.project_details = t.project_details;
        proj.allTasks.push(t);
        const stageKey = matchStageForTask(t);
        if (stageKey) proj.stages[stageKey].push(t);
        else proj.otherTasks.push(t);
    });

    const rows = [];
    map.forEach(proj => {
        let total = 0, done = 0, anyDelayed = false, anyInProgress = false;
        const stageSummaries = {};

        STAGES.forEach(s => {
            const list = proj.stages[s.key];
            if (!list.length) { stageSummaries[s.key] = { status: "none", done: 0, total: 0, tasks: [] }; return; }
            let d = 0, delayed = false, inprog = false;
            list.forEach(t => {
                const st = classifyTask(t, today);
                total++;
                if (st === "done") { d++; done++; }
                else if (st === "delayed") { delayed = true; anyDelayed = true; }
                else if (st === "inprogress") { inprog = true; anyInProgress = true; }
            });
            let status;
            if (d === list.length) status = "done";
            else if (delayed) status = "delayed";
            else if (inprog || d > 0) status = "inprogress";
            else status = "notstarted";
            stageSummaries[s.key] = { status, done: d, total: list.length, tasks: list };
        });

        proj.otherTasks.forEach(t => {
            total++;
            const st = classifyTask(t, today);
            if (st === "done") done++;
            else if (st === "delayed") anyDelayed = true;
            else if (st === "inprogress") anyInProgress = true;
        });

        // 出荷予定日は「工場出荷」というタスク名を持つタスクの終了日を採用する
        // （見出し(parent)が「出荷」以外の案件でも、タスク名で直接拾う）
        const factoryShipTasks = proj.allTasks.filter(t => (t.text || "").includes("工場出荷"));
        let shippingDate = null;
        let shippingDateSource = "confirmed"; // confirmed | ship_task_start | fallback_latest
        factoryShipTasks.forEach(t => { if (t.end_date && (!shippingDate || t.end_date > shippingDate)) shippingDate = t.end_date; });
        if (!shippingDate) {
            // 「工場出荷」タスクはあるが終了日が未設定（データ不備）の場合は、そのタスクの開始日を使う
            shippingDateSource = "ship_task_start";
            factoryShipTasks.forEach(t => { if (t.start_date && (!shippingDate || t.start_date > shippingDate)) shippingDate = t.start_date; });
        }
        if (!shippingDate) {
            // 「工場出荷」タスク自体が登録されていない案件は、登録済みタスクの最終予定日を仮の目安として表示する
            shippingDateSource = "fallback_latest";
            proj.allTasks.forEach(t => { if (t.end_date && (!shippingDate || t.end_date > shippingDate)) shippingDate = t.end_date; });
        }
        const shippingDateIsEstimate = shippingDateSource !== "confirmed";

        const progressPct = total ? Math.round((done / total) * 100) : 0;
        let overall;
        if (anyDelayed) overall = "delayed";
        else if (total > 0 && progressPct === 100) overall = "done";
        else if (done > 0 || anyInProgress) overall = "inprogress";
        else overall = "notstarted";

        const delayedTasks = proj.allTasks.filter(t => classifyTask(t, today) === "delayed")
            .sort((a, b) => (a.end_date || "").localeCompare(b.end_date || ""));
        const inprogressTasks = proj.allTasks.filter(t => classifyTask(t, today) === "inprogress")
            .sort((a, b) => (a.end_date || "").localeCompare(b.end_date || ""));

        rows.push({
            project_number: proj.project_number,
            customer_name: proj.customer_name,
            project_details: proj.project_details,
            stageSummaries,
            otherTasks: proj.otherTasks,
            otherCount: proj.otherTasks.length,
            allTasks: proj.allTasks,
            total, done, progressPct, overall, shippingDate, shippingDateIsEstimate, shippingDateSource,
            delayedTasks, inprogressTasks,
        });
    });

    return rows;
}

function matchesGroupFilter(pn) {
    if (currentGroupFilter === "2000") return /^2/.test(pn);
    if (currentGroupFilter === "3000") return /^3/.test(pn);
    if (currentGroupFilter === "4000") return /^4/.test(pn);
    if (currentGroupFilter === "d") return /^D/i.test(pn);
    if (currentGroupFilter === "other") return !/^[234]/.test(pn) && !/^D/i.test(pn);
    return true;
}

function getFilteredForSummary() {
    return projectRows.filter(r => matchesGroupFilter(r.project_number));
}

function getFilteredForTable() {
    const q = currentSearch.trim().toLowerCase();
    let list = projectRows.filter(r => {
        if (!matchesGroupFilter(r.project_number)) return false;
        if (currentStatusFilter !== "all" && r.overall !== currentStatusFilter) return false;
        if (q) {
            const hay = `${r.project_number} ${r.customer_name} ${r.project_details}`.toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });

    const today = todayStr();
    list.sort((a, b) => {
        if (currentSort === "number") return a.project_number.localeCompare(b.project_number, "ja");
        if (currentSort === "shipping") {
            if (!a.shippingDate && !b.shippingDate) return 0;
            if (!a.shippingDate) return 1;
            if (!b.shippingDate) return -1;
            return a.shippingDate.localeCompare(b.shippingDate);
        }
        // delay: 遅延案件を先頭、その中は出荷日が近い順
        const aDelay = a.overall === "delayed" ? 0 : 1;
        const bDelay = b.overall === "delayed" ? 0 : 1;
        if (aDelay !== bDelay) return aDelay - bDelay;
        if (!a.shippingDate && !b.shippingDate) return 0;
        if (!a.shippingDate) return 1;
        if (!b.shippingDate) return -1;
        return a.shippingDate.localeCompare(b.shippingDate);
    });
    return list;
}

function renderSummary() {
    const scope = getFilteredForSummary();
    const today = todayStr();
    const total = scope.length;
    const delayedCount = scope.filter(r => r.overall === "delayed").length;
    const soonCount = scope.filter(r => {
        if (!r.shippingDate) return false;
        const diff = daysDiff(r.shippingDate, today);
        return diff !== null && diff >= 0 && diff <= 7;
    }).length;
    const avgProgress = total ? Math.round(scope.reduce((sum, r) => sum + r.progressPct, 0) / total) : 0;

    document.getElementById("sum-total").textContent = total;
    document.getElementById("sum-delayed").textContent = delayedCount;
    document.getElementById("sum-soon").textContent = soonCount;
    document.getElementById("sum-avg").textContent = avgProgress + "%";
}

/** 点検専用工程⇔通常工程の切り替わり位置に区切り線を入れるための判定 */
function isStageGroupBoundary(stages, i) {
    if (i === 0) return false;
    return !!(stages[i - 1] && stages[i - 1].isInspection) !== !!stages[i].isInspection;
}

function stageCellHtml(row, stage, isGroupBoundary) {
    const s = row.stageSummaries[stage.key];
    const borderClass = isGroupBoundary ? " stage-group-boundary" : "";
    if (s.status === "none") return `<td class="stage-cell none${borderClass}">—</td>`;
    const text = `${s.done}/${s.total}`;
    const pnEsc = escapeHtml(row.project_number).replace(/'/g, "\\'");
    return `<td class="stage-cell clickable ${s.status}${borderClass}" onclick="showStagePopover(event, '${pnEsc}', '${stage.key}')">${text}</td>`;
}

function otherCellHtml(row) {
    if (!row.otherCount) return `<td class="stage-cell none">—</td>`;
    const pnEsc = escapeHtml(row.project_number).replace(/'/g, "\\'");
    return `<td class="stage-cell clickable notstarted" onclick="showOtherPopover(event, '${pnEsc}')">${row.otherCount}</td>`;
}

/** 工程セル（1/1等）クリックで、その工程内のタスクだけを吹き出しで表示する */
function showStagePopover(evt, pn, stageKey) {
    const row = projectRows.find(r => r.project_number === pn);
    const stage = STAGES.find(s => s.key === stageKey);
    if (!row || !stage) return;
    const s = row.stageSummaries[stageKey];
    showTaskListPopover(evt, `${pn}｜${stage.label}（${s.done}/${s.total}）`, s.tasks);
}

/** 「その他」セルクリックで、12工程に分類されないタスクを吹き出しで表示する */
function showOtherPopover(evt, pn) {
    const row = projectRows.find(r => r.project_number === pn);
    if (!row) return;
    showTaskListPopover(evt, `${pn}｜その他（${row.otherCount}件）`, row.otherTasks);
}

/** 汎用：クリックされたセルの下にタスク一覧の吹き出しを表示する */
function showTaskListPopover(evt, headerText, taskList) {
    evt.stopPropagation();
    const today = todayStr();
    const STATUS_ORDER = { delayed: 0, inprogress: 1, notstarted: 2, done: 3 };
    const tasks = (taskList || []).slice().sort((a, b) => {
        const stA = classifyTask(a, today), stB = classifyTask(b, today);
        if (STATUS_ORDER[stA] !== STATUS_ORDER[stB]) return STATUS_ORDER[stA] - STATUS_ORDER[stB];
        return (a.end_date || "").localeCompare(b.end_date || "");
    });

    const itemsHtml = tasks.length ? tasks.map(t => {
        const st = classifyTask(t, today);
        return `<li>
            <span class="sp-status ${st}">${STATUS_LABEL[st]}</span>
            <span class="sp-body">
                <div class="sp-name">${escapeHtml(t.text || "")}</div>
                <div class="sp-meta">${escapeHtml(t.owner || "担当未定")}${t.end_date ? " ／ 期限 " + fmtDate(t.end_date) : ""}</div>
            </span>
        </li>`;
    }).join("") : `<div class="sp-empty">タスクがありません</div>`;

    const popover = document.getElementById("stage-popover");
    popover.innerHTML = `
        <div class="sp-header">
            <span>${escapeHtml(headerText)}</span>
            <span class="sp-close" onclick="closeStagePopover()">✕</span>
        </div>
        <ul>${itemsHtml}</ul>
    `;

    const cell = evt.currentTarget;
    const rect = cell.getBoundingClientRect();
    popover.classList.add("visible");
    const popRect = popover.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
    if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 4;
    popover.style.left = Math.max(8, left) + "px";
    popover.style.top = Math.max(8, top) + "px";
}

function closeStagePopover() {
    document.getElementById("stage-popover").classList.remove("visible");
}
window.showStagePopover = showStagePopover;
window.showOtherPopover = showOtherPopover;
window.closeStagePopover = closeStagePopover;

/** タスク行にマウスを乗せた際、変更履歴を独自の吹き出し（#history-tip）で表示する（title属性のネイティブツールチップは文字サイズ・フォントを変更できないため） */
function showHistoryTip(evt) {
    const text = evt.currentTarget.dataset.history;
    if (!text) return;
    const tip = document.getElementById("history-tip");
    tip.textContent = text;
    tip.classList.add("visible");
    const tipRect = tip.getBoundingClientRect();
    let left = evt.clientX + 12;
    let top = evt.clientY + 12;
    if (left + tipRect.width > window.innerWidth - 8) left = evt.clientX - tipRect.width - 12;
    if (top + tipRect.height > window.innerHeight - 8) top = evt.clientY - tipRect.height - 12;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = Math.max(8, top) + "px";
}
function hideHistoryTip() {
    document.getElementById("history-tip").classList.remove("visible");
}
window.showHistoryTip = showHistoryTip;
window.hideHistoryTip = hideHistoryTip;

document.addEventListener("click", (e) => {
    const popover = document.getElementById("stage-popover");
    if (popover.classList.contains("visible") && !popover.contains(e.target)) closeStagePopover();
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeStagePopover();
});

// 案件の変更履歴（change_log）：project_number単位でキャッシュ（"loading"中は読み込み中を表す）
let changeLogCache = new Map();

async function ensureChangeLogLoaded(pn) {
    if (changeLogCache.has(pn)) return;
    changeLogCache.set(pn, "loading");
    try {
        const { data, error } = await supabaseClient
            .from("change_log")
            .select("task_text, machine, unit, description, changed_by, changed_at")
            .eq("project_number", pn)
            .order("changed_at", { ascending: false })
            .limit(500);
        if (error) throw error;
        changeLogCache.set(pn, data || []);
    } catch (e) {
        console.error(e);
        changeLogCache.set(pn, []);
    }
    if (expandedSet.has(pn)) renderTable();
}

/** タスク名（＋machine/unitが両方入っている場合はそれも）で変更履歴を突き合わせる */
function getChangeHistoryForTask(pn, task) {
    const log = changeLogCache.get(pn);
    if (!log || log === "loading") return null;
    const targetText = (task.text || "").trim();
    const targetMachine = (task.machine || "").trim();
    const targetUnit = (task.unit || "").trim();
    return log.filter(l => {
        if ((l.task_text || "").trim() !== targetText) return false;
        const lm = (l.machine || "").trim(), lu = (l.unit || "").trim();
        if (targetMachine && lm && lm !== targetMachine) return false;
        if (targetUnit && lu && lu !== targetUnit) return false;
        return true;
    }).slice(0, 5);
}

function fmtDateTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const EXPAND_STATUS_COLUMNS = [
    { key: "delayed",    label: "遅延" },
    { key: "inprogress", label: "進行中" },
    { key: "notstarted", label: "未着手" },
    { key: "done",       label: "完了" },
];

function expandPanelHtml(row) {
    const today = todayStr();
    const pn = row.project_number;
    const logState = changeLogCache.get(pn);
    const logLoading = logState === "loading" || logState === undefined;

    // 状態（遅延・進行中・未着手・完了）ごとにグループ化。グループ内は終了日が近い順
    const buckets = { delayed: [], inprogress: [], notstarted: [], done: [] };
    row.allTasks.forEach(t => buckets[classifyTask(t, today)].push(t));
    Object.values(buckets).forEach(list => list.sort((a, b) => (a.end_date || "").localeCompare(b.end_date || "")));

    function taskRowHtml(t) {
        let historyTitle;
        if (logLoading) {
            historyTitle = "変更履歴を読み込み中...";
        } else {
            const hist = getChangeHistoryForTask(pn, t) || [];
            historyTitle = hist.length
                ? "変更履歴：\n" + hist.map(h => `${fmtDateTime(h.changed_at)} ${h.changed_by || "?"}：${h.description || ""}`).join("\n")
                : "変更履歴はありません";
        }
        return `<tr data-history="${escapeHtml(historyTitle)}" onmouseenter="showHistoryTip(event)" onmouseleave="hideHistoryTip()">
            <td class="col-name">${escapeHtml(t.text || "")}</td>
            <td class="col-machine">${escapeHtml(t.machine || "")}</td>
            <td class="col-unit">${escapeHtml(t.unit || "")}</td>
            <td class="col-owner">${escapeHtml(t.owner || "担当未定")}</td>
            <td class="col-start">${t.start_date ? fmtDate(t.start_date) : ""}</td>
            <td class="col-end">${t.end_date ? fmtDate(t.end_date) : ""}</td>
        </tr>`;
    }

    const colsHtml = EXPAND_STATUS_COLUMNS.map(col => {
        const tasks = buckets[col.key];
        const bodyHtml = tasks.length
            ? tasks.map(taskRowHtml).join("")
            : `<tr><td colspan="6" class="expand-empty">タスクはありません</td></tr>`;
        return `<div class="status-col">
            <div class="status-col-head st-${col.key}">${col.label}（${tasks.length}）</div>
            <div class="status-col-body">
                <table class="mini-task-table">
                    <colgroup><col class="col-name"><col class="col-machine"><col class="col-unit"><col class="col-owner"><col class="col-start"><col class="col-end"></colgroup>
                    <thead><tr><th class="col-name">タスク名</th><th class="col-machine">機械</th><th class="col-unit">ユニット</th><th class="col-owner">担当者</th><th class="col-start">開始日</th><th class="col-end">終了日</th></tr></thead>
                    <tbody>${bodyHtml}</tbody>
                </table>
            </div>
        </div>`;
    }).join("");

    return `
        <div class="task-list-hint">${logLoading ? "変更履歴を読み込み中です…" : "行にマウスを乗せると、そのタスクの変更履歴が表示されます"}</div>
        <div class="status-cols">${colsHtml}</div>`;
}

function renderTable() {
    const list = getFilteredForTable();
    const tbody = document.getElementById("progress-tbody");
    const stages = visibleStages();
    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="${totalCols()}"><div class="empty-state">条件に一致する案件がありません</div></td></tr>`;
        return;
    }
    const today = todayStr();
    let html = "";
    list.forEach(row => {
        const shipDiff = row.shippingDate ? daysDiff(row.shippingDate, today) : null;
        const shipClass = shipDiff !== null && shipDiff < 0 ? "overdue" : (shipDiff !== null && shipDiff <= 7 ? "soon" : "");
        const isExpanded = expandedSet.has(row.project_number);
        const barClass = row.overall === "done" ? "is-done" : (row.overall === "delayed" ? "is-delayed" : "");

        const SHIP_TITLES = {
            confirmed: "出荷（工場出荷）予定日",
            ship_task_start: "「工場出荷」タスクの終了日が未設定のため、開始日を仮の目安として表示しています（全体工程表側でのデータ修正を推奨）",
            fallback_latest: "「工場出荷」タスクが未登録の案件のため、登録済みタスクの最終予定日を仮の目安として表示しています",
        };
        const shipTitle = SHIP_TITLES[row.shippingDateSource] || SHIP_TITLES.confirmed;
        const shipText = row.shippingDate
            ? (row.shippingDateIsEstimate ? "～" + fmtDate(row.shippingDate) : fmtDate(row.shippingDate))
            : "未定";

        html += `<tr class="${row.overall === "delayed" ? "row-delayed" : ""}" data-pn="${escapeHtml(row.project_number)}">
            <td class="col-toggle expand-toggle" onclick="toggleExpand('${escapeHtml(row.project_number).replace(/'/g, "\\'")}')">${isExpanded ? "▲" : "▼"}</td>
            <td class="col-num">${escapeHtml(row.project_number)}</td>
            <td class="col-customer">
                <div class="customer-name">${escapeHtml(row.customer_name || "（客先未設定）")}</div>
                <div class="project-details">${escapeHtml(row.project_details || "")}</div>
            </td>
            <td class="ship-date ${shipClass}" title="${shipTitle}">${shipText}</td>
            <td>
                <div class="progress-cell">
                    <div class="progress-bar-bg"><div class="progress-bar-fill ${barClass}" style="width:${row.progressPct}%;"></div></div>
                    <span class="progress-pct">${row.progressPct}%</span>
                </div>
            </td>
            <td style="text-align:center;"><span class="status-badge ${row.overall}">${STATUS_LABEL[row.overall]}</span></td>
            <td class="col-stage-toggle" onclick="toggleInspectionColumns()"></td>
            ${stages.map((s, i) => stageCellHtml(row, s, isStageGroupBoundary(stages, i))).join("")}
            ${otherCellHtml(row)}
        </tr>`;
        if (isExpanded) {
            html += `<tr class="expand-row"><td colspan="${totalCols()}">${expandPanelHtml(row)}</td></tr>`;
        }
    });
    tbody.innerHTML = html;
}

function toggleExpand(pn) {
    if (expandedSet.has(pn)) {
        expandedSet.delete(pn);
    } else {
        expandedSet.add(pn);
        ensureChangeLogLoaded(pn);
    }
    renderTable();
}
window.toggleExpand = toggleExpand;

function renderAll() {
    renderSummary();
    renderTable();
}

function setSyncStatus(ok, message) {
    const dot = document.getElementById("sync-dot");
    const label = document.getElementById("sync-label");
    dot.classList.toggle("offline", !ok);
    label.textContent = message;
}

async function loadAndRender(isInitial) {
    try {
        setSyncStatus(true, isInitial ? "読み込み中..." : "更新中...");
        const [tasks, completedSet] = await Promise.all([fetchAllTasks(), fetchCompletedProjectNumbers()]);
        rawTasks = tasks;
        completedProjectNumbers = completedSet;
        projectRows = buildProjectRows(rawTasks);
        renderAll();
        const now = new Date();
        setSyncStatus(true, `最終更新 ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`);
    } catch (e) {
        console.error(e);
        setSyncStatus(false, "取得に失敗しました（通信を確認してください）");
    } finally {
        document.getElementById("loading-overlay").classList.add("hidden");
    }
}

function scheduleRefetch() {
    if (refetchTimer) clearTimeout(refetchTimer);
    refetchTimer = setTimeout(() => loadAndRender(false), 700);
}

function setupRealtime() {
    realtimeChannel = supabaseClient
        .channel("progress-tasks-changes")
        .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, () => {
            scheduleRefetch();
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "completed_projects" }, () => {
            scheduleRefetch();
        })
        .subscribe();
}

function setupUiEvents() {
    document.getElementById("refresh-btn").addEventListener("click", () => loadAndRender(false));

    document.getElementById("search-input").addEventListener("input", (e) => {
        currentSearch = e.target.value;
        renderTable();
    });

    document.querySelectorAll("[data-group-filter]").forEach(btn => {
        btn.addEventListener("click", () => {
            currentGroupFilter = btn.getAttribute("data-group-filter");
            document.querySelectorAll("[data-group-filter]").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            renderAll();
        });
    });

    document.querySelectorAll("[data-status-filter]").forEach(btn => {
        btn.addEventListener("click", () => {
            currentStatusFilter = btn.getAttribute("data-status-filter");
            document.querySelectorAll("[data-status-filter]").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            renderTable();
        });
    });

    document.querySelectorAll("[data-sort]").forEach(btn => {
        btn.addEventListener("click", () => {
            currentSort = btn.getAttribute("data-sort");
            document.querySelectorAll("[data-sort]").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            renderTable();
        });
    });
}

function buildTableHead() {
    const thead = document.getElementById("progress-thead-row");
    const stages = visibleStages();
    let html = `
        <th class="col-toggle" style="width:28px;" title="クリックで詳細（遅延・進行中タスク一覧）を開閉"></th>
        <th class="col-num" style="width:60px;">工事番号</th>
        <th class="col-customer" style="width:340px;">客先／工事名</th>
        <th style="width:80px;">出荷予定日</th>
        <th style="width:110px;">進捗</th>
        <th style="width:64px;">状態</th>
        <th class="col-stage-toggle" style="width:20px;" title="点検専用列（受入・解体清掃・検査・報告書）の開閉" onclick="toggleInspectionColumns()">${showInspectionCols ? "▼" : "▶"}</th>
        ${stages.map((s, i) => `<th class="stage-head${s.isInspection ? " stage-head-inspect" : ""}${isStageGroupBoundary(stages, i) ? " stage-group-boundary" : ""}"${s.isInspection ? ' style="width:64px;"' : ""} title="${s.isInspection ? "点検案件専用の工程列" : ""}">${s.label}</th>`).join("")}
        <th style="width:50px;">その他</th>
    `;
    thead.innerHTML = html;
}

document.addEventListener("DOMContentLoaded", () => {
    buildTableHead();
    setupUiEvents();
    loadAndRender(true);
    setupRealtime();
});

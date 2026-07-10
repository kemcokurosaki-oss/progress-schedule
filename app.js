// 進捗管理表：全体工程表と同じ Supabase(tasks テーブル)を参照する閲覧専用アプリ
// 認証なし・読み取り専用（tasks_select_public_read ポリシーにより anon で SELECT 可能）
const S_URL = "https://dgekjzkrybrswsxlcbvh.supabase.co";
const S_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRnZWtqemtyeWJyc3dzeGxjYnZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4ODQ3MjIsImV4cCI6MjA4NDQ2MDcyMn0.BsEj53lV3p76yE9fMPTaLn7ocKTNzYPTqIAnBafYItU";
const supabaseClient = supabase.createClient(S_URL, S_KEY, { auth: { persistSession: false } });

// 全体工程表のタスク見出し(parent)を、工程管理者が追う代表工程列にマッピング
const STAGES = [
    { key: "order",       label: "受注",         parents: ["受注"] },
    { key: "plan",        label: "計画承認",     parents: ["基本設計＆計画承認"] },
    { key: "longlead",    label: "長納期手配",   parents: ["長納期品手配"] },
    { key: "drawing",     label: "出図・手配",   parents: ["出図＆部品手配"] },
    { key: "electric",    label: "電気設計",     parents: ["電気設計＆電気品手配"] },
    { key: "panel",       label: "盤製作",       parents: ["盤製作"] },
    { key: "assembly",    label: "組立",         parents: ["組立全体"] },
    { key: "inspection",  label: "外観検査",     parents: ["外観検査"] },
    { key: "trial",       label: "試運転",       parents: ["試運転"] },
    { key: "witness",     label: "客先立会",     parents: ["客先立会"] },
    { key: "shipmeeting", label: "出荷確認会議", parents: ["出荷確認会議"] },
    { key: "shipping",    label: "出荷",         parents: ["出荷"] },
];
const STAGE_PARENT_MAP = {};
STAGES.forEach(s => s.parents.forEach(p => { STAGE_PARENT_MAP[p] = s.key; }));

const STATUS_LABEL = { done: "済", delayed: "遅延", inprogress: "進行中", notstarted: "未着手", none: "—" };

let rawTasks = [];
let projectRows = [];
let currentSearch = "";
let currentGroupFilter = "all";   // all | 2000 | other
let currentStatusFilter = "all";  // all | delayed | inprogress | done
let currentSort = "delay";        // delay | shipping | number
let expandedSet = new Set();
let refetchTimer = null;
let realtimeChannel = null;

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
            .select("id, project_number, customer_name, project_details, major_item, machine, unit, text, parent, owner, main_owner, start_date, end_date, is_completed, status, is_business_trip, is_archived")
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
        if (!map.has(pn)) {
            const stages = {};
            STAGES.forEach(s => { stages[s.key] = []; });
            map.set(pn, { project_number: pn, customer_name: "", project_details: "", stages, otherTasks: [], allTasks: [] });
        }
        const proj = map.get(pn);
        if (!proj.customer_name && t.customer_name) proj.customer_name = t.customer_name;
        if (!proj.project_details && t.project_details) proj.project_details = t.project_details;
        proj.allTasks.push(t);
        const stageKey = STAGE_PARENT_MAP[t.parent];
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

        const shippingTasks = proj.stages["shipping"];
        const factoryShip = shippingTasks.filter(t => (t.text || "").includes("工場出荷"));
        const dateSource = factoryShip.length ? factoryShip : shippingTasks;
        let shippingDate = null;
        dateSource.forEach(t => { if (t.end_date && (!shippingDate || t.end_date > shippingDate)) shippingDate = t.end_date; });

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
            otherCount: proj.otherTasks.length,
            total, done, progressPct, overall, shippingDate,
            delayedTasks, inprogressTasks,
        });
    });

    return rows;
}

function matchesGroupFilter(pn) {
    if (currentGroupFilter === "2000") return /^2/.test(pn);
    if (currentGroupFilter === "other") return !/^2/.test(pn);
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

function stageCellHtml(row, stage) {
    const s = row.stageSummaries[stage.key];
    if (s.status === "none") return `<td class="stage-cell none" title="該当タスクなし">—</td>`;
    const label = STATUS_LABEL[s.status];
    let text = `${s.done}/${s.total}`;
    const titleLines = s.tasks.map(t => {
        const st = classifyTask(t, todayStr());
        return `${t.text || ""}（${t.owner || "担当未定"}）: ${STATUS_LABEL[st]}${t.end_date ? " / " + fmtDate(t.end_date) : ""}`;
    }).join("\n");
    return `<td class="stage-cell ${s.status}" title="${escapeHtml(`${stage.label}：${label}\n` + titleLines)}">${text}</td>`;
}

function expandPanelHtml(row) {
    const today = todayStr();
    const delayedHtml = row.delayedTasks.length
        ? `<ul>${row.delayedTasks.map(t => `<li><span class="tag">${escapeHtml(t.major_item || "")}</span>${escapeHtml(t.text || "")} ー ${escapeHtml(t.owner || "担当未定")}（期限 ${fmtDate(t.end_date)} / ${Math.abs(daysDiff(t.end_date, today))}日超過）</li>`).join("")}</ul>`
        : `<div class="expand-empty">遅延中のタスクはありません</div>`;
    const inprogHtml = row.inprogressTasks.length
        ? `<ul>${row.inprogressTasks.slice(0, 12).map(t => `<li><span class="tag">${escapeHtml(t.major_item || "")}</span>${escapeHtml(t.text || "")} ー ${escapeHtml(t.owner || "担当未定")}（〜${fmtDate(t.end_date)}）</li>`).join("")}${row.inprogressTasks.length > 12 ? `<li class="expand-empty">他 ${row.inprogressTasks.length - 12} 件…</li>` : ""}</ul>`
        : `<div class="expand-empty">進行中のタスクはありません</div>`;
    return `
        <div class="expand-panel">
            <div class="expand-col" style="flex:1; min-width:280px;">
                <h4>⚠ 遅延中のタスク（${row.delayedTasks.length}件）</h4>
                ${delayedHtml}
            </div>
            <div class="expand-col" style="flex:1; min-width:280px;">
                <h4>▶ 進行中のタスク（${row.inprogressTasks.length}件）</h4>
                ${inprogHtml}
            </div>
        </div>`;
}

function renderTable() {
    const list = getFilteredForTable();
    const tbody = document.getElementById("progress-tbody");
    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="${5 + STAGES.length + 1}"><div class="empty-state">条件に一致する案件がありません</div></td></tr>`;
        return;
    }
    const today = todayStr();
    let html = "";
    list.forEach(row => {
        const shipDiff = row.shippingDate ? daysDiff(row.shippingDate, today) : null;
        const shipClass = shipDiff !== null && shipDiff < 0 ? "overdue" : (shipDiff !== null && shipDiff <= 7 ? "soon" : "");
        const isExpanded = expandedSet.has(row.project_number);
        const barClass = row.overall === "done" ? "is-done" : (row.overall === "delayed" ? "is-delayed" : "");

        html += `<tr class="${row.overall === "delayed" ? "row-delayed" : ""}" data-pn="${escapeHtml(row.project_number)}">
            <td class="col-num">${escapeHtml(row.project_number)}</td>
            <td class="col-customer">
                <div class="customer-name">${escapeHtml(row.customer_name || "（客先未設定）")}</div>
                <div class="project-details">${escapeHtml(row.project_details || "")}</div>
            </td>
            <td class="ship-date ${shipClass}">${row.shippingDate ? fmtDate(row.shippingDate) : "未定"}</td>
            <td>
                <div class="progress-cell">
                    <div class="progress-bar-bg"><div class="progress-bar-fill ${barClass}" style="width:${row.progressPct}%;"></div></div>
                    <span class="progress-pct">${row.progressPct}%</span>
                </div>
            </td>
            <td style="text-align:center;"><span class="status-badge ${row.overall}">${STATUS_LABEL[row.overall]}</span></td>
            ${STAGES.map(s => stageCellHtml(row, s)).join("")}
            <td class="stage-cell none" title="上記12工程に分類されないタスク ${row.otherCount}件">${row.otherCount ? row.otherCount : "—"}</td>
            <td class="expand-toggle" onclick="toggleExpand('${escapeHtml(row.project_number).replace(/'/g, "\\'")}')">${isExpanded ? "▲" : "▼"}</td>
        </tr>`;
        if (isExpanded) {
            html += `<tr class="expand-row"><td colspan="${5 + STAGES.length + 1}">${expandPanelHtml(row)}</td></tr>`;
        }
    });
    tbody.innerHTML = html;
}

function toggleExpand(pn) {
    if (expandedSet.has(pn)) expandedSet.delete(pn); else expandedSet.add(pn);
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
        rawTasks = await fetchAllTasks();
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
    let html = `
        <th class="col-num" style="min-width:60px;">工事番号</th>
        <th class="col-customer" style="min-width:160px;">客先／工事名</th>
        <th style="min-width:80px;">出荷予定日</th>
        <th style="min-width:110px;">進捗</th>
        <th style="min-width:64px;">状態</th>
        ${STAGES.map(s => `<th class="stage-head">${s.label}</th>`).join("")}
        <th style="min-width:50px;">その他</th>
        <th style="min-width:24px;"></th>
    `;
    thead.innerHTML = html;
}

document.addEventListener("DOMContentLoaded", () => {
    buildTableHead();
    setupUiEvents();
    loadAndRender(true);
    setupRealtime();
});

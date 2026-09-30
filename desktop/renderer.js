const state = { settings: null, stats: null, events: [] };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 2600);
}

function formatDuration(seconds = 0) {
  const minutes = Math.round(Number(seconds) / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusLabel(status) { return { pending: '待确认', approved: '已确认', rejected: '已忽略' }[status] || status; }

function renderMetrics() {
  $('#metric-events').textContent = state.stats.total;
  $('#metric-pending').textContent = state.stats.pending;
  $('#metric-duration').textContent = formatDuration(state.stats.duration);
  $('#metric-focus').textContent = state.stats.topics[0]?.category || '个人成长';
}

function renderEvents(target = '#event-list', list = state.events) {
  const node = $(target);
  if (!list.length) { node.innerHTML = '<div class="empty-state"><strong>还没有符合条件的事件</strong><span>开始记录或手动添加一条工作事件，Sydney 会在确认后继续整理。</span></div>'; return; }
  node.innerHTML = list.map(event => `<article class="event-row" data-id="${event.id}">
    <time class="event-time">${escapeHtml(new Date(event.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))}</time>
    <div class="event-body"><div class="event-title"><strong>${escapeHtml(event.note || event.window_title || '活动采样')}</strong><span class="tag">${escapeHtml(event.category || '个人成长')}</span><small>${escapeHtml(event.app_name || '手动记录')}</small></div><div class="event-meta">${escapeHtml(event.summary || event.window_title || `${event.kind === 'activity' ? '活动采样' : '手动记录'} · ${formatDuration(event.duration_seconds)}`)}</div></div>
    <div class="event-actions"><span class="status status-${escapeHtml(event.status)}">${statusLabel(event.status)}</span>${event.status === 'pending' ? `<button data-action="draft" title="生成整理草稿">整理</button><button data-action="approve" title="确认事件">确认</button><button data-action="reject" title="忽略事件">忽略</button>` : ''}<button data-action="delete" title="删除事件">删除</button></div>
  </article>`).join('');
  node.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => {
    const id = Number(button.closest('.event-row').dataset.id);
    const action = button.dataset.action;
    if (action === 'delete') await window.sydney.deleteEvent(id);
    if (action === 'draft') { await window.sydney.draftEvent(id); toast('已生成整理草稿'); }
    if (action === 'approve') await window.sydney.updateEvent(id, { status: 'approved', value_score: 1 });
    if (action === 'reject') await window.sydney.updateEvent(id, { status: 'rejected' });
    await refresh();
  }));
}

function filteredEvents() {
  const status = $('#status-filter').value;
  const query = $('#event-search').value.trim().toLowerCase();
  return state.events.filter(event => (status === 'all' || event.status === status) && (!query || `${event.note} ${event.app_name} ${event.window_title}`.toLowerCase().includes(query)));
}

function updateCaptureUi(enabled) {
  $('#capture-strip').classList.toggle('is-live', enabled);
  $('#capture-title').textContent = enabled ? '正在记录' : '记录已暂停';
  $('#capture-detail').textContent = enabled ? '只保存允许应用的活动摘要，不记录键盘输入。' : '开始记录后才会采集应用和窗口标题。';
  $('#capture-toggle').textContent = enabled ? '停止记录' : '开始记录';
  $('#pause-capture').textContent = enabled ? '暂停' : '继续';
}

async function refresh() {
  const next = await window.sydney.getState();
  Object.assign(state, next);
  renderMetrics();
  renderEvents('#event-list', filteredEvents());
  renderEvents('#review-list', state.events.filter(event => event.status === 'pending'));
  updateCaptureUi(state.settings.captureEnabled);
  $('#allowed-apps').value = state.settings.allowedApps.join('\n');
  $('#blocked-apps').value = state.settings.blockedApps.join('\n');
  $('#capture-interval').value = state.settings.captureIntervalSeconds;
  $('#retention-hours').value = state.settings.retentionHours || 48;
  $('#screen-sampling').checked = Boolean(state.settings.screenSamplingEnabled);
  $('#watch-input-files').checked = state.settings.watchInputFiles !== false;
  $('#auto-write').checked = Boolean(state.settings.autoWriteObsidian);
  $('#cloud-url').value = state.settings.cloudUrl || '';
  $('#cloud-sync').checked = Boolean(state.settings.cloudSyncEnabled);
}

function showView(view) {
  $$('.view').forEach(node => node.classList.toggle('hidden', node.id !== `view-${view}`));
  $$('.nav-item').forEach(node => node.classList.toggle('active', node.dataset.view === view));
  $('#page-title').textContent = { today: '今日工作', review: '待确认事件', knowledge: '知识沉淀', ideas: '内容灵感', settings: '隐私与设置' }[view];
  if (view === 'ideas') renderIdeas();
}

function renderIdeas() {
  const ideas = state.events.filter(event => event.status === 'approved' && (event.value_score >= 1 || event.category === '内容资产')).slice(0, 8);
  $('#idea-grid').innerHTML = ideas.length ? ideas.map(event => `<article class="idea"><h3>${escapeHtml(event.note || event.summary || event.window_title || '未命名经验')}</h3><p>建议方向：把「${escapeHtml(event.category)}」中的具体问题、过程和结果，整理成一条短视频或一篇公众号案例。</p></article>`).join('') : '<div class="empty-state"><strong>还没有可用的内容素材</strong><span>先确认一条高价值事件，内容灵感会从你的真实工作里出现。</span></div>';
}

async function openRecordDialog() {
  const dialog = $('#record-dialog');
  $('#record-note').value = '';
  if (dialog.showModal) dialog.showModal();
}

$('#record-form').addEventListener('submit', async event => {
  event.preventDefault();
  await window.sydney.createEvent({ note: $('#record-note').value.trim(), category: $('#record-category').value, value_score: Number($('#record-score').value), status: 'pending', kind: 'manual' });
  $('#record-dialog').close();
  toast('事件已保存，等待你的确认');
  await refresh();
});

$('#manual-record').addEventListener('click', openRecordDialog);
$('#capture-toggle').addEventListener('click', async () => { await window.sydney.setCapture(!state.settings.captureEnabled); await refresh(); });
$('#pause-capture').addEventListener('click', async () => { await window.sydney.setCapture(!state.settings.captureEnabled); await refresh(); });
$('#status-filter').addEventListener('change', () => renderEvents('#event-list', filteredEvents()));
$('#event-search').addEventListener('input', () => renderEvents('#event-list', filteredEvents()));
$$('.nav-item').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));

$('#save-settings').addEventListener('click', async () => {
  await window.sydney.saveSettings({ allowedApps: $('#allowed-apps').value.split(/\r?\n/).map(item => item.trim()).filter(Boolean), blockedApps: $('#blocked-apps').value.split(/\r?\n/).map(item => item.trim()).filter(Boolean), captureIntervalSeconds: Math.max(10, Number($('#capture-interval').value) || 30), retentionHours: Math.max(1, Number($('#retention-hours').value) || 48), screenSamplingEnabled: $('#screen-sampling').checked, watchInputFiles: $('#watch-input-files').checked, autoWriteObsidian: $('#auto-write').checked, cloudUrl: $('#cloud-url').value.trim(), cloudSyncEnabled: $('#cloud-sync').checked });
  toast('设置已保存');
  await refresh();
});

$$('[data-summary]').forEach(button => button.addEventListener('click', async () => { const result = await window.sydney.generateSummary(button.dataset.summary); toast(`已写入 ${result.target}`); }));
$('#pick-file').addEventListener('click', async () => { const files = await window.sydney.pickFiles(); if (files.length) { await window.sydney.createEvent({ note: `关联文件：${files.map(file => file.split('\\').pop()).join('、')}`, file_path: files.join('\n'), kind: 'file', category: 'AI 工具', status: 'pending' }); await refresh(); toast(`已关联 ${files.length} 个文件`); } });
$('#generate-content').addEventListener('click', () => { showView('ideas'); toast('选题草稿已根据已确认事件刷新'); });
$('#generate-workflow').addEventListener('click', async () => { const result = await window.sydney.generateWorkflow(); toast(`已写入工作流候选，关联 ${result.count} 条事件`); });
$('#capture-window').addEventListener('click', async () => { const target = await window.sydney.captureScreenshot(); toast(`截图已保存：${target.split('\\').pop()}`); });
$('#sync-cloud').addEventListener('click', async () => { try { const result = await window.sydney.syncApproved(); toast(result.skipped ? '请先在设置中开启云端同步' : `已同步 ${result.synced} 条已确认事件`); } catch (error) { toast(error.message || '同步失败'); } });
$('#open-vault').addEventListener('click', () => window.sydney.openFile(state.settings.vaultPath));
window.sydney.onEventsChanged(refresh);
window.sydney.onCaptureChanged(value => updateCaptureUi(value.enabled));
$('#today-label').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
refresh();

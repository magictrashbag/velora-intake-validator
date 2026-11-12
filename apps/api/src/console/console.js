// Review console. SECURITY: every value from the API is rendered with textContent / DOM nodes,
// never innerHTML — customer-controlled strings (names, notes, addresses) appear here.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let token = sessionStorage.getItem('staffToken') || '';
  let current = null;

  function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = String(text); if (cls) e.className = cls; return e; }

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { authorization: 'Bearer ' + token, ...(opts.body ? { 'content-type': 'application/json' } : {}) } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { signOut(); throw new Error('Session expired — sign in again'); }
    return { status: res.status, body };
  }

  function signedIn(on) { $('login').hidden = on; $('logout').hidden = !on; $('list').hidden = !on; if (!on) $('detail').hidden = true; }
  function signOut() { token = ''; sessionStorage.removeItem('staffToken'); signedIn(false); }

  async function loadCases() {
    const s = $('status').value;
    const { body } = await api('/v1/staff/cases' + (s ? '?status=' + encodeURIComponent(s) : ''));
    const tbody = $('cases'); tbody.replaceChildren();
    const cases = body.cases || [];
    $('empty').hidden = cases.length > 0;
    for (const c of cases) {
      const tr = document.createElement('tr');
      tr.append(el('td', new Date(c.opened_at).toLocaleString()), el('td', c.subject_type), el('td', c.status));
      const r = el('td'); for (const x of c.reasons) r.append(el('span', x, 'pill')); tr.append(r);
      tr.append(el('td', `${c.phone} · tier ${c.kyc_tier} · ${c.screening} · ${c.country}`));
      tr.addEventListener('click', () => { document.querySelectorAll('tbody tr').forEach((t) => t.classList.remove('sel')); tr.classList.add('sel'); openCase(c.id); });
      tbody.append(tr);
    }
  }

  function kv(obj) {
    const dl = el('dl', null, 'kv');
    for (const [k, v] of Object.entries(obj || {})) {
      dl.append(el('dt', k));
      const dd = el('dd');
      if (v && typeof v === 'object') dd.append(el('pre', JSON.stringify(v, null, 2))); else dd.textContent = v == null ? '—' : String(v);
      dl.append(dd);
    }
    return dl;
  }

  async function openCase(id, keepResult = false) {
    const { body } = await api('/v1/staff/cases/' + encodeURIComponent(id));
    current = id;
    $('detail').hidden = false;
    $('d-title').textContent = `${body.case.subject_type} case · ${body.case.status}`;
    const live = ['open', 'awaiting_second_approval'].includes(body.case.status);
    document.querySelectorAll('#detail [data-action], #note').forEach((x) => { x.disabled = !live; });
    const d = $('d-body'); d.replaceChildren();
    d.append(el('h3', 'Case'), kv({ id: body.case.id, reasons: body.case.reasons.join(', '), opened: body.case.opened_at }));
    d.append(el('h3', 'Subject'), kv(body.subject));
    d.append(el('h3', `Compliance decisions (${body.decisions.length})`));
    for (const x of body.decisions) d.append(kv({ at: x.created_at, outcome: x.outcome, reasons: x.reasons.join(', ') || '—', policy: x.policy_version }));
    d.append(el('h3', `Staff actions (${body.actions.length})`));
    for (const a of body.actions) d.append(el('p', `${new Date(a.created_at).toLocaleString()} · ${a.email} · ${a.action}: ${a.note}`));
    if (!keepResult) { $('result').textContent = ''; $('note').value = ''; }
  }

  async function act(action) {
    if (!current) return;
    const { status, body } = await api(`/v1/staff/cases/${encodeURIComponent(current)}/${action}`, { method: 'POST', body: JSON.stringify({ note: $('note').value }) });
    const r = $('result');
    if (status === 200) { r.className = 'ok'; r.textContent = `Done: ${body.status}${body.executed ? ' (executed)' : ''}`; }
    else if (body.refused_reasons) { r.className = 'err'; r.textContent = 'Execution refused — gate now says: ' + body.refused_reasons.join(', '); }
    else { r.className = 'err'; r.textContent = `${body.error || 'error'}${body.message ? ': ' + body.message : ''}`; }
    if (status === 200) $('note').value = '';
    await loadCases(); await openCase(current, true);
  }

  $('login').addEventListener('submit', async (e) => {
    e.preventDefault(); token = $('token').value.trim(); $('token').value = '';
    try { await loadCases(); sessionStorage.setItem('staffToken', token); signedIn(true); } catch { signOut(); }
  });
  $('logout').addEventListener('click', signOut);
  $('refresh').addEventListener('click', loadCases);
  $('status').addEventListener('change', loadCases);
  document.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => act(b.dataset.action)));

  signedIn(Boolean(token));
  if (token) loadCases().catch(() => signOut());
})();

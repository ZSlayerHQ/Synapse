// Synapse dashboard: a person signs in with their name and personal key, sees open decision cards, notifications,
// who is online and recent messages, and answers cards. Every value from the bus is set with textContent, never as HTML.
const $ = (id) => document.getElementById(id);
const store = window.sessionStorage;
let me = null;

function creds() { return { name: store.getItem('synapse.name'), key: store.getItem('synapse.key') }; }
async function api(method, path, body, project) {
  const { name, key } = creds();
  const headers = { 'Content-Type': 'application/json', 'X-Synapse-Human': name || '', 'X-Dev-Key': key || '' };
  if (project) headers['X-Dev-Project'] = project;
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (r.status === 401) { signOut('Your name or key was not accepted.'); throw new Error('unauthorized'); }
  return { status: r.status, data };
}
function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
const time = (iso) => { try { return new Date(iso).toLocaleTimeString(); } catch { return ''; } };

function signOut(message) {
  store.removeItem('synapse.name');
  store.removeItem('synapse.key');
  me = null;
  $('app').hidden = true; $('signin').hidden = false; $('signout').hidden = true; $('who').textContent = '';
  $('signin-error').textContent = message || '';
}

async function renderCards() {
  const { data } = await api('GET', '/api/ask/open');
  const box = $('cards');
  box.replaceChildren();
  const cards = (data && data.cards) || [];
  $('cards-count').textContent = cards.length ? `(${cards.length})` : '';
  if (!cards.length) { box.append(el('p', 'No open cards.', 'muted')); return; }
  for (const c of cards) {
    const d = el('div', undefined, 'card');
    d.append(el('div', `${c.project} · from ${c.seat || 'a session'} · ${time(c.createdAt)}${c.series ? ` · ${c.series}` : ''}`, 'meta'));
    d.append(el('strong', c.question || ''));
    if (c.context) d.append(el('div', c.context, 'context'));
    if (c.recommendation) d.append(el('div', `Recommended: ${c.recommendation}`, 'meta'));
    const opts = el('div', undefined, 'options');
    for (const label of c.options || []) {
      const b = el('button', label);
      if (!c.canAnswer) { b.disabled = true; b.title = 'You are not an owner or approver for this project'; }
      b.addEventListener('click', async () => {
        b.disabled = true;
        const r = await api('POST', `/api/ask/${encodeURIComponent(c.askId)}/answer`, { label });
        if (r.status !== 200) window.alert(`Not answered: ${(r.data && r.data.error) || r.status}`);
        refresh();
      });
      opts.append(b);
    }
    d.append(opts);
    box.append(d);
  }
}
async function renderNotifications() {
  const { data } = await api('GET', '/api/notifications');
  const ul = $('notifications');
  ul.replaceChildren();
  for (const n of (data && data.notifications) || []) {
    const li = el('li');
    li.append(el('span', `${time(n.timestamp)} ${n.project} · ${n.kind === 'dm' ? 'direct' : n.priority} · ${n.sender}: `, 'meta'), el('span', n.message || ''));
    ul.append(li);
  }
  if (!ul.children.length) ul.append(el('li', 'Nothing yet.', 'muted'));
}
async function renderStatus() {
  const { data } = await api('GET', '/api/status');
  const ul = $('online');
  ul.replaceChildren();
  for (const n of (data && data.online) || []) ul.append(el('li', n));
  if (!ul.children.length) ul.append(el('li', 'No session is connected.', 'muted'));
}
async function renderMessages() {
  const { data } = await api('GET', '/api/messages?limit=60');
  const ul = $('messages');
  ul.replaceChildren();
  for (const m of (data && data.messages) || []) {
    const li = el('li');
    li.append(el('span', `${time(m.timestamp)} ${m.project} #${m.channel}${m.to ? ` → ${m.to}` : ''} · ${m.sender}: `, 'meta'), el('span', m.content || ''));
    ul.append(li);
  }
}
async function refresh() {
  if (!me) return;
  try { await Promise.all([renderCards(), renderNotifications(), renderStatus(), renderMessages()]); } catch { /* signed out or bus down */ }
}

async function start() {
  const { status, data } = await api('GET', '/api/whoami');
  if (status !== 200 || !data || data.kind !== 'human') { signOut('Sign-in failed.'); return; }
  me = data;
  $('who').textContent = `${data.name} (${(data.roles || []).join(', ') || 'no roles'})`;
  $('signin').hidden = true; $('app').hidden = false; $('signout').hidden = false;
  const projSel = $('post-project');
  projSel.replaceChildren();
  for (const p of data.projects || []) { const o = el('option', p); o.value = p; projSel.append(o); }
  const ch = await api('GET', '/api/channels');
  const chSel = $('post-channel');
  chSel.replaceChildren();
  for (const c of [...((ch.data && ch.data.channels) || []), 'all']) { const o = el('option', c); o.value = c; chSel.append(o); }
  refresh();
}

// The same rule `synapse set-human-key` applies: the key travels in a header, so printable ASCII without spaces.
const KEY_RULE = /^[\x21-\x7e]{12,256}$/;
$('signin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!KEY_RULE.test($('key').value)) { $('signin-error').textContent = 'A personal key is 12 to 256 printable characters with no spaces.'; return; }
  store.setItem('synapse.name', $('name').value.trim());
  store.setItem('synapse.key', $('key').value);
  $('key').value = '';
  start().catch(() => {});
});
$('signout').addEventListener('click', () => signOut());
$('post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const channel = $('post-channel').value;
  const content = $('post-text').value;
  const path = channel === 'all' ? '/api/message/broadcast' : '/api/message';
  const r = await api('POST', path, { channel, content }, $('post-project').value);
  if (r.status === 200) $('post-text').value = ''; else window.alert(`Not sent: ${(r.data && r.data.error) || r.status}`);
  refresh();
});
setInterval(refresh, 4000);
if (creds().name && creds().key) start().catch(() => {});

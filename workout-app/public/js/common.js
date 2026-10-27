const ENDPOINT = 'http://localhost:4000/';

const BODY_PARTS = {
  chest: '胸', back: '背中', shoulders: '肩', arms: '腕',
  legs: '脚', abs: '腹筋', other: 'その他',
};
const TYPES = {
  normal: '通常',
  weighted: '加重(自重+追加)',
  assisted: 'アシスト(自重-補助)',
};

const $ = (id) => document.getElementById(id);

async function gql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const { data, errors } = await res.json();
  if (errors) throw new Error(errors[0].message);
  return data;
}

// DOMを手軽に作る(textContentで入れるので、入力内容が安全に表示される)
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

function formatWeight(type, weight) {
  if (weight == null) return '-';
  if (type === 'weighted') return weight === 0 ? '自重' : `+${weight}kg`;
  if (type === 'assisted') return weight === 0 ? '補助なし' : `-${weight}kg`;
  return `${weight}kg`;
}
const formatSetText = (type, s) =>
  s.weight == null && s.reps == null
    ? '-'
    : `${formatWeight(type, s.weight)} × ${s.reps ?? '-'}`;

const toNumber = (v, int) => {
  if (v === '') return null;
  const n = int ? parseInt(v, 10) : parseFloat(v);
  return Number.isNaN(n) ? null : n;
};

// 通信エラーを画面に出す共通ラッパー
const safe = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { alert(err.message); }
};

// ローカル時間でYYYY-MM-DD(toISOStringはUTCになり、日本では日付がずれることがあるため)
const toLocalDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const weekdayOf = (dateStr) => WEEKDAYS[new Date(`${dateStr}T00:00:00`).getDay()];

// 画面下に数秒だけ出る通知
let toastTimer = null;
function toast(message) {
  const box = $('toast');
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.classList.remove('show');
    box.hidden = true;
  }, 2500);
}

// 下のタブバー(全ページ共通)
(function buildTabBar() {
  const tabs = [
    ['index.html', '🏋️', '記録'],
    ['history.html', '📅', '履歴'],
    ['charts.html', '📈', 'グラフ'],
    ['exercises.html', '⚙️', '設定'],
  ];
  const current = location.pathname.split('/').pop() || 'index.html';
  const bar = document.createElement('nav');
  bar.className = 'tabbar';
  for (const [href, icon, label] of tabs) {
    const a = document.createElement('a');
    a.href = href;
    if (href === current) a.className = 'active';
    const i = document.createElement('span');
    i.className = 'ico';
    i.textContent = icon;
    a.append(i, label);
    bar.append(a);
  }
  document.body.append(bar);
})();
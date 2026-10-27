const PERIODS = [
  ['3m', '3か月', 3],
  ['6m', '6か月', 6],
  ['1y', '1年', 12],
  ['all', '全部', null],
];

let allWorkouts = [];     // 古い順
let exerciseList = [];    // 記録のある種目
let currentId = null;
let currentPeriod = '6m';
let currentMetric = 'e1rm';
let chart = null;

const round1 = (v) => Math.round(v * 10) / 10;

const QUERY = `{
  workouts {
    date
    exercises {
      exercise { id name bodyPart type }
      sets { weight reps estimated1RM effectiveWeight }
    }
  }
}`;

// 種目のタイプごとに使える指標
function metricsFor(ex) {
  if (ex.type === 'assisted') {
    return [['e1rm', '推定1RM(体重込み)'], ['eff', '実質重量'], ['weight', '最小補助重量']];
  }
  if (ex.type === 'weighted') {
    return [['e1rm', '推定1RM(体重込み)'], ['eff', '実質重量'], ['weight', '最大追加重量'], ['volume', 'ボリューム']];
  }
  return [['e1rm', '推定1RM'], ['weight', '最大重量'], ['volume', 'ボリューム']];
}

function periodFrom(key) {
  const p = PERIODS.find((x) => x[0] === key);
  if (!p || p[2] == null) return '';
  const d = new Date();
  d.setMonth(d.getMonth() - p[2]);
  return toLocalDate(d);
}

// 重量・回数の両方が入っているセットだけを集計対象にする
const isFilled = (s) => s.weight != null && s.reps != null;

// 種目ごとに、日付ごとの値をまとめる
function buildSeries(ex, from) {
  const byDate = new Map();
  for (const w of allWorkouts) {
    if (from && w.date < from) continue;
    for (const we of w.exercises) {
      if (we.exercise.id !== ex.id) continue;
      for (const s of we.sets.filter(isFilled)) {
                const cur = byDate.get(w.date) ?? { date: w.date, weight: null, e1rm: null, eff: null, volume: 0, sets: [] };
        cur.sets.push(s);
        cur.volume += s.weight * s.reps;
        // アシストは補助が小さいほど強いので最小値、それ以外は最大値
        cur.weight = cur.weight == null ? s.weight
          : ex.type === 'assisted' ? Math.min(cur.weight, s.weight) : Math.max(cur.weight, s.weight);
        if (s.estimated1RM != null) cur.e1rm = Math.max(cur.e1rm ?? 0, s.estimated1RM);
        if (s.effectiveWeight != null) cur.eff = Math.max(cur.eff ?? 0, s.effectiveWeight);
        byDate.set(w.date, cur);
      }
    }
  }
  return [...byDate.values()].map((d) => ({ ...d, volume: round1(d.volume) }));
}

// ---------- 画面の部品 ----------
function renderExerciseSelect() {
  const sel = $('exercise');
  sel.innerHTML = '';
  if (exerciseList.length === 0) {
    sel.add(new Option('記録のある種目がありません', ''));
    return;
  }
  for (const [part, label] of Object.entries(BODY_PARTS)) {
    const items = exerciseList.filter((e) => e.bodyPart === part);
    if (items.length === 0) continue;
    const group = el('optgroup', { label });
    for (const e of items) group.append(new Option(`${e.name}(${e.days}日)`, e.id));
    sel.append(group);
  }
  sel.value = currentId;
}

function renderChips() {
  const ex = exerciseList.find((e) => e.id === currentId);

  const metrics = $('metrics');
  metrics.innerHTML = '';
  if (ex) {
    for (const [key, label] of metricsFor(ex)) {
      metrics.append(el('button', {
        text: label,
        disabled: key === currentMetric,
        onclick: () => { currentPeriod = key; renderChips(); render(); renderBodyChart(); },
      }));
    }
  }

  const period = $('period');
  period.innerHTML = '';
  for (const [key, label] of PERIODS) {
    period.append(el('button', {
      text: label,
      disabled: key === currentPeriod,
      onclick: () => { currentPeriod = key; renderChips(); render(); },
    }));
  }
}

function renderStats(ex, points, metricLabel) {
  const box = $('stats');
  box.innerHTML = '';
  if (points.length === 0) return;

  const values = points.map((p) => p.value);
  const bestIsMin = ex.type === 'assisted' && currentMetric === 'weight';
  const best = bestIsMin ? Math.min(...values) : Math.max(...values);
  const bestPoint = points[values.indexOf(best)];
  const latest = points[points.length - 1];
  const diff = round1(latest.value - points[0].value);

  const item = (label, value) =>
    el('div', { class: 'stat' }, el('span', { text: label }), el('b', { text: value }));

  box.append(
    item('期間内ベスト', `${best}kg(${bestPoint.date.slice(5)})`),
    item('最新', `${latest.value}kg`),
    item('初回比', points.length < 2 ? '-' : `${diff > 0 ? '+' : ''}${diff}kg`)
  );
}

// ---------- グラフ描画 ----------
function render() {
  const ex = exerciseList.find((e) => e.id === currentId);
  if (chart) { chart.destroy(); chart = null; }

  if (!ex) {
    $('stats').innerHTML = '';
    $('empty').hidden = false;
    $('chart').hidden = true;
    return;
  }

  // 種目を切り替えたとき、使えない指標なら先頭の指標に切り替える
  const available = metricsFor(ex).map((m) => m[0]);
  if (!available.includes(currentMetric)) currentMetric = available[0];

  const metricLabel = metricsFor(ex).find((m) => m[0] === currentMetric)[1];
  const points = buildSeries(ex, periodFrom(currentPeriod))
    .map((d) => ({ ...d, value: d[currentMetric] }))
    .filter((d) => d.value != null);

  renderStats(ex, points, metricLabel);

  const hasData = points.length > 0;
  $('empty').hidden = hasData;
  $('chart').hidden = !hasData;
  if (!hasData) return;

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2f6fed';

  chart = new Chart($('chart'), {
    type: 'line',
    data: {
      labels: points.map((p) => p.date.slice(5)), // MM-DD
      datasets: [{
        label: metricLabel,
        data: points.map((p) => p.value),
        borderColor: accent,
        backgroundColor: accent,
        tension: 0.2,
        pointRadius: 4,
        pointHoverRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const p = points[items[0].dataIndex];
              return `${p.date}(${weekdayOf(p.date)})`;
            },
            label: (item) => `${metricLabel}: ${item.parsed.y}kg`,
            // その日の全セットを表示
            afterLabel: (item) =>
              points[item.dataIndex].sets.map((s, i) => `${i + 1}. ${formatSetText(ex.type, s)}`),
          },
        },
      },
      scales: {
        y: {
          // アシストは補助が小さいほど強いので、上に行くほど良い向きに反転
          reverse: ex.type === 'assisted' && currentMetric === 'weight',
          title: { display: true, text: 'kg' },
        },
      },
    },
  });
}

// ---------- 体重グラフ ----------
let bodyWeights = [];   // 古い順
let bwChart = null;

function renderBodyChart() {
  const from = periodFrom(currentPeriod);
  const points = bodyWeights.filter((b) => !from || b.date >= from);

  if (bwChart) { bwChart.destroy(); bwChart = null; }
  const stats = $('bw-stats');
  stats.innerHTML = '';
  $('bw-empty').hidden = points.length > 0;
  $('bw-chart').hidden = points.length === 0;
  if (points.length === 0) return;

  const values = points.map((p) => p.weight);
  const latest = points[points.length - 1];
  const diff = round1(latest.weight - points[0].weight);
  const item = (label, value) =>
    el('div', { class: 'stat' }, el('span', { text: label }), el('b', { text: value }));
  stats.append(
    item('最新', `${latest.weight}kg(${latest.date.slice(5)})`),
    item('期間内の最小〜最大', `${Math.min(...values)}〜${Math.max(...values)}kg`),
    item('初回比', points.length < 2 ? '-' : `${diff > 0 ? '+' : ''}${diff}kg`)
  );

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2f6fed';
  bwChart = new Chart($('bw-chart'), {
    type: 'line',
    data: {
      labels: points.map((p) => p.date.slice(5)),
      datasets: [{
        label: '体重',
        data: values,
        borderColor: accent,
        backgroundColor: accent,
        tension: 0.2,
        pointRadius: 4,
        pointHoverRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const p = points[items[0].dataIndex];
              return `${p.date}(${weekdayOf(p.date)})`;
            },
            label: (item) => `体重: ${item.parsed.y}kg`,
          },
        },
      },
      scales: { y: { title: { display: true, text: 'kg' } } },
    },
  });
}

// ---------- 初期表示 ----------
$('exercise').addEventListener('change', () => {
  currentId = $('exercise').value;
  renderChips();
  render();
});

async function init() {
  const data = await gql(QUERY);
  allWorkouts = [...data.workouts].reverse(); // 古い順に並べ替え
  const bw = await gql(`{ bodyWeights { date weight } }`);
  bodyWeights = bw.bodyWeights;

  // 記録のある種目を集計(日数が多い順に先頭候補を決める)
  const map = new Map();
  for (const w of allWorkouts) {
    for (const we of w.exercises) {
      if (!we.sets.some(isFilled)) continue;
      const cur = map.get(we.exercise.id) ?? { ...we.exercise, dates: new Set() };
      cur.dates.add(w.date);
      map.set(we.exercise.id, cur);
    }
  }
  exerciseList = [...map.values()]
    .map((e) => ({ id: e.id, name: e.name, bodyPart: e.bodyPart, type: e.type, days: e.dates.size }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));

  if (exerciseList.length > 0) {
    currentId = [...exerciseList].sort((a, b) => b.days - a.days)[0].id;
  }
  renderExerciseSelect();
  renderChips();
  render();
  renderBodyChart();
}

init().catch((err) => alert(err.message));
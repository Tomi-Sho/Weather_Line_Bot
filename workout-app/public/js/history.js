let currentPart = null;   // null = 全部
let currentPeriod = 'month';

const PERIODS = [
  ['week', '今週'],
  ['month', '今月'],
  ['quarter', '3か月'],
  ['all', '全部'],
];

// 期間のボタン → from/to の日付欄に値を入れる
function applyPeriod(key) {
  const now = new Date();
  let from = '';
  if (key === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 月曜始まり
    from = toLocalDate(d);
  } else if (key === 'month') {
    from = toLocalDate(new Date(now.getFullYear(), now.getMonth(), 1));
  } else if (key === 'quarter') {
    from = toLocalDate(new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()));
  }
  $('from').value = from;
  $('to').value = '';
  currentPeriod = key;
}

function renderChips() {
  const period = $('period');
  period.innerHTML = '';
  for (const [key, label] of PERIODS) {
    period.append(el('button', {
      text: label,
      disabled: key === currentPeriod,
      onclick: safe(async () => { applyPeriod(key); renderChips(); await load(); }),
    }));
  }

  const parts = $('parts');
  parts.innerHTML = '';
  for (const [value, label] of [[null, '全部'], ...Object.entries(BODY_PARTS)]) {
    parts.append(el('button', {
      text: label,
      disabled: value === currentPart,
      onclick: safe(async () => { currentPart = value; renderChips(); await load(); }),
    }));
  }
}

const QUERY = `
  query ($from: String, $to: String, $bodyPart: BodyPart) {
    workouts(from: $from, to: $to, bodyPart: $bodyPart) {
      id date
      exercises {
        id note
        exercise { id name bodyPart type }
        sets { id setNumber weight reps note estimated1RM }
      }
    }
  }
`;

async function load() {
  const data = await gql(QUERY, {
    from: $('from').value || null,
    to: $('to').value || null,
    bodyPart: currentPart,
  });

  const box = $('history');
  box.innerHTML = '';

  let dayCount = 0;
  let setCount = 0;

  for (const w of data.workouts) {
    // 部位で絞っているときは、その部位の種目だけ表示する
    const list = w.exercises.filter((we) => !currentPart || we.exercise.bodyPart === currentPart);
    if (list.length === 0) continue;
    dayCount++;
    box.append(renderDay(w.date, list, (n) => { setCount += n; }));
  }

  $('summary').textContent = dayCount === 0 ? '' : `${dayCount}日 ・ ${setCount}セット`;
  if (dayCount === 0) {
    box.append(el('div', { class: 'empty', text: '該当する記録がありません' }));
  }
}

function renderDay(date, list, addSets) {
  const parts = [...new Set(list.map((we) => BODY_PARTS[we.exercise.bodyPart]))];

  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { text: `${date}(${weekdayOf(date)})` }, el('span', { class: 'tag', text: parts.join('・') })),
      el('a', { href: `index.html?date=${date}`, text: '開く', class: 'link' })
    )
  );

  for (const we of list) {
    const type = we.exercise.type;
    const filled = we.sets.filter((s) => s.weight != null || s.reps != null);
    addSets(filled.length);

    const block = el('div', { class: 'hist-ex' },
      el('div', { class: 'hist-name', text: we.exercise.name })
    );
    if (filled.length === 0) {
      block.append(el('div', { class: 'set-line', text: '未入力' }));
    }
    for (const s of filled) {
      let text = `${s.setNumber}. ${formatSetText(type, s)}`;
      if (s.estimated1RM != null) text += `  (推定1RM ${s.estimated1RM}kg)`;
      if (s.note) text += `  ${s.note}`;
      block.append(el('div', { class: 'set-line', text }));
    }
    if (we.note) block.append(el('div', { class: 'hist-note', text: `メモ: ${we.note}` }));
    card.append(block);
  }
  return card;
}

// 日付欄を直接変えたら、ボタンの選択状態を外して読み込み直す
for (const id of ['from', 'to']) {
  $(id).addEventListener('change', safe(async () => {
    currentPeriod = null;
    renderChips();
    await load();
  }));
}

// ---------- 初期表示 ----------
applyPeriod('month');
renderChips();
load().catch((err) => alert(err.message));
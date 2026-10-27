const WEIGHT_LABEL = { normal: '重量', weighted: '追加', assisted: '補助' };

let currentPart = null;   // ベスト表の絞り込み(null = 全部)
let exercises = [];       // 種目マスタ
let templates = [];       // テンプレート
const openTemplates = new Set(); // 開いているテンプレート(再描画しても閉じないように)

// ---------- 初期設定 ----------
function setupSelects() {
  for (const [v, l] of Object.entries(BODY_PARTS)) $('ex-part').add(new Option(l, v));
  for (const [v, l] of Object.entries(TYPES)) $('ex-type').add(new Option(l, v));
  renderFilter();
}

async function loadExercises() {
  const data = await gql(`{ exercises { id name bodyPart type note } }`);
  exercises = data.exercises;
  const sel = $('add-select');
  sel.innerHTML = '';
  if (exercises.length === 0) {
    sel.add(new Option('先に種目を登録してください', ''));
  } else {
    for (const ex of exercises) {
      sel.add(new Option(`[${BODY_PARTS[ex.bodyPart]}] ${ex.name}`, ex.id));
    }
  }
  renderTemplateList(); // テンプレートの「種目を追加」プルダウンも更新
}

// ---------- その日のトレーニング表示 ----------
const WORKOUT_QUERY = `
  query ($date: String!) {
    workout(date: $date) {
      id
      exercises {
        id note targetReps
        exercise { id name bodyPart type note }
        sets { id setNumber weight reps note estimated1RM effectiveWeight }
        previous {
          date note
          sets { setNumber weight reps note }
        }
      }
    }
  }
`;

// ---------- 体重 ----------
async function loadBodyWeight() {
  const date = $('date').value;
  const data = await gql(`query ($to: String) { bodyWeights(to: $to) { date weight } }`, { to: date });
  const list = data.bodyWeights; // 古い順、選択日まで
  const todays = list.find((b) => b.date === date);
  const prev = [...list].reverse().find((b) => b.date < date);

  $('bw-input').value = todays ? todays.weight : '';
  $('bw-input').placeholder = prev ? String(prev.weight) : '体重(kg)';
  $('bw-delete').hidden = !todays;

  let info = '';
  if (prev) {
    info = `前回 ${prev.weight}kg(${prev.date.slice(5)})`;
    if (todays) {
      const diff = Math.round((todays.weight - prev.weight) * 10) / 10;
      info += ` → ${diff > 0 ? '+' : ''}${diff}kg`;
    }
  }
  $('bw-info').textContent = info;
}

$('bw-save').addEventListener('click', safe(async () => {
  const weight = toNumber($('bw-input').value, false);
  if (weight == null) { alert('体重を入力してください'); return; }
  await gql(
    `mutation ($date: String!, $weight: Float!) { setBodyWeight(date: $date, weight: $weight) { id } }`,
    { date: $('date').value, weight }
  );
  await Promise.all([loadBodyWeight(), loadWorkout(), loadRecords()]);
  toast(`体重を記録しました(${weight}kg)`);
}));

$('bw-delete').addEventListener('click', safe(async () => {
  if (!confirm(`${$('date').value} の体重の記録を削除しますか?`)) return;
  await gql(`mutation ($date: String!) { deleteBodyWeight(date: $date) }`, { date: $('date').value });
  await Promise.all([loadBodyWeight(), loadWorkout(), loadRecords()]);
  toast('体重の記録を削除しました');
}));

async function loadWorkout() {
  const data = await gql(WORKOUT_QUERY, { date: $('date').value });
  const box = $('workout');
  box.innerHTML = '';

  const list = data.workout?.exercises ?? [];
  $('workout-tools').hidden = list.length === 0;

  if (list.length === 0) {
    box.append(el('div', { class: 'empty', text: 'この日の記録はまだありません。上のテンプレートか種目追加から始めてください。' }));
    return;
  }
  for (const we of list) box.append(renderCard(we));
}

function renderCard(we) {
  const ex = we.exercise;
  const prevSets = new Map((we.previous?.sets ?? []).map((s) => [s.setNumber, s]));

  const fixedNote = el('textarea', { rows: 2, placeholder: 'マシンのセッティングなど(毎回引き継がれます)', value: ex.note });
  fixedNote.addEventListener('change', safe(async () => {
    await gql(`mutation ($id: ID!, $note: String!) { updateExerciseNote(id: $id, note: $note) { id } }`,
      { id: ex.id, note: fixedNote.value });
    await loadExercises();
  }));

  const todayNote = el('textarea', { rows: 2, placeholder: '今日の気づき', value: we.note });
  todayNote.addEventListener('change', safe(() =>
    gql(`mutation ($id: ID!, $note: String!) { updateWorkoutExerciseNote(id: $id, note: $note) { id } }`,
      { id: we.id, note: todayNote.value })));

  const tbody = el('tbody');
  for (const s of we.sets) {
    tbody.append(renderSetRow(s, ex.type, prevSets.get(s.setNumber), we.targetReps));
  }

  const table = el('table', { class: 'sets' },
    el('thead', {}, el('tr', {},
      el('th', { text: '' }),
      el('th', { text: we.previous ? `前回 (${we.previous.date})` : '前回' }),
      el('th', { text: '今回' }),
      el('th', { text: '' }),
    )),
    tbody
  );

  const removeBtn = el('button', {
    class: 'ghost', text: '種目を外す',
    onclick: safe(async () => {
      if (!confirm(`${ex.name} をこの日の記録から外しますか?(セットも消えます)`)) return;
      await gql(`mutation ($id: ID!) { removeWorkoutExercise(id: $id) }`, { id: we.id });
      await loadWorkout();
      await loadRecords();
    }),
  });

  const addSetBtn = el('button', {
    text: '+ セットを追加',
    onclick: safe(async () => {
      await gql(`mutation ($id: ID!) { addSet(workoutExerciseId: $id) { id } }`, { id: we.id });
      await loadWorkout();
    }),
  });

  const fillBtn = el('button', {
    text: '前回と同じ',
    disabled: !we.previous,
    onclick: safe(async () => {
      toast(fillMessage(await fillRows(tbody.querySelectorAll('tr'))));
    }),
  });

  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { text: ex.name }, el('span', { class: 'tag', text: `${BODY_PARTS[ex.bodyPart]}・${TYPES[ex.type]}` })),
      removeBtn
    ),
    el('label', { class: 'label', text: '固定メモ' }), fixedNote,
    we.previous?.note ? el('p', { class: 'prev-note', text: `前回の今日メモ: ${we.previous.note}` }) : null,
    el('label', { class: 'label', text: '今日のメモ' }), todayNote,
    table,
        table,
    el('div', { class: 'row', style: 'margin-top:8px' }, addSetBtn, fillBtn)
  );
}

// 1RM欄の表示テキスト。加重・アシストは実質重量も出し、体重が無ければその旨を出す
function rmText(type, s) {
  if (s.estimated1RM != null) {
    const eff = type !== 'normal' && s.effectiveWeight != null ? `(実質${s.effectiveWeight}kg)` : '';
    return `推定1RM ${s.estimated1RM}kg${eff}`;
  }
  if (type !== 'normal' && s.weight != null && s.reps != null) {
    return '体重を記録すると推定1RMが出ます';
  }
  return '';
}

// 各行の _fill() を順に呼んで、前回の値を空欄に入力する(入力できた行数を返す)
async function fillRows(rows) {
  let n = 0;
  for (const tr of rows) {
    if (tr._fill && await tr._fill()) n++;
  }
  return n;
}
const fillMessage = (n) =>
  n > 0 ? `${n}セットに前回の値を入力しました` : '入力できるセットがありません(前回がない、または入力済みです)';

function renderSetRow(s, type, prev, targetReps) {
  // 右の入力欄は空欄のまま、前回の値を薄く表示(入力しなければ保存されない)
  const weightInput = el('input', {
    class: 'n', type: 'number', step: '0.5', min: '0', inputMode: 'decimal',
    placeholder: prev?.weight != null ? String(prev.weight) : WEIGHT_LABEL[type],
    value: s.weight ?? '',
  });
  const repsInput = el('input', {
    class: 'n', type: 'number', min: '1', inputMode: 'numeric',
    placeholder: prev?.reps != null ? String(prev.reps) : (targetReps || '回'),
    value: s.reps ?? '',
  });
  const noteInput = el('input', { class: 'set-note', type: 'text', placeholder: 'メモ(例: RPE8)', value: s.note });
  const rm = el('div', { class: 'rm', text: rmText(type, s) });

  const save = async () => {
    try {
      const weight = toNumber(weightInput.value, false);
      const reps = toNumber(repsInput.value, true);
      const r = await gql(
        `mutation ($id: ID!, $weight: Float, $reps: Int, $note: String) {
          updateSet(id: $id, weight: $weight, reps: $reps, note: $note) { estimated1RM effectiveWeight }
        }`,
        { id: s.id, weight, reps, note: noteInput.value }
      );
      rm.textContent = rmText(type, { weight, reps, ...r.updateSet });
      loadRecords();
    } catch (err) {
      alert(err.message);
      await loadWorkout();
    }
  };
  for (const input of [weightInput, repsInput, noteInput]) input.addEventListener('change', save);

  const delBtn = el('button', {
    class: 'ghost', text: '✕',
    onclick: safe(async () => {
      await gql(`mutation ($id: ID!) { deleteSet(id: $id) }`, { id: s.id });
      await loadWorkout();
      await loadRecords();
    }),
  });

  const tr = el('tr', {},
    el('td', { class: 'num', text: s.setNumber }),
    el('td', { class: 'prev' },
      el('div', { text: prev ? formatSetText(type, prev) : '-' }),
      prev?.note ? el('div', { text: prev.note }) : null
    ),
    el('td', {},
      el('div', { class: 'inputs' }, weightInput, el('span', { text: '×' }), repsInput),
      noteInput, rm
    ),
    el('td', {}, delBtn)
  );

  // 「前回と同じ」: 空欄にだけ前回の値を入れて保存する(入力済みの欄は変えない)
  tr._fill = async () => {
    if (!prev) return false;
    let changed = false;
    if (weightInput.value === '' && prev.weight != null) { weightInput.value = prev.weight; changed = true; }
    if (repsInput.value === '' && prev.reps != null) { repsInput.value = prev.reps; changed = true; }
    if (changed) await save();
    return changed;
  };
  return tr;
}

// ---------- テンプレート ----------
async function loadTemplates() {
  const data = await gql(`{
    templates {
      id name isPreset
      exercises { id setCount targetReps exercise { id name bodyPart } }
    }
  }`);
  templates = data.templates;

  const sel = $('tpl-select');
  sel.innerHTML = '';
  if (templates.length === 0) sel.add(new Option('テンプレートがありません', ''));
  for (const t of templates) sel.add(new Option(t.name, t.id));

  renderTemplateList();
}

function renderTemplateList() {
  const box = $('tpl-list');
  box.innerHTML = '';
  for (const t of templates) box.append(renderTemplate(t));
}

function renderTemplate(t) {
  const d = el('details', { class: 'tpl' });
  d.open = openTemplates.has(t.id);
  d.addEventListener('toggle', () => {
    if (d.open) openTemplates.add(t.id); else openTemplates.delete(t.id);
  });

  const title = el('summary', { text: `${t.name}(${t.exercises.length}種目)` });
  if (t.isPreset) title.append(el('span', { class: 'badge', text: 'おすすめ' }));
  d.append(title);

  for (const te of t.exercises) {
    if (t.isPreset) {
      // 初心者向けは閲覧のみ
      d.append(el('div', { class: 'tpl-item' },
        el('span', { class: 'name', text: te.exercise.name }),
        el('span', { text: `${te.setCount}セット × ${te.targetReps || '-'}回` })
      ));
      continue;
    }
    // 自分用は編集可能
    const countInput = el('input', { class: 'n', type: 'number', min: '1', max: '20', value: te.setCount });
    const repsInput = el('input', { class: 'reps', type: 'text', placeholder: '目安(例: 8-10)', value: te.targetReps });
    const update = safe(async () => {
      await gql(
        `mutation ($id: ID!, $setCount: Int, $targetReps: String) {
          updateTemplateExercise(id: $id, setCount: $setCount, targetReps: $targetReps) { id }
        }`,
        { id: te.id, setCount: toNumber(countInput.value, true), targetReps: repsInput.value }
      );
      await loadTemplates();
    });
    countInput.addEventListener('change', update);
    repsInput.addEventListener('change', update);

    d.append(el('div', { class: 'tpl-item' },
      el('span', { class: 'name', text: te.exercise.name }),
      countInput, el('span', { text: 'セット' }), repsInput,
      el('button', {
        class: 'ghost', text: '✕',
        onclick: safe(async () => {
          await gql(`mutation ($id: ID!) { removeTemplateExercise(id: $id) }`, { id: te.id });
          await loadTemplates();
        }),
      })
    ));
  }

  if (t.isPreset) {
    d.append(el('div', { class: 'tpl-actions' },
      el('button', {
        text: '複製して編集',
        onclick: safe(async () => {
          const r = await gql(`mutation ($id: ID!) { duplicateTemplate(id: $id) { id } }`, { id: t.id });
          openTemplates.add(r.duplicateTemplate.id);
          await loadTemplates();
        }),
      })
    ));
  } else {
    // 種目の追加
    const sel = el('select');
    for (const ex of exercises) sel.add(new Option(`[${BODY_PARTS[ex.bodyPart]}] ${ex.name}`, ex.id));
    d.append(el('div', { class: 'tpl-actions' },
      sel,
      el('button', {
        text: '種目を追加',
        onclick: safe(async () => {
          if (!sel.value) return;
          await gql(
            `mutation ($templateId: ID!, $exerciseId: ID!) {
              addTemplateExercise(templateId: $templateId, exerciseId: $exerciseId) { id }
            }`,
            { templateId: t.id, exerciseId: sel.value }
          );
          await loadTemplates();
        }),
      })
    ));
    d.append(el('div', { class: 'tpl-actions' },
      el('button', {
        class: 'ghost', text: 'このテンプレートを削除',
        onclick: safe(async () => {
          if (!confirm(`「${t.name}」を削除しますか?(過去の記録は消えません)`)) return;
          await gql(`mutation ($id: ID!) { deleteTemplate(id: $id) }`, { id: t.id });
          await loadTemplates();
        }),
      })
    ));
  }
  return d;
}

// ---------- 種目別ベスト ----------
function renderFilter() {
  const box = $('filter');
  box.innerHTML = '';
  for (const [value, label] of [[null, '全部'], ...Object.entries(BODY_PARTS)]) {
    box.append(el('button', {
      text: label,
      disabled: value === currentPart,
      onclick: () => { currentPart = value; renderFilter(); loadRecords(); },
    }));
  }
}

async function loadRecords() {
  const data = await gql(
    `query ($bodyPart: BodyPart) {
      records(bodyPart: $bodyPart) { bestWeight best1RM exercise { name type } }
    }`,
    { bodyPart: currentPart }
  );
  const tbody = $('record-list');
  tbody.innerHTML = '';
  if (data.records.length === 0) {
    tbody.append(el('tr', {}, el('td', { colSpan: 3, class: 'empty', text: 'まだ記録がありません' })));
    return;
  }
  for (const r of data.records) {
    tbody.append(el('tr', {},
      el('td', { text: r.exercise.name }),
      el('td', { text: formatWeight(r.exercise.type, r.bestWeight) }),
      el('td', { text: r.best1RM != null ? r.best1RM : '-' })
    ));
  }
}

// ---------- イベント ----------
$('date').addEventListener('change', safe(async () => {
  await Promise.all([loadWorkout(), loadBodyWeight()]);
}));

$('tpl-start').addEventListener('click', safe(async () => {
  const templateId = $('tpl-select').value;
  if (!templateId) { alert('テンプレートを選んでください'); return; }
  await gql(
    `mutation ($date: String!, $templateId: ID!) {
      startWorkoutFromTemplate(date: $date, templateId: $templateId) { id }
    }`,
    { date: $('date').value, templateId }
  );
  const t = templates.find((x) => String(x.id) === String(templateId));
  await loadWorkout();
  toast(t ? `「${t.name}」を追加しました(${t.exercises.length}種目)` : 'テンプレートを追加しました');
}));

$('tpl-create').addEventListener('click', safe(async () => {
  const name = $('tpl-name').value;
  const r = await gql(`mutation ($name: String!) { createTemplate(name: $name) { id } }`, { name });
  $('tpl-name').value = '';
  openTemplates.add(r.createTemplate.id);
  await loadTemplates();
}));

$('add-btn').addEventListener('click', safe(async () => {
  const exerciseId = $('add-select').value;
  if (!exerciseId) { alert('先に種目を登録してください'); return; }
  await gql(
    `mutation ($date: String!, $exerciseId: ID!) {
      addWorkoutExercise(date: $date, exerciseId: $exerciseId) { id }
    }`,
    { date: $('date').value, exerciseId }
  );
  const ex = exercises.find((x) => String(x.id) === String(exerciseId));
  await loadWorkout();
  toast(ex ? `「${ex.name}」を追加しました` : '種目を追加しました');
}));

$('exercise-form').addEventListener('submit', safe(async (e) => {
  e.preventDefault();
  await gql(
    `mutation ($name: String!, $bodyPart: BodyPart!, $type: ExerciseType!, $note: String) {
      addExercise(name: $name, bodyPart: $bodyPart, type: $type, note: $note) { id }
    }`,
    {
      name: $('ex-name').value,
      bodyPart: $('ex-part').value,
      type: $('ex-type').value,
      note: $('ex-note').value,
    }
  );
  $('ex-name').value = '';
  $('ex-note').value = '';
  await loadExercises();
}));

$('fill-all-btn').addEventListener('click', safe(async () => {
  const n = await fillRows(document.querySelectorAll('#workout .sets tbody tr'));
  toast(fillMessage(n));
}));

$('clear-btn').addEventListener('click', safe(async () => {
  const date = $('date').value;
  // 件数を数えて、確認ダイアログに出す
  const data = await gql(WORKOUT_QUERY, { date });
  const list = data.workout?.exercises ?? [];
  const setCount = list.reduce((sum, we) => sum + we.sets.length, 0);
  if (list.length === 0) return;

  if (!confirm(`${date} の記録(${list.length}種目・${setCount}セット)をすべて削除しますか?\n元に戻せません。`)) return;

  await gql(`mutation ($date: String!) { clearWorkout(date: $date) }`, { date });
  await loadWorkout();
  await loadRecords();
  toast(`${date} の記録を削除しました`);
}));

// ---------- 初期表示 ----------
// 今日の日付をYYYY-MM-DDで(toISOStringだとUTCになり日本では日付がずれることがあるため)
$('date').value = new URLSearchParams(location.search).get('date') || toLocalDate();

setupSelects();
(async () => {
  await loadTemplates();
  await loadExercises();
  await loadWorkout();
  await loadBodyWeight();
  await loadRecords();
})().catch((err) => alert(err.message));
let usage = [];
let currentPart = null;       // null = 全部
const openIds = new Set();    // 開いている編集フォーム

const QUERY = `{
  exerciseUsage {
    setCount dayCount templateCount
    exercise { id name bodyPart type note }
  }
}`;

async function load() {
  usage = (await gql(QUERY)).exerciseUsage;
  renderFilter();
  renderList();
}

function renderFilter() {
  const box = $('part-filter');
  box.innerHTML = '';
  for (const [value, label] of [[null, '全部'], ...Object.entries(BODY_PARTS)]) {
    box.append(el('button', {
      text: label,
      disabled: value === currentPart,
      onclick: () => { currentPart = value; renderFilter(); renderList(); },
    }));
  }
}

function renderList() {
  const box = $('list');
  box.innerHTML = '';
  const items = usage.filter((u) => !currentPart || u.exercise.bodyPart === currentPart);
  if (items.length === 0) {
    box.append(el('div', { class: 'empty', text: '種目がありません' }));
    return;
  }
  for (const u of items) box.append(renderItem(u));
}

function renderItem(u) {
  const ex = u.exercise;
  const d = el('details', { class: 'tpl' });
  d.open = openIds.has(ex.id);
  d.addEventListener('toggle', () => {
    if (d.open) openIds.add(ex.id); else openIds.delete(ex.id);
  });

  const usageText = u.setCount === 0 && u.templateCount === 0
    ? '未使用'
    : `${u.dayCount}日・${u.setCount}セット・テンプレート${u.templateCount}件`;
  d.append(el('summary', { text: `${ex.name}  [${BODY_PARTS[ex.bodyPart]}・${TYPES[ex.type]}]  ${usageText}` }));

  const name = el('input', { type: 'text', value: ex.name });
  const part = el('select');
  for (const [v, l] of Object.entries(BODY_PARTS)) part.add(new Option(l, v));
  part.value = ex.bodyPart;
  const type = el('select');
  for (const [v, l] of Object.entries(TYPES)) type.add(new Option(l, v));
  type.value = ex.type;
  const note = el('textarea', { rows: 2, placeholder: '固定メモ', value: ex.note });

  const save = el('button', {
    class: 'primary', text: '保存',
    onclick: safe(async () => {
      if (type.value !== ex.type && u.setCount > 0) {
        const ok = confirm(
          `タイプを「${TYPES[ex.type]}」から「${TYPES[type.value]}」に変えます。\n` +
          `過去の ${u.setCount} セットの重量はそのままで、意味(実質重量・1RMの計算)が変わります。続けますか?`
        );
        if (!ok) return;
      }
      await gql(
        `mutation ($id: ID!, $name: String!, $bodyPart: BodyPart!, $type: ExerciseType!, $note: String!) {
          updateExercise(id: $id, name: $name, bodyPart: $bodyPart, type: $type, note: $note) { id }
        }`,
        { id: ex.id, name: name.value, bodyPart: part.value, type: type.value, note: note.value }
      );
      await load();
      toast(`「${name.value.trim()}」を保存しました`);
    }),
  });

  const del = el('button', {
    class: 'danger', text: '削除',
    onclick: safe(async () => {
      const lines = [`「${ex.name}」を削除しますか?`];
      if (u.setCount > 0) lines.push(`・過去の記録(${u.dayCount}日・${u.setCount}セット)も一緒に消えます`);
      if (u.templateCount > 0) lines.push(`・${u.templateCount}件のテンプレートからも外れます`);
      lines.push('元に戻せません。');
      if (!confirm(lines.join('\n'))) return;
      await gql(`mutation ($id: ID!) { deleteExercise(id: $id) }`, { id: ex.id });
      openIds.delete(ex.id);
      await load();
      toast(`「${ex.name}」を削除しました`);
    }),
  });

  d.append(
    el('div', { class: 'column' },
      name,
      el('div', { class: 'row' }, part, type),
      note,
      el('div', { class: 'row' }, save, del)
    )
  );
  return d;
}

// ---------- バックアップ ----------
$('export-btn').addEventListener('click', safe(async () => {
  const { exportData } = await gql(`{ exportData }`);
  const blob = new Blob([exportData], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `workout-backup-${toLocalDate()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  toast('バックアップを書き出しました');
}));

$('import-btn').addEventListener('click', () => $('import-file').click());

$('import-file').addEventListener('change', safe(async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!confirm(
    `「${file.name}」から復元します。\n` +
    'いまのデータはすべてこのファイルの内容に置き換わります(復元前のコピーは backups フォルダに残ります)。続けますか?'
  )) return;
  await gql(`mutation ($json: String!) { importData(json: $json) }`, { json: await file.text() });
  await load();
  toast('復元しました');
}));

load().catch((err) => alert(err.message));
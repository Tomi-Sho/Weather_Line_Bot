import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// ---------- DB ----------
const db = new Database('workout.db');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS exercises (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE,
    body_part TEXT NOT NULL,
    type      TEXT NOT NULL DEFAULT 'normal',
    note      TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS workouts (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    memo TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS workout_exercises (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_id  INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    position    INTEGER NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    target_reps TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS sets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_exercise_id INTEGER NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
    set_number          INTEGER NOT NULL,
    weight              REAL,
    reps                INTEGER,
    note                TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS templates (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    is_preset INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS template_exercises (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    position    INTEGER NOT NULL,
    set_count   INTEGER NOT NULL DEFAULT 3,
    target_reps TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS body_weights (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    date   TEXT NOT NULL UNIQUE,
    weight REAL NOT NULL
  );
`);

// 既存DBに target_reps 列が無ければ追加
if (!db.prepare('PRAGMA table_info(workout_exercises)').all().some((c) => c.name === 'target_reps')) {
  db.exec(`ALTER TABLE workout_exercises ADD COLUMN target_reps TEXT NOT NULL DEFAULT ''`);
}

// ---------- 初心者向けテンプレート(初回のみ登録) ----------
// 自重種目は weighted(0 = 自重)で登録
const PRESET_EXERCISES = [
  ['ベンチプレス', 'chest', 'normal'],
  ['インクラインダンベルプレス', 'chest', 'normal'],
  ['ダンベルフライ', 'chest', 'normal'],
  ['ラットプルダウン', 'back', 'normal'],
  ['シーテッドロウ', 'back', 'normal'],
  ['ワンハンドローイング', 'back', 'normal'],
  ['ショルダープレス', 'shoulders', 'normal'],
  ['サイドレイズ', 'shoulders', 'normal'],
  ['リアレイズ', 'shoulders', 'normal'],
  ['ダンベルカール', 'arms', 'normal'],
  ['ハンマーカール', 'arms', 'normal'],
  ['トライセプスプレスダウン', 'arms', 'normal'],
  ['スクワット', 'legs', 'normal'],
  ['レッグプレス', 'legs', 'normal'],
  ['レッグカール', 'legs', 'normal'],
  ['クランチ', 'abs', 'weighted'],
  ['レッグレイズ', 'abs', 'weighted'],
  ['ロシアンツイスト', 'abs', 'weighted'],
];
// [テンプレート名, [[種目名, セット数, 目安回数], ...]]
const PRESET_TEMPLATES = [
  ['【初心者】胸', [['ベンチプレス', 3, '8-10'], ['インクラインダンベルプレス', 3, '10-12'], ['ダンベルフライ', 2, '12-15']]],
  ['【初心者】背中', [['ラットプルダウン', 3, '8-12'], ['シーテッドロウ', 3, '10-12'], ['ワンハンドローイング', 2, '10-12']]],
  ['【初心者】肩', [['ショルダープレス', 3, '8-12'], ['サイドレイズ', 3, '12-15'], ['リアレイズ', 2, '12-15']]],
  ['【初心者】腕', [['ダンベルカール', 3, '10-12'], ['ハンマーカール', 2, '10-12'], ['トライセプスプレスダウン', 3, '10-15']]],
  ['【初心者】脚', [['スクワット', 3, '8-10'], ['レッグプレス', 3, '10-12'], ['レッグカール', 2, '12-15']]],
  ['【初心者】腹筋', [['クランチ', 3, '15-20'], ['レッグレイズ', 3, '10-15'], ['ロシアンツイスト', 2, '20']]],
];

if (db.prepare('SELECT COUNT(*) AS c FROM templates WHERE is_preset = 1').get().c === 0) {
  db.transaction(() => {
    const insEx = db.prepare('INSERT OR IGNORE INTO exercises (name, body_part, type) VALUES (?, ?, ?)');
    for (const [name, part, type] of PRESET_EXERCISES) insEx.run(name, part, type);

    for (const [tname, items] of PRESET_TEMPLATES) {
      const t = db.prepare('INSERT INTO templates (name, is_preset) VALUES (?, 1)').run(tname);
      items.forEach(([exName, setCount, reps], i) => {
        const ex = db.prepare('SELECT id FROM exercises WHERE name = ?').get(exName);
        db.prepare(
          'INSERT INTO template_exercises (template_id, exercise_id, position, set_count, target_reps) VALUES (?, ?, ?, ?, ?)'
        ).run(t.lastInsertRowid, ex.id, i + 1, setCount, reps);
      });
    }
  })();
}

// バックアップ対象のテーブル(親 → 子の順)
const BACKUP_TABLES = [
  'exercises', 'workouts', 'workout_exercises', 'sets',
  'templates', 'template_exercises', 'body_weights',
];

const round1 = (v) => Math.round(v * 10) / 10;

// その日以前で最新の体重(記録がなければ null)
const bodyWeightOn = (date) =>
  db.prepare('SELECT weight FROM body_weights WHERE date <= ? ORDER BY date DESC LIMIT 1')
    .get(date)?.weight ?? null;

// 実質重量: 通常=そのまま / 加重=体重+追加 / アシスト=体重-補助
const effectiveWeight = (type, weight, bw) => {
  if (weight == null) return null;
  if (type === 'normal') return weight;
  if (bw == null) return null;
  const v = type === 'weighted' ? bw + weight : bw - weight;
  return v > 0 ? round1(v) : null;
};

// 推定1RM(Epley式)。実質重量が出せないときは null
const calc1RM = (type, weight, reps, bw = null) => {
  const w = effectiveWeight(type, weight, bw);
  if (w == null || reps == null || reps < 1) return null;
  return round1(reps === 1 ? w : w * (1 + reps / 30));
};

// ---------- スキーマ ----------
const typeDefs = `#graphql
  enum BodyPart { chest back shoulders arms legs abs other }
  enum ExerciseType { normal weighted assisted }

  type Exercise {
    id: ID!
    name: String!
    bodyPart: BodyPart!
    type: ExerciseType!
    note: String!
  }

  type WorkoutSet {
    id: ID!
    setNumber: Int!
    weight: Float
    reps: Int
    note: String!
    effectiveWeight: Float
    estimated1RM: Float
  }

  type WorkoutExercise {
    id: ID!
    exercise: Exercise!
    position: Int!
    note: String!
    targetReps: String!
    sets: [WorkoutSet!]!
    previous: PreviousRecord
  }

  type PreviousRecord {
    date: String!
    note: String!
    sets: [WorkoutSet!]!
  }

  type Workout {
    id: ID!
    date: String!
    memo: String!
    exercises: [WorkoutExercise!]!
  }

  type TemplateExercise {
    id: ID!
    exercise: Exercise!
    position: Int!
    setCount: Int!
    targetReps: String!
  }

  type Template {
    id: ID!
    name: String!
    isPreset: Boolean!
    exercises: [TemplateExercise!]!
  }

  type ExerciseUsage {
    exercise: Exercise!
    setCount: Int!
    dayCount: Int!
    templateCount: Int!
  }

  type BodyWeight {
    id: ID!
    date: String!
    weight: Float!
  }

  type ExerciseRecord {
    exercise: Exercise!
    bestWeight: Float!
    best1RM: Float
  }

  type Query {
    exercises(bodyPart: BodyPart): [Exercise!]!
    workout(date: String!): Workout
    workouts(from: String, to: String, bodyPart: BodyPart): [Workout!]!
    records(bodyPart: BodyPart): [ExerciseRecord!]!
    templates: [Template!]!
    bodyWeights(from: String, to: String): [BodyWeight!]!
    exerciseUsage: [ExerciseUsage!]!
    exportData: String!
  }

  type Mutation {
    addExercise(name: String!, bodyPart: BodyPart!, type: ExerciseType = normal, note: String = ""): Exercise!
    updateExerciseNote(id: ID!, note: String!): Exercise!

    addWorkoutExercise(date: String!, exerciseId: ID!): WorkoutExercise!
    removeWorkoutExercise(id: ID!): Boolean!
    updateWorkoutExerciseNote(id: ID!, note: String!): WorkoutExercise!

    addSet(workoutExerciseId: ID!): WorkoutSet!
    updateSet(id: ID!, weight: Float, reps: Int, note: String): WorkoutSet!
    deleteSet(id: ID!): Boolean!

    createTemplate(name: String!): Template!
    duplicateTemplate(id: ID!): Template!
    deleteTemplate(id: ID!): Boolean!
    addTemplateExercise(templateId: ID!, exerciseId: ID!, setCount: Int = 3, targetReps: String = ""): TemplateExercise!
    updateTemplateExercise(id: ID!, setCount: Int, targetReps: String): TemplateExercise!
    removeTemplateExercise(id: ID!): Boolean!
    startWorkoutFromTemplate(date: String!, templateId: ID!): Workout!
    clearWorkout(date: String!): Int!

    setBodyWeight(date: String!, weight: Float!): BodyWeight!
    deleteBodyWeight(date: String!): Boolean!
    updateExercise(id: ID!, name: String!, bodyPart: BodyPart!, type: ExerciseType!, note: String!): Exercise!
    deleteExercise(id: ID!): Int!
    importData(json: String!): Boolean!
  }
`;

// ---------- 変換ヘルパー ----------
const toExercise = (r) => ({
  id: r.id, name: r.name, bodyPart: r.body_part, type: r.type, note: r.note,
});
const toSet = (r, type, bw = null) => ({
  id: r.id, setNumber: r.set_number, weight: r.weight, reps: r.reps, note: r.note,
  effectiveWeight: effectiveWeight(type, r.weight, bw),
  estimated1RM: calc1RM(type, r.weight, r.reps, bw),
});
const toWorkoutExercise = (r) => ({
  id: r.id, workoutId: r.workout_id, exerciseId: r.exercise_id,
  position: r.position, note: r.note, targetReps: r.target_reps,
});
const toWorkout = (r) => ({ id: r.id, date: r.date, memo: r.memo });
const toTemplate = (r) => ({ id: r.id, name: r.name, isPreset: !!r.is_preset });
const toTemplateExercise = (r) => ({
  id: r.id, templateId: r.template_id, exerciseId: r.exercise_id,
  position: r.position, setCount: r.set_count, targetReps: r.target_reps,
});

const getExercise = (id) => {
  const row = db.prepare('SELECT * FROM exercises WHERE id = ?').get(id);
  if (!row) throw new Error('種目が見つかりません');
  return row;
};
const getWorkoutExercise = (id) => {
  const row = db.prepare('SELECT * FROM workout_exercises WHERE id = ?').get(id);
  if (!row) throw new Error('記録が見つかりません');
  return row;
};
const getTemplate = (id) => {
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
  if (!row) throw new Error('テンプレートが見つかりません');
  return row;
};
const getTemplateExercise = (id) => {
  const row = db.prepare('SELECT * FROM template_exercises WHERE id = ?').get(id);
  if (!row) throw new Error('テンプレートの種目が見つかりません');
  return row;
};
// 初心者向けテンプレートは編集不可
const getEditableTemplate = (id) => {
  const t = getTemplate(id);
  if (t.is_preset) throw new Error('初心者向けテンプレートは編集できません。「複製して編集」を使ってください');
  return t;
};

const dateOfWorkout = (workoutId) =>
  db.prepare('SELECT date FROM workouts WHERE id = ?').get(workoutId).date;

// その日の体重で実質重量・1RMを計算するため、日付を受け取る
const setsOf = (workoutExerciseId, type, date) => {
  const bw = bodyWeightOn(date);
  return db.prepare('SELECT * FROM sets WHERE workout_exercise_id = ? ORDER BY set_number')
    .all(workoutExerciseId)
    .map((r) => toSet(r, type, bw));
};

// その日のトレーニングを取得(無ければ作る)
const getOrCreateWorkoutId = (date) => {
  const w = db.prepare('SELECT id FROM workouts WHERE date = ?').get(date);
  if (w) return w.id;
  return db.prepare('INSERT INTO workouts (date) VALUES (?)').run(date).lastInsertRowid;
};

// その日に種目を末尾追加し、セットを setCount 行ぶん用意する
const insertWorkoutExercise = (workoutId, exerciseId, setCount = 1, targetReps = '') => {
  const pos = db.prepare(
    'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM workout_exercises WHERE workout_id = ?'
  ).get(workoutId).p;
  const r = db
    .prepare('INSERT INTO workout_exercises (workout_id, exercise_id, position, target_reps) VALUES (?, ?, ?, ?)')
    .run(workoutId, exerciseId, pos, targetReps);
  const insSet = db.prepare('INSERT INTO sets (workout_exercise_id, set_number) VALUES (?, ?)');
  for (let n = 1; n <= setCount; n++) insSet.run(r.lastInsertRowid, n);
  return r.lastInsertRowid;
};

const nextTemplatePosition = (templateId) =>
  db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM template_exercises WHERE template_id = ?')
    .get(templateId).p;

const checkSetCount = (n) => {
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('セット数は1〜20で入力してください');
};

// ---------- リゾルバ ----------
const resolvers = {
  Query: {
    exercises: (_, { bodyPart }) => {
      const rows = bodyPart
        ? db.prepare('SELECT * FROM exercises WHERE body_part = ? ORDER BY name').all(bodyPart)
        : db.prepare('SELECT * FROM exercises ORDER BY body_part, name').all();
      return rows.map(toExercise);
    },

    workout: (_, { date }) => {
      const row = db.prepare('SELECT * FROM workouts WHERE date = ?').get(date);
      return row ? toWorkout(row) : null;
    },

    workouts: (_, { from, to, bodyPart }) => {
      const cond = [];
      const params = [];
      if (from) { cond.push('w.date >= ?'); params.push(from); }
      if (to) { cond.push('w.date <= ?'); params.push(to); }
      if (bodyPart) {
        cond.push(`EXISTS (
          SELECT 1 FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id
          WHERE we.workout_id = w.id AND e.body_part = ?)`);
        params.push(bodyPart);
      }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      return db.prepare(`SELECT w.* FROM workouts w ${where} ORDER BY w.date DESC`)
        .all(...params).map(toWorkout);
    },

    // 種目別ベスト。アシストは補助が小さいほど強い
    records: (_, { bodyPart }) => {
      const where = bodyPart ? 'WHERE e.body_part = ? AND' : 'WHERE';
      const rows = db.prepare(`
        SELECT e.id AS e_id, e.name, e.body_part, e.type, e.note, s.weight, s.reps, w.date
        FROM sets s
        JOIN workout_exercises we ON we.id = s.workout_exercise_id
        JOIN workouts w ON w.id = we.workout_id
        JOIN exercises e ON e.id = we.exercise_id
        ${where} s.weight IS NOT NULL AND s.reps IS NOT NULL
      `).all(...(bodyPart ? [bodyPart] : []));

      const bwCache = new Map();
      const bwOn = (d) => {
        if (!bwCache.has(d)) bwCache.set(d, bodyWeightOn(d));
        return bwCache.get(d);
      };

      const byEx = new Map();
      for (const r of rows) {
        const e1rm = calc1RM(r.type, r.weight, r.reps, bwOn(r.date));
        const cur = byEx.get(r.e_id) ?? {
          exercise: toExercise({ id: r.e_id, name: r.name, body_part: r.body_part, type: r.type, note: r.note }),
          bestWeight: r.weight,
          best1RM: null,
        };
        // アシストは補助が小さいほど強い
        cur.bestWeight = r.type === 'assisted'
          ? Math.min(cur.bestWeight, r.weight)
          : Math.max(cur.bestWeight, r.weight);
        if (e1rm != null) cur.best1RM = Math.max(cur.best1RM ?? 0, e1rm);
        byEx.set(r.e_id, cur);
      }
      return [...byEx.values()];
    },
    // 日付の古い順で返す
    bodyWeights: (_, { from, to }) => {
      const cond = [];
      const params = [];
      if (from) { cond.push('date >= ?'); params.push(from); }
      if (to) { cond.push('date <= ?'); params.push(to); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      return db.prepare(`SELECT * FROM body_weights ${where} ORDER BY date`).all(...params);
    },

    // 種目ごとの使用状況(管理画面と削除確認に使う)
    exerciseUsage: () => {
      const rows = db.prepare(`
        SELECT e.*,
          (SELECT COUNT(*) FROM sets s
            JOIN workout_exercises we ON we.id = s.workout_exercise_id
            WHERE we.exercise_id = e.id) AS set_count,
          (SELECT COUNT(DISTINCT we.workout_id) FROM workout_exercises we
            WHERE we.exercise_id = e.id) AS day_count,
          (SELECT COUNT(*) FROM template_exercises te WHERE te.exercise_id = e.id) AS template_count
        FROM exercises e ORDER BY e.body_part, e.name
      `).all();
      return rows.map((r) => ({
        exercise: toExercise(r),
        setCount: r.set_count,
        dayCount: r.day_count,
        templateCount: r.template_count,
      }));
    },

    // 全テーブルをJSON文字列で書き出す
    exportData: () => {
      const dump = { version: 1, exportedAt: new Date().toISOString(), tables: {} };
      for (const t of BACKUP_TABLES) dump.tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
      return JSON.stringify(dump);
    },

    // 初心者向け(先頭)→自分用の順
    templates: () =>
      db.prepare('SELECT * FROM templates ORDER BY is_preset DESC, id').all().map(toTemplate),
  },

  Workout: {
    exercises: (w) =>
      db.prepare('SELECT * FROM workout_exercises WHERE workout_id = ? ORDER BY position')
        .all(w.id).map(toWorkoutExercise),
  },

  WorkoutExercise: {
    exercise: (we) => toExercise(getExercise(we.exerciseId)),
    sets: (we) => setsOf(we.id, getExercise(we.exerciseId).type, dateOfWorkout(we.workoutId)),
    // 同じ種目で、今日より前の最新の記録
    previous: (we) => {
      const ex = getExercise(we.exerciseId);
      const date = db.prepare('SELECT date FROM workouts WHERE id = ?').get(we.workoutId).date;
      const prev = db.prepare(`
        SELECT we.id, we.note, w.date
        FROM workout_exercises we JOIN workouts w ON w.id = we.workout_id
        WHERE we.exercise_id = ? AND w.date < ?
        ORDER BY w.date DESC LIMIT 1
      `).get(we.exerciseId, date);
      if (!prev) return null;
      return { date: prev.date, note: prev.note, sets: setsOf(prev.id, ex.type, prev.date) };
    },
  },

  Template: {
    exercises: (t) =>
      db.prepare('SELECT * FROM template_exercises WHERE template_id = ? ORDER BY position')
        .all(t.id).map(toTemplateExercise),
  },

  TemplateExercise: {
    exercise: (te) => toExercise(getExercise(te.exerciseId)),
  },

  Mutation: {
    addExercise: (_, { name, bodyPart, type, note }) => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('種目名を入力してください');
      try {
        const result = db
          .prepare('INSERT INTO exercises (name, body_part, type, note) VALUES (?, ?, ?, ?)')
          .run(trimmed, bodyPart, type, note);
        return toExercise(getExercise(result.lastInsertRowid));
      } catch (e) {
        if (String(e.code).startsWith('SQLITE_CONSTRAINT')) {
          throw new Error('その種目はすでに登録されています');
        }
        throw e;
      }
    },

    updateExerciseNote: (_, { id, note }) => {
      getExercise(id);
      db.prepare('UPDATE exercises SET note = ? WHERE id = ?').run(note, id);
      return toExercise(getExercise(id));
    },

    addWorkoutExercise: (_, { date, exerciseId }) => {
      getExercise(exerciseId);
      const id = db.transaction(() =>
        insertWorkoutExercise(getOrCreateWorkoutId(date), exerciseId, 1, '')
      )();
      return toWorkoutExercise(getWorkoutExercise(id));
    },

    removeWorkoutExercise: (_, { id }) =>
      db.prepare('DELETE FROM workout_exercises WHERE id = ?').run(id).changes > 0,

    updateWorkoutExerciseNote: (_, { id, note }) => {
      getWorkoutExercise(id);
      db.prepare('UPDATE workout_exercises SET note = ? WHERE id = ?').run(note, id);
      return toWorkoutExercise(getWorkoutExercise(id));
    },

    addSet: (_, { workoutExerciseId }) => {
      const we = getWorkoutExercise(workoutExerciseId);
      const next = db.prepare(
        'SELECT COALESCE(MAX(set_number), 0) + 1 AS n FROM sets WHERE workout_exercise_id = ?'
      ).get(workoutExerciseId).n;
      const r = db
        .prepare('INSERT INTO sets (workout_exercise_id, set_number) VALUES (?, ?)')
        .run(workoutExerciseId, next);
      const type = getExercise(we.exercise_id).type;
      const bw = bodyWeightOn(dateOfWorkout(we.workout_id));
      return toSet(db.prepare('SELECT * FROM sets WHERE id = ?').get(r.lastInsertRowid), type, bw);
    },

    updateSet: (_, args) => {
      const row = db.prepare('SELECT * FROM sets WHERE id = ?').get(args.id);
      if (!row) throw new Error('セットが見つかりません');
      const we = getWorkoutExercise(row.workout_exercise_id);
      const ex = getExercise(we.exercise_id);

      const weight = 'weight' in args ? args.weight : row.weight;
      const reps = 'reps' in args ? args.reps : row.reps;
      const note = args.note ?? row.note;

      if (weight != null && (ex.type === 'normal' ? weight <= 0 : weight < 0)) {
        throw new Error(ex.type === 'normal' ? '重量は0より大きく入力してください' : '重量は0以上で入力してください');
      }
      if (reps != null && reps < 1) throw new Error('回数は1以上で入力してください');

      db.prepare('UPDATE sets SET weight = ?, reps = ?, note = ? WHERE id = ?')
        .run(weight, reps, note, args.id);
      const bw = bodyWeightOn(dateOfWorkout(we.workout_id));
      return toSet(db.prepare('SELECT * FROM sets WHERE id = ?').get(args.id), ex.type, bw);
    },

    deleteSet: (_, { id }) =>
      db.prepare('DELETE FROM sets WHERE id = ?').run(id).changes > 0,

    // ----- テンプレート -----
    createTemplate: (_, { name }) => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('テンプレート名を入力してください');
      const r = db.prepare('INSERT INTO templates (name, is_preset) VALUES (?, 0)').run(trimmed);
      return toTemplate(getTemplate(r.lastInsertRowid));
    },

    // 初心者向けでも自分用でも複製できる(複製は自分用になる)
    duplicateTemplate: (_, { id }) => {
      const src = getTemplate(id);
      const newId = db.transaction(() => {
        const r = db.prepare('INSERT INTO templates (name, is_preset) VALUES (?, 0)')
          .run(`${src.name.replace(/^【初心者】/, '')}(コピー)`);
        db.prepare(`
          INSERT INTO template_exercises (template_id, exercise_id, position, set_count, target_reps)
          SELECT ?, exercise_id, position, set_count, target_reps
          FROM template_exercises WHERE template_id = ?
        `).run(r.lastInsertRowid, id);
        return r.lastInsertRowid;
      })();
      return toTemplate(getTemplate(newId));
    },

    deleteTemplate: (_, { id }) => {
      getEditableTemplate(id);
      return db.prepare('DELETE FROM templates WHERE id = ?').run(id).changes > 0;
    },

    addTemplateExercise: (_, { templateId, exerciseId, setCount, targetReps }) => {
      getEditableTemplate(templateId);
      getExercise(exerciseId);
      checkSetCount(setCount);
      const r = db.prepare(
        'INSERT INTO template_exercises (template_id, exercise_id, position, set_count, target_reps) VALUES (?, ?, ?, ?, ?)'
      ).run(templateId, exerciseId, nextTemplatePosition(templateId), setCount, targetReps.trim());
      return toTemplateExercise(getTemplateExercise(r.lastInsertRowid));
    },

    updateTemplateExercise: (_, { id, setCount, targetReps }) => {
      const te = getTemplateExercise(id);
      getEditableTemplate(te.template_id);
      const nextCount = setCount ?? te.set_count;
      checkSetCount(nextCount);
      db.prepare('UPDATE template_exercises SET set_count = ?, target_reps = ? WHERE id = ?')
        .run(nextCount, (targetReps ?? te.target_reps).trim(), id);
      return toTemplateExercise(getTemplateExercise(id));
    },

    removeTemplateExercise: (_, { id }) => {
      const te = getTemplateExercise(id);
      getEditableTemplate(te.template_id);
      return db.prepare('DELETE FROM template_exercises WHERE id = ?').run(id).changes > 0;
    },

    // テンプレートの種目を、その日の記録に追加(すでに記録がある日は末尾に足される)
    startWorkoutFromTemplate: (_, { date, templateId }) => {
      getTemplate(templateId);
      const items = db.prepare('SELECT * FROM template_exercises WHERE template_id = ? ORDER BY position').all(templateId);
      if (items.length === 0) throw new Error('このテンプレートには種目がありません');
      const workoutId = db.transaction(() => {
        const wid = getOrCreateWorkoutId(date);
        for (const it of items) insertWorkoutExercise(wid, it.exercise_id, it.set_count, it.target_reps);
        return wid;
      })();
      return toWorkout(db.prepare('SELECT * FROM workouts WHERE id = ?').get(workoutId));
    },
    // その日の記録をすべて削除。消した種目数を返す(記録が無い日は0)
    clearWorkout: (_, { date }) => {
      const w = db.prepare('SELECT id FROM workouts WHERE date = ?').get(date);
      if (!w) return 0;
      return db.transaction(() => {
        const count = db.prepare('SELECT COUNT(*) AS c FROM workout_exercises WHERE workout_id = ?').get(w.id).c;
        // workout_exercises と sets は ON DELETE CASCADE で一緒に消える
        db.prepare('DELETE FROM workouts WHERE id = ?').run(w.id);
        return count;
      })();
    },
    // 同じ日付なら上書き
    setBodyWeight: (_, { date, weight }) => {
      if (!(weight >= 20 && weight <= 300)) throw new Error('体重は20〜300kgの範囲で入力してください');
      db.prepare(`
        INSERT INTO body_weights (date, weight) VALUES (?, ?)
        ON CONFLICT(date) DO UPDATE SET weight = excluded.weight
      `).run(date, weight);
      return db.prepare('SELECT * FROM body_weights WHERE date = ?').get(date);
    },

    deleteBodyWeight: (_, { date }) =>
      db.prepare('DELETE FROM body_weights WHERE date = ?').run(date).changes > 0,
    updateExercise: (_, { id, name, bodyPart, type, note }) => {
      getExercise(id);
      const trimmed = name.trim();
      if (!trimmed) throw new Error('種目名を入力してください');
      try {
        db.prepare('UPDATE exercises SET name = ?, body_part = ?, type = ?, note = ? WHERE id = ?')
          .run(trimmed, bodyPart, type, note, id);
      } catch (e) {
        if (String(e.code).startsWith('SQLITE_CONSTRAINT')) {
          throw new Error('同じ名前の種目がすでにあります');
        }
        throw e;
      }
      return toExercise(getExercise(id));
    },

    // 種目と、その種目の記録・テンプレート内の項目をまとめて削除。消した記録(種目)数を返す
    deleteExercise: (_, { id }) => {
      getExercise(id);
      return db.transaction(() => {
        const count = db.prepare('SELECT COUNT(*) AS c FROM workout_exercises WHERE exercise_id = ?').get(id).c;
        // sets は workout_exercises の削除に連動して消える
        db.prepare('DELETE FROM workout_exercises WHERE exercise_id = ?').run(id);
        db.prepare('DELETE FROM template_exercises WHERE exercise_id = ?').run(id);
        db.prepare('DELETE FROM exercises WHERE id = ?').run(id);
        // 種目が空になった日(workout)は残さない
        db.prepare('DELETE FROM workouts WHERE id NOT IN (SELECT DISTINCT workout_id FROM workout_exercises)').run();
        return count;
      })();
    },

    // 復元: 事前に現在のDBをコピーしてから、全テーブルを置き換える
    importData: (_, { json }) => {
      let dump;
      try { dump = JSON.parse(json); } catch { throw new Error('JSONの形式が正しくありません'); }
      if (!dump?.tables) throw new Error('このアプリのバックアップファイルではありません');
      for (const t of BACKUP_TABLES) {
        if (!Array.isArray(dump.tables[t])) throw new Error(`バックアップに ${t} がありません`);
      }

      fs.mkdirSync('backups', { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      db.exec(`VACUUM INTO '${path.join('backups', `before-restore-${stamp}.db`).replace(/'/g, "''")}'`);

      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          for (const t of [...BACKUP_TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
          for (const t of BACKUP_TABLES) {
            const rows = dump.tables[t];
            if (rows.length === 0) continue;
            const cols = Object.keys(rows[0]);
            const ins = db.prepare(
              `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
            );
            for (const r of rows) ins.run(cols.map((c) => r[c]));
          }
          const bad = db.pragma('foreign_key_check');
          if (bad.length > 0) throw new Error('バックアップの内容に矛盾があります(復元は取り消されました)');
        })();
      } finally {
        db.pragma('foreign_keys = ON');
      }
      return true;
    },
  },
};

// ---------- 起動 ----------
const server = new ApolloServer({ typeDefs, resolvers });
const { url } = await startStandaloneServer(server, { listen: { port: 4000 } });
console.log(`🚀 サーバーが起動しました: ${url}`);
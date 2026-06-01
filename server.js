const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ════════════════════════════════════════
//  DB INIT
// ════════════════════════════════════════
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value JSONB
      );

      CREATE TABLE IF NOT EXISTS kids (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        name_en TEXT,
        avatar TEXT DEFAULT '👦',
        color TEXT DEFAULT '#FFB347',
        bg TEXT DEFAULT '#FFF8E1',
        photo TEXT,
        kid_pin TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- weeks table: each week has a number, mode, and status
      CREATE TABLE IF NOT EXISTS weeks (
        id SERIAL PRIMARY KEY,
        kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE,
        week_number INTEGER NOT NULL DEFAULT 1,
        mode TEXT DEFAULT 'summer',
        label TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS activities (
        id SERIAL PRIMARY KEY,
        kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE,
        week_id INTEGER REFERENCES weeks(id) ON DELETE CASCADE,
        day_index INTEGER DEFAULT 0,
        name TEXT NOT NULL,
        name_en TEXT,
        time_val TEXT DEFAULT '09:00',
        duration INTEGER DEFAULT 30,
        category TEXT DEFAULT 'fun',
        emoji TEXT DEFAULT '⭐',
        points INTEGER DEFAULT 5,
        is_free BOOLEAN DEFAULT false,
        choices JSONB DEFAULT '[]',
        done BOOLEAN DEFAULT false,
        picked_choice JSONB DEFAULT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rewards (
        id SERIAL PRIMARY KEY,
        kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        name_en TEXT,
        emoji TEXT DEFAULT '🎁',
        points_needed INTEGER DEFAULT 50,
        claimed BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // migrate old activities if they exist without week_id
    await client.query(`
      ALTER TABLE activities ADD COLUMN IF NOT EXISTS week_id INTEGER REFERENCES weeks(id) ON DELETE CASCADE;
    `).catch(() => {});

    await client.query(`
      INSERT INTO app_settings (key, value) VALUES
        ('parent_pin', 'null'), ('lang', '"ar"'), ('mode', '"summer"'),
        ('sound', 'true'), ('volume', '0.6')
      ON CONFLICT (key) DO NOTHING;
    `);

    // seed default kids if none
    const { rows } = await client.query('SELECT COUNT(*) FROM kids');
    if (parseInt(rows[0].count) === 0) {
      const k1 = await client.query(`INSERT INTO kids (name,name_en,avatar,color,bg,sort_order) VALUES ('أحمد','Ahmed','👦','#FFB347','#FFF8E1',0) RETURNING id`);
      const k2 = await client.query(`INSERT INTO kids (name,name_en,avatar,color,bg,sort_order) VALUES ('محمد','Mohamed','🧒','#87CEEB','#E3F2FD',1) RETURNING id`);
      for (const kid of [k1.rows[0], k2.rows[0]]) {
        await createWeekForKid(client, kid.id, 'summer', 1, 'الأسبوع الأول');
        await createWeekForKid(client, kid.id, 'school', 1, 'الأسبوع الأول');
        await client.query(`INSERT INTO rewards (kid_id,name,name_en,emoji,points_needed) VALUES ($1,'ساعة شاشة إضافية','Extra screen hour','📱',30),($1,'وجبة مفضلة','Favourite meal','🍕',50),($1,'رحلة النادي','Club trip','🏊',80),($1,'لعبة جديدة','New game','🎮',150)`, [kid.id]);
      }
      console.log('✅ Default data inserted');
    }

    // migrate old activities (without week_id) into week system
    const orphans = await client.query(`SELECT COUNT(*) FROM activities WHERE week_id IS NULL`);
    if (parseInt(orphans.rows[0].count) > 0) {
      console.log('Migrating old activities...');
      const allKids = await client.query('SELECT id FROM kids');
      for (const kid of allKids.rows) {
        const modes = ['summer', 'school'];
        for (const mode of modes) {
          // Get activities for this kid+mode (old schema had mode column)
          let modeActs = [];
          try {
            const r = await client.query(
              `SELECT * FROM activities WHERE kid_id=$1 AND mode=$2 AND week_id IS NULL`,
              [kid.id, mode]
            );
            modeActs = r.rows;
          } catch(e) {
            // mode column might not exist in old schema - try without
            const r = await client.query(
              `SELECT * FROM activities WHERE kid_id=$1 AND week_id IS NULL`,
              [kid.id]
            );
            modeActs = r.rows;
          }

          if (!modeActs.length) continue;

          // Check if active week exists for this mode
          const aw = await client.query(
            `SELECT id FROM weeks WHERE kid_id=$1 AND mode=$2 AND is_active=true LIMIT 1`,
            [kid.id, mode]
          );
          let weekId;
          if (aw.rows.length) {
            weekId = aw.rows[0].id;
          } else {
            const nw = await client.query(
              `INSERT INTO weeks (kid_id,week_number,mode,label,is_active) VALUES ($1,1,$2,'الأسبوع الأول',true) RETURNING id`,
              [kid.id, mode]
            );
            weekId = nw.rows[0].id;
          }
          // Assign activities to this week
          await client.query(
            `UPDATE activities SET week_id=$1 WHERE kid_id=$2 AND week_id IS NULL`,
            [weekId, kid.id]
          );
        }
        // Delete any remaining orphans that couldn't be migrated
        await client.query(`DELETE FROM activities WHERE kid_id=$1 AND week_id IS NULL`, [kid.id]);
      }
      console.log('✅ Migration done');
    }

    console.log('✅ DB ready');
  } finally {
    client.release();
  }
}

async function createWeekForKid(client, kidId, mode, weekNum, label) {
  const w = await client.query(
    `INSERT INTO weeks (kid_id,week_number,mode,label,is_active) VALUES ($1,$2,$3,$4,true) RETURNING id`,
    [kidId, weekNum, mode, label]
  );
  const weekId = w.rows[0].id;
  const numDays = mode === 'summer' ? 7 : 5;
  
  const summerActs = [
    ['الصلاة والإفطار','Prayer & Breakfast','07:00',30,'worship','🤲',10,false,'[]'],
    ['قراءة حرة','Free Reading','08:00',45,'study','📖',8,true,'[{"text":"قصة عمر وعمرو","emoji":"📖","color":"#7986CB"},{"text":"مغامرات كابتن عنتر","emoji":"🦸","color":"#FF8FAB"},{"text":"ابن بطوطة الصغير","emoji":"🌍","color":"#4DB6AC"},{"text":"كليلة ودمنة","emoji":"🦁","color":"#FFB347"}]'],
    ['رياضة','Sport','09:30',60,'sport','⚽',10,true,'[{"text":"كرة القدم","emoji":"⚽","color":"#66BB6A"},{"text":"سباحة","emoji":"🏊","color":"#64B5F6"},{"text":"دراجة","emoji":"🚴","color":"#FFB347"},{"text":"جري","emoji":"🏃","color":"#FF8FAB"}]'],
    ['ترتيب الغرفة','Clean Room','11:00',25,'duty','🧹',5,false,'[]'],
    ['الغداء','Lunch','13:30',45,'meal','🍽️',5,false,'[]'],
    ['وقت حر','Free Time','16:00',90,'fun','🎮',0,true,'[{"text":"لعبة فيديو","emoji":"🎮","color":"#7986CB"},{"text":"رسم وتلوين","emoji":"🎨","color":"#FF8FAB"},{"text":"ألعاب تركيب","emoji":"🧩","color":"#FFB347"},{"text":"مشاهدة كارتون","emoji":"🎬","color":"#4DB6AC"}]'],
    ['ترتيب الغرفة','Tidy Room','19:00',20,'duty','🛏️',5,false,'[]'],
  ];
  const schoolActs = [
    ['الصلاة والإفطار','Prayer & Breakfast','06:30',30,'worship','🤲',10,false,'[]'],
    ['تحضير الحقيبة','Prep Bag','07:00',15,'duty','🎒',5,false,'[]'],
    ['المدرسة','School','07:30',240,'study','📚',15,false,'[]'],
    ['مراجعة الدروس','Homework','15:00',60,'study','✏️',10,false,'[]'],
    ['وقت حر','Free Time','17:00',60,'fun','🎮',0,true,'[{"text":"لعبة فيديو","emoji":"🎮","color":"#7986CB"},{"text":"رسم","emoji":"🎨","color":"#FF8FAB"},{"text":"قراءة","emoji":"📖","color":"#FFB347"},{"text":"كارتون","emoji":"🎬","color":"#4DB6AC"}]'],
    ['ترتيب الغرفة','Tidy Room','19:00',20,'duty','🧹',5,false,'[]'],
  ];
  const acts = mode === 'summer' ? summerActs : schoolActs;

  for (let day = 0; day < numDays; day++) {
    for (const a of acts) {
      await client.query(
        `INSERT INTO activities (kid_id,week_id,day_index,name,name_en,time_val,duration,category,emoji,points,is_free,choices) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [kidId, weekId, day, ...a]
      );
    }
  }
  return weekId;
}

// ════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════
function today() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

function getDayIndex() {
  return new Date().getDay(); // 0=Sun ... 6=Sat
}

// ════════════════════════════════════════
//  API: SETTINGS
// ════════════════════════════════════════
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key,value FROM app_settings');
    const s = {};
    rows.forEach(r => s[r.key] = r.value);
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    await pool.query(`INSERT INTO app_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [key, JSON.stringify(value)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
//  API: KIDS
// ════════════════════════════════════════
app.get('/api/kids', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM kids ORDER BY sort_order,id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/kids', async (req, res) => {
  try {
    const { name, name_en, avatar, color, bg } = req.body;
    const { rows: ex } = await pool.query('SELECT MAX(sort_order) as mx FROM kids');
    const order = (ex[0].mx || 0) + 1;
    const { rows } = await pool.query(
      `INSERT INTO kids (name,name_en,avatar,color,bg,sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, name_en || name, avatar || '👦', color || '#FFB347', bg || '#FFF8E1', order]
    );
    const kid = rows[0];
    // Create active weeks
    const client = await pool.connect();
    try {
      await createWeekForKid(client, kid.id, 'summer', 1, 'الأسبوع الأول');
      await createWeekForKid(client, kid.id, 'school', 1, 'الأسبوع الأول');
    } finally { client.release(); }
    await pool.query(`INSERT INTO rewards (kid_id,name,name_en,emoji,points_needed) VALUES ($1,'ساعة شاشة إضافية','Extra screen hour','📱',30),($1,'وجبة مفضلة','Favourite meal','🍕',50),($1,'رحلة النادي','Club trip','🏊',80),($1,'لعبة جديدة','New game','🎮',150)`, [kid.id]);
    res.json(kid);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/kids/:id', async (req, res) => {
  try {
    const { name, name_en, avatar, color, bg, photo, kid_pin } = req.body;
    const sets = [], params = [];
    let i = 1;
    if (name      !== undefined) { sets.push(`name=$${i++}`);      params.push(name); }
    if (name_en   !== undefined) { sets.push(`name_en=$${i++}`);   params.push(name_en); }
    if (avatar    !== undefined) { sets.push(`avatar=$${i++}`);    params.push(avatar); }
    if (color     !== undefined) { sets.push(`color=$${i++}`);     params.push(color); }
    if (bg        !== undefined) { sets.push(`bg=$${i++}`);        params.push(bg); }
    if (photo     !== undefined) { sets.push(`photo=$${i++}`);     params.push(photo); }
    if (kid_pin   !== undefined) { sets.push(`kid_pin=$${i++}`);   params.push(kid_pin === '' ? null : kid_pin); }
    if (!sets.length) return res.json({});
    params.push(req.params.id);
    const { rows } = await pool.query(`UPDATE kids SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, params);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/kids/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM kids WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/kids/:id/verify-pin', async (req, res) => {
  try {
    const { pin } = req.body;
    const { rows } = await pool.query('SELECT kid_pin FROM kids WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.json({ ok: false });
    res.json({ ok: !rows[0].kid_pin || rows[0].kid_pin === pin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
//  API: WEEKS
// ════════════════════════════════════════

// Get active week for a kid+mode
app.get('/api/weeks/active', async (req, res) => {
  try {
    const { kid_id, mode } = req.query;
    const { rows } = await pool.query(
      `SELECT * FROM weeks WHERE kid_id=$1 AND mode=$2 AND is_active=true ORDER BY id DESC LIMIT 1`,
      [kid_id, mode]
    );
    res.json(rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all weeks for a kid+mode (for history)
app.get('/api/weeks', async (req, res) => {
  try {
    const { kid_id, mode } = req.query;
    const { rows } = await pool.query(
      `SELECT w.*, 
        COUNT(a.id) as total_acts,
        COUNT(a.id) FILTER (WHERE a.done=true) as done_acts,
        COALESCE(SUM(a.points) FILTER (WHERE a.done=true), 0) as total_pts
       FROM weeks w
       LEFT JOIN activities a ON a.week_id=w.id
       WHERE w.kid_id=$1 AND w.mode=$2
       GROUP BY w.id ORDER BY w.week_number DESC`,
      [kid_id, mode]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create new week (archive current, start fresh)
app.post('/api/weeks/new', async (req, res) => {
  try {
    const { kid_id, mode, label, copy_template } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Archive current active week
      await client.query(`UPDATE weeks SET is_active=false WHERE kid_id=$1 AND mode=$2 AND is_active=true`, [kid_id, mode]);

      // Get next week number
      const { rows: wn } = await client.query(`SELECT MAX(week_number) as mx FROM weeks WHERE kid_id=$1 AND mode=$2`, [kid_id, mode]);
      const nextNum = (wn[0].mx || 0) + 1;

      // Create new week
      const weekLabel = label || (mode === 'ar' ? `الأسبوع ${nextNum}` : `Week ${nextNum}`);
      const weekId = await createWeekForKid(client, kid_id, mode, nextNum, weekLabel);

      // If copy_template = week_id, copy activities structure (not done/picked_choice)
      if (copy_template) {
        const { rows: tmpl } = await client.query(
          `SELECT * FROM activities WHERE week_id=$1 ORDER BY day_index, time_val`,
          [copy_template]
        );
        // Delete default-inserted acts and replace with template
        await client.query(`DELETE FROM activities WHERE week_id=$1`, [weekId]);
        for (const a of tmpl) {
          await client.query(
            `INSERT INTO activities (kid_id,week_id,day_index,name,name_en,time_val,duration,category,emoji,points,is_free,choices) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [kid_id, weekId, a.day_index, a.name, a.name_en, a.time_val, a.duration, a.category, a.emoji, a.points, a.is_free, JSON.stringify(a.choices || [])]
          );
        }
      }

      await client.query('COMMIT');

      const { rows: newWeek } = await client.query('SELECT * FROM weeks WHERE id=$1', [weekId]);
      res.json(newWeek[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
//  API: ACTIVITIES
// ════════════════════════════════════════
app.get('/api/activities', async (req, res) => {
  try {
    const { week_id, day_index } = req.query;
    const { rows } = await pool.query(
      `SELECT * FROM activities WHERE week_id=$1 AND day_index=$2 ORDER BY time_val`,
      [week_id, day_index]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get total points for a kid (all weeks)
app.get('/api/kids/:id/points', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(a.points),0) as total FROM activities a JOIN weeks w ON a.week_id=w.id WHERE w.kid_id=$1 AND a.done=true`,
      [req.params.id]
    );
    res.json({ total: parseInt(rows[0].total) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/activities', async (req, res) => {
  try {
    const { week_id, kid_id, day_index, name, name_en, time_val, duration, category, emoji, points, is_free, choices, apply } = req.body;

    // Determine which days to apply to
    const mode = req.body.mode;
    const maxDay = mode === 'school' ? 5 : 7;
    let days;
    if (apply === 'all') days = Array.from({length: maxDay}, (_, i) => i);
    else if (apply === 'weekdays') days = [0,1,2,3,4];
    else if (apply === 'weekend') days = [5,6];
    else days = [parseInt(day_index)];

    const inserted = [];
    for (const d of days) {
      const { rows } = await pool.query(
        `INSERT INTO activities (kid_id,week_id,day_index,name,name_en,time_val,duration,category,emoji,points,is_free,choices) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [kid_id, week_id, d, name, name_en || name, time_val, duration, category, emoji, points, is_free, JSON.stringify(choices || [])]
      );
      inserted.push(rows[0]);
    }
    res.json(inserted);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/activities/:id', async (req, res) => {
  try {
    const { name, name_en, time_val, duration, category, emoji, points, is_free, choices, done, picked_choice } = req.body;
    const sets = [], params = [];
    let i = 1;
    if (name          !== undefined) { sets.push(`name=$${i++}`);          params.push(name); }
    if (name_en       !== undefined) { sets.push(`name_en=$${i++}`);       params.push(name_en); }
    if (time_val      !== undefined) { sets.push(`time_val=$${i++}`);      params.push(time_val); }
    if (duration      !== undefined) { sets.push(`duration=$${i++}`);      params.push(duration); }
    if (category      !== undefined) { sets.push(`category=$${i++}`);      params.push(category); }
    if (emoji         !== undefined) { sets.push(`emoji=$${i++}`);         params.push(emoji); }
    if (points        !== undefined) { sets.push(`points=$${i++}`);        params.push(points); }
    if (is_free       !== undefined) { sets.push(`is_free=$${i++}`);       params.push(is_free); }
    if (choices       !== undefined) { sets.push(`choices=$${i++}`);       params.push(JSON.stringify(choices)); }
    if (done          !== undefined) { sets.push(`done=$${i++}`);          params.push(done); }
    if (picked_choice !== undefined) { sets.push(`picked_choice=$${i++}`); params.push(JSON.stringify(picked_choice)); }
    sets.push(`updated_at=NOW()`);
    params.push(req.params.id);
    const { rows } = await pool.query(`UPDATE activities SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, params);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/activities/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM activities WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete all activities in a day
app.delete('/api/activities', async (req, res) => {
  try {
    const { week_id, day_index } = req.query;
    await pool.query('DELETE FROM activities WHERE week_id=$1 AND day_index=$2', [week_id, day_index]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
//  API: REWARDS
// ════════════════════════════════════════
app.get('/api/rewards/:kid_id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM rewards WHERE kid_id=$1 ORDER BY points_needed', [req.params.kid_id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rewards', async (req, res) => {
  try {
    const { kid_id, name, name_en, emoji, points_needed } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO rewards (kid_id,name,name_en,emoji,points_needed) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [kid_id, name, name_en || name, emoji || '🎁', points_needed]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/rewards/:id', async (req, res) => {
  try {
    const { claimed } = req.body;
    const { rows } = await pool.query('UPDATE rewards SET claimed=$1 WHERE id=$2 RETURNING *', [claimed, req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/rewards/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM rewards WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Health Check ──
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ════════════════════════════════════════
//  RESET DB (clean rebuild)
// ════════════════════════════════════════
app.post('/api/reset-db', async (req, res) => {
  try {
    const { confirm } = req.body;
    if (confirm !== 'RESET_CONFIRM') return res.status(400).json({ error: 'Missing confirmation' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM activities`);
      await client.query(`DELETE FROM weeks`);
      await client.query(`DELETE FROM rewards`);
      await client.query(`ALTER SEQUENCE activities_id_seq RESTART WITH 1`);
      await client.query(`ALTER SEQUENCE weeks_id_seq RESTART WITH 1`);
      await client.query(`ALTER SEQUENCE rewards_id_seq RESTART WITH 1`);
      // Re-seed weeks and activities for all kids
      const { rows: allKids } = await client.query('SELECT id FROM kids');
      for (const kid of allKids) {
        await createWeekForKid(client, kid.id, 'summer', 1, 'الأسبوع الأول');
        await createWeekForKid(client, kid.id, 'school', 1, 'الأسبوع الأول');
        await client.query(`
          INSERT INTO rewards (kid_id,name,name_en,emoji,points_needed) VALUES
          ($1,'ساعة شاشة إضافية','Extra screen hour','📱',30),
          ($1,'وجبة مفضلة','Favourite meal','🍕',50),
          ($1,'رحلة النادي','Club trip','🏊',80),
          ($1,'لعبة جديدة','New game','🎮',150)
        `, [kid.id]);
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch(e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
//  SERVE FRONTEND
// ════════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ════════════════════════════════════════
//  START
// ════════════════════════════════════════
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Running on http://localhost:${PORT}`));
}).catch(e => {
  console.error('❌ DB init failed:', e.message);
  process.exit(1);
});

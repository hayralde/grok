const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

// Por padrão o driver 'pg' converte colunas DATE (OID 1082) em objetos Date do
// JS. O restante do código (custos_seed.json, validação de import, e o front-end)
// trabalha com strings 'YYYY-MM-DD'. Sem isso, comparações/ordenações que chamam
// métodos de string (ex.: localeCompare) em cima de data_inicio/data_fim quebram
// em runtime (ver /api/custos/resumo). Mantém o valor cru 'YYYY-MM-DD' como string.
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false),
});

const SEED = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'seed_data.json'), 'utf8')
);
const CUSTOS_SEED = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'custos_seed.json'), 'utf8')
);

const AREAS = ['ELETRICA', 'MECANICA', 'TGM'];
const DEFAULT_AREA = 'ELETRICA';

// Domínio da aba Custos — independente das áreas de cronograma acima.
const CUSTO_DISCIPLINAS = ['ELETRICA', 'MECANICA', 'TGM', 'INSTRUMENTACAO', 'CIVIL', 'OUTROS'];
const CUSTO_STATUS = ['PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDO', 'CANCELADO'];

const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DEFAULT_SUPERVISOR_PASSWORD = process.env.SUPERVISOR_PASSWORD || 'super123';
const DEFAULT_OPERATOR_PASSWORD = process.env.OPERATOR_PASSWORD || '1234';

async function init() {
  // Schema de usuários do PCM. Se a tabela veio de outro app (ex.: full_name NOT NULL), recria.
  const { rows: userCols } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
  `);
  const colNames = userCols.map(r => r.column_name);
  const needsUsersRebuild = colNames.length > 0 && (
    colNames.includes('full_name') ||
    !colNames.includes('password_hash') ||
    !colNames.includes('username') ||
    !colNames.includes('role')
  );
  if (needsUsersRebuild) {
    console.log('Tabela users incompatível com o PCM — recriando schema de usuários...');
    await pool.query('DROP TABLE IF EXISTS users CASCADE');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','supervisor','operador')),
      nome TEXT NOT NULL,
      tecnico TEXT,
      area_scope TEXT
    );
  `);

  // Colunas extras em deploys parciais
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'area_scope'
      ) THEN
        ALTER TABLE users ADD COLUMN area_scope TEXT;
      END IF;
    END $$;
  `);

  // Legacy single-area schema (may already exist from previous deploys)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      setor TEXT NOT NULL,
      tag TEXT,
      descricao TEXT,
      nome TEXT NOT NULL,
      tecnico TEXT NOT NULL,
      inicio TIMESTAMPTZ NOT NULL,
      fim TIMESTAMPTZ NOT NULL,
      horas NUMERIC NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      done_by TEXT,
      done_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // ---- Multi-area migration ----
  // Add area column if missing
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tasks' AND column_name = 'area'
      ) THEN
        ALTER TABLE tasks ADD COLUMN area TEXT;
        UPDATE tasks SET area = '${DEFAULT_AREA}' WHERE area IS NULL;
        ALTER TABLE tasks ALTER COLUMN area SET NOT NULL;
        ALTER TABLE tasks ALTER COLUMN area SET DEFAULT '${DEFAULT_AREA}';
        -- Drop old single-column PK and create composite PK
        ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_pkey;
        ALTER TABLE tasks ADD PRIMARY KEY (area, id);
      END IF;
    END $$;
  `);

  // tecnico_tipo: PESSOA (default) | EQUIPE — allows shift/team labels with overlap
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tasks' AND column_name = 'tecnico_tipo'
      ) THEN
        ALTER TABLE tasks ADD COLUMN tecnico_tipo TEXT NOT NULL DEFAULT 'PESSOA';
      END IF;
    END $$;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tasks_tecnico_tipo_check'
      ) THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_tecnico_tipo_check
          CHECK (tecnico_tipo IN ('PESSOA','EQUIPE'));
      END IF;
    END $$;
  `);

  // Ensure check constraint on area
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tasks_area_check'
      ) THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_area_check
          CHECK (area IN ('ELETRICA','MECANICA','TGM'));
      END IF;
    END $$;
  `);

  // ---- Historico de conclusao/desconclusao de tarefas ----
  // Necessario pra Curva S "Real" poder subir E cair ao longo do tempo:
  // done/done_at só guardam o ultimo estado, sem essa tabela não dá pra saber
  // em que momento do passado uma tarefa foi desmarcada.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_events (
      id SERIAL PRIMARY KEY,
      area TEXT NOT NULL,
      task_id INTEGER NOT NULL,
      done BOOLEAN NOT NULL,
      by_user TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS task_events_area_at_idx ON task_events (area, at)`);

  const { rows: eventCount } = await pool.query('SELECT COUNT(*)::int AS n FROM task_events');
  if (eventCount[0].n === 0) {
    // Backfill: tarefas ja concluidas antes dessa tabela existir viram um
    // evento inicial (na data de conclusao, ou no fim planejado se faltar).
    await pool.query(`
      INSERT INTO task_events (area, task_id, done, by_user, at)
      SELECT area, id, TRUE, done_by, COALESCE(done_at, fim)
      FROM tasks WHERE done = TRUE
    `);
  }

  // Migrate legacy flat meta keys into area-scoped keys for ELETRICA
  const { rows: legacyMeta } = await pool.query(
    `SELECT key, value FROM meta WHERE key IN ('projectStart','projectFinish','sectorOrder')`
  );
  if (legacyMeta.length > 0) {
    for (const r of legacyMeta) {
      await pool.query(
        `INSERT INTO meta (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING`,
        [`${DEFAULT_AREA}:${r.key}`, r.value]
      );
    }
    await pool.query(
      `DELETE FROM meta WHERE key IN ('projectStart','projectFinish','sectorOrder')`
    );
  }

  // Seed ELETRICA tasks only if that area is empty
  const { rows: taskCount } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM tasks WHERE area = $1`,
    [DEFAULT_AREA]
  );
  if (taskCount[0].n === 0) {
    console.log('Semeando', SEED.tasks.length, 'tarefas em', DEFAULT_AREA, '...');
    for (const t of SEED.tasks) {
      await pool.query(
        `INSERT INTO tasks (area, id, setor, tag, descricao, nome, tecnico, inicio, fim, horas)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (area, id) DO NOTHING`,
        [DEFAULT_AREA, t.id, t.setor, t.tag, t.descricao, t.nome, t.tecnico, t.inicio, t.fim, t.horas]
      );
    }
    await pool.query(
      `INSERT INTO meta (key, value) VALUES ($1,$2),($3,$4),($5,$6)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        `${DEFAULT_AREA}:projectStart`, SEED.projectStart,
        `${DEFAULT_AREA}:projectFinish`, SEED.projectFinish,
        `${DEFAULT_AREA}:sectorOrder`, JSON.stringify(SEED.sectorOrder),
      ]
    );
  }

  // area_scope: NULL = todas as áreas; ELETRICA|MECANICA|TGM = restrito
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'area_scope'
      ) THEN
        ALTER TABLE users ADD COLUMN area_scope TEXT;
      END IF;
    END $$;
  `);

  // Ensure empty meta stubs exist for other areas (so UI doesn't break)
  for (const area of AREAS) {
    if (area === DEFAULT_AREA) continue;
    const { rows } = await pool.query(
      `SELECT 1 FROM meta WHERE key = $1`,
      [`${area}:projectStart`]
    );
    if (rows.length === 0) {
      await pool.query(
        `INSERT INTO meta (key, value) VALUES ($1,$2),($3,$4),($5,$6)
         ON CONFLICT (key) DO NOTHING`,
        [
          `${area}:projectStart`, SEED.projectStart,
          `${area}:projectFinish`, SEED.projectFinish,
          `${area}:sectorOrder`, JSON.stringify([]),
        ]
      );
    }
  }

  // ---- Tabela de Custos (aba "Custos") ----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS custos (
      id SERIAL PRIMARY KEY,
      fornecedor TEXT NOT NULL,
      disciplina TEXT NOT NULL DEFAULT 'OUTROS',
      atividade TEXT,
      escopo TEXT,
      valor NUMERIC NOT NULL DEFAULT 0,
      data_inicio DATE,
      data_fim DATE,
      responsavel TEXT,
      contato TEXT,
      status TEXT NOT NULL DEFAULT 'PENDENTE',
      observacao TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'custos_disciplina_check'
      ) THEN
        ALTER TABLE custos ADD CONSTRAINT custos_disciplina_check
          CHECK (disciplina IN ('${CUSTO_DISCIPLINAS.join("','")}'));
      END IF;
    END $$;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'custos_status_check'
      ) THEN
        ALTER TABLE custos ADD CONSTRAINT custos_status_check
          CHECK (status IN ('${CUSTO_STATUS.join("','")}'));
      END IF;
    END $$;
  `);

  // oculto: item fica fora da visão de operador/supervisor/visitante, mas o admin
  // continua enxergando (e podendo reverter) em "Todos os Custos".
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'custos' AND column_name = 'oculto'
      ) THEN
        ALTER TABLE custos ADD COLUMN oculto BOOLEAN NOT NULL DEFAULT FALSE;
      END IF;
    END $$;
  `);

  const { rows: custoCount } = await pool.query('SELECT COUNT(*)::int AS n FROM custos');
  if (custoCount[0].n === 0) {
    console.log('Semeando', CUSTOS_SEED.length, 'itens de custo (planilha de origem)...');
    for (const c of CUSTOS_SEED) {
      await pool.query(
        `INSERT INTO custos
           (id, fornecedor, disciplina, atividade, escopo, valor, data_inicio, data_fim, responsavel, contato, status, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [c.id, c.fornecedor, c.disciplina, c.atividade, c.escopo, c.valor, c.data_inicio || null,
         c.data_fim || null, c.responsavel || null, c.contato || null, c.status || 'PENDENTE', c.observacao || null]
      );
    }
    // Garante que o próximo INSERT (via SERIAL) não colida com os ids semeados manualmente
    await pool.query(`SELECT setval(pg_get_serial_sequence('custos','id'), (SELECT COALESCE(MAX(id),1) FROM custos))`);
  }

  const { rows: userCount } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (userCount[0].n === 0) {
    console.log('Semeando usuarios...');
    const adminHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, role, nome, tecnico) VALUES ($1,$2,$3,$4,NULL)`,
      ['admin', adminHash, 'admin', 'Administrador']
    );
    const supHash = await bcrypt.hash(DEFAULT_SUPERVISOR_PASSWORD, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, role, nome, tecnico) VALUES ($1,$2,$3,$4,NULL)`,
      ['supervisor', supHash, 'supervisor', 'Supervisor PCM']
    );
    const opHash = await bcrypt.hash(DEFAULT_OPERATOR_PASSWORD, 10);
    for (const tec of SEED.tecnicos) {
      const username = tec.toLowerCase();
      await pool.query(
        `INSERT INTO users (username, password_hash, role, nome, tecnico) VALUES ($1,$2,$3,$4,$5)`,
        [username, opHash, 'operador', tec, tec]
      );
    }
    console.log('Usuarios criados: admin, supervisor, e', SEED.tecnicos.length, 'operadores.');
  } else {
    // Repara usuários sem senha (schema antigo / tabela parcial)
    const adminHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
    const supHash = await bcrypt.hash(DEFAULT_SUPERVISOR_PASSWORD, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, role, nome, tecnico)
       VALUES ('admin', $1, 'admin', 'Administrador', NULL)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash),
         role = COALESCE(users.role, EXCLUDED.role),
         nome = COALESCE(users.nome, EXCLUDED.nome)`,
      [adminHash]
    );
    await pool.query(
      `INSERT INTO users (username, password_hash, role, nome, tecnico)
       VALUES ('supervisor', $1, 'supervisor', 'Supervisor PCM', NULL)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash),
         role = COALESCE(users.role, EXCLUDED.role),
         nome = COALESCE(users.nome, EXCLUDED.nome)`,
      [supHash]
    );
  }

  // Garante contas principais com senhas das env vars (sempre atualiza o hash)
  const adminHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
  const supHash = await bcrypt.hash(DEFAULT_SUPERVISOR_PASSWORD, 10);
  const supTgmHash = supHash;

  await pool.query(
    `INSERT INTO users (username, password_hash, role, nome, tecnico, area_scope)
     VALUES ('admin', $1, 'admin', 'Administrador', NULL, NULL)
     ON CONFLICT (username) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = 'admin',
       nome = COALESCE(users.nome, EXCLUDED.nome)`,
    [adminHash]
  );
  await pool.query(
    `INSERT INTO users (username, password_hash, role, nome, tecnico, area_scope)
     VALUES ('supervisor', $1, 'supervisor', 'Supervisor PCM', NULL, NULL)
     ON CONFLICT (username) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = 'supervisor',
       nome = COALESCE(users.nome, EXCLUDED.nome)`,
    [supHash]
  );
  await pool.query(
    `INSERT INTO users (username, password_hash, role, nome, tecnico, area_scope)
     VALUES ('supertgm', $1, 'supervisor', 'Supervisor TGM', NULL, 'TGM')
     ON CONFLICT (username) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = 'supervisor',
       nome = 'Supervisor TGM',
       area_scope = 'TGM'`,
    [supTgmHash]
  );
  console.log('Contas prontas: admin / supervisor / supertgm (senhas das variáveis de ambiente ou padrão).');
}

function normalizeArea(raw) {
  if (!raw) return null;
  const a = String(raw).trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (a === 'ELETRICA' || a === 'ELECTRICA') return 'ELETRICA';
  if (a === 'MECANICA' || a === 'MECHANICA') return 'MECANICA';
  if (a === 'TGM') return 'TGM';
  return null;
}

module.exports = { pool, init, AREAS, DEFAULT_AREA, normalizeArea, CUSTO_DISCIPLINAS, CUSTO_STATUS };

-- Catálogo inicial: os mesmos agentes e skills que o servidor de ensaio usa,
-- para a interface abrir já povoada. Edite à vontade — é só dado.

INSERT INTO agents (id, name, role, initials, color, position, system_role) VALUES
  ('be1', 'Backend1',    'API · DOMÍNIO · EF',   'BE', '#22d3ee', 1,
   'Você é o agente de backend. Escreve C#/.NET, modela o domínio e cuida de persistência.'),
  ('fe',  'Frontend',    'UI · UX · REACT',      'FE', '#a855f7', 2,
   'Você é o agente de frontend. Escreve React + TypeScript e cuida da experiência de uso.'),
  ('qa',  'QA-Sentinel', 'TESTES · REGRESSÃO',   'QA', '#34d399', 3,
   'Você é o agente de qualidade. Escreve testes, caça casos de borda e bloqueia regressão.'),
  ('ops', 'DevOps',      'BUILD · PIPELINE',     'OP', '#fbbf24', 4,
   'Você é o agente de infraestrutura. Cuida de build, containers e pipeline.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO skills (id, name, detail, initials, color, position) VALUES
  ('csharp', 'C#',         '.NET 8 · MINIMAL API', 'C#', '#22d3ee', 1),
  ('react',  'React',      'VITE · TS · TAILWIND', 'RE', '#a855f7', 2),
  ('sql',    'SQL Server', 'MIGRATIONS · INDEX',   'SQ', '#38bdf8', 3),
  ('test',   'xUnit',      'UNIT · INTEGRAÇÃO',    'XU', '#34d399', 4),
  ('docker', 'Docker',     'COMPOSE · CI',         'DK', '#fbbf24', 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO agent_skills (agent_id, skill_id, proficiency) VALUES
  ('be1', 'csharp', 5), ('be1', 'sql',   4), ('be1', 'test', 3),
  ('fe',  'react',  5), ('fe',  'test',  3),
  ('qa',  'test',   5), ('qa',  'csharp',3), ('qa', 'react', 3),
  ('ops', 'docker', 5), ('ops', 'sql',   3)
ON CONFLICT DO NOTHING;

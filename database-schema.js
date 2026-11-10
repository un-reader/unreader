export const schema = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  timeout_until BIGINT DEFAULT 0, is_banned BOOLEAN DEFAULT false,
  roles TEXT NOT NULL DEFAULT '[]'
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_moderator BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "GitHubTokenData" TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "BotPasswordData" TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "MailCredentialsData" TEXT;
CREATE TABLE IF NOT EXISTS mod_logs (
  id SERIAL PRIMARY KEY, mod_username TEXT NOT NULL, action_type TEXT NOT NULL,
  target_username TEXT, target_id INTEGER, reason TEXT, timestamp BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY, username TEXT NOT NULL, timestamp TEXT NOT NULL, content TEXT NOT NULL,
  is_deleted BOOLEAN DEFAULT false, deleted_by TEXT, sender TEXT, reply_to_id INTEGER
);
CREATE TABLE IF NOT EXISTS dms (
  id SERIAL PRIMARY KEY, username TEXT, sender TEXT NOT NULL, receiver TEXT NOT NULL, timestamp TEXT NOT NULL, content TEXT NOT NULL,
  is_deleted BOOLEAN DEFAULT false, deleted_by TEXT, reply_to_id INTEGER
);
CREATE TABLE IF NOT EXISTS dm_read_state (
  username TEXT NOT NULL, peer_username TEXT NOT NULL, last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, peer_username)
);
CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER;
ALTER TABLE dms ADD COLUMN IF NOT EXISTS reply_to_id INTEGER;
CREATE TABLE IF NOT EXISTS profiles (
  username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE, bio TEXT DEFAULT 'Being a human fahhh.', location TEXT DEFAULT 'Earth', avatar_emoji TEXT DEFAULT '👤'
);
CREATE TABLE IF NOT EXISTS profile_images (
  username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
  image_data TEXT NOT NULL,
  "user" TEXT NOT NULL DEFAULT 'user'
);
ALTER TABLE profile_images ADD COLUMN IF NOT EXISTS "user" TEXT NOT NULL DEFAULT 'user';
CREATE TABLE IF NOT EXISTS pet_packs (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_by VARCHAR(255) NOT NULL,
  pack_data TEXT NOT NULL,
  date_release DATE NOT NULL DEFAULT CURRENT_DATE,
  is_official BOOLEAN NOT NULL DEFAULT false,
  version_root_id INTEGER,
  legacy_pet_id INTEGER
);
ALTER TABLE pet_packs ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE pet_packs ADD COLUMN IF NOT EXISTS created_by VARCHAR(255);
ALTER TABLE pet_packs ADD COLUMN IF NOT EXISTS pack_data TEXT;
ALTER TABLE pet_packs ADD COLUMN IF NOT EXISTS date_release DATE DEFAULT CURRENT_DATE;
ALTER TABLE pet_packs ADD COLUMN IF NOT EXISTS is_official BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE pet_packs ADD COLUMN IF NOT EXISTS version_root_id INTEGER;
ALTER TABLE pet_packs ADD COLUMN IF NOT EXISTS legacy_pet_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS pet_packs_legacy_pet_idx ON pet_packs (legacy_pet_id);
CREATE INDEX IF NOT EXISTS pet_packs_version_root_idx ON pet_packs (version_root_id);
CREATE INDEX IF NOT EXISTS pet_packs_creator_root_idx ON pet_packs (created_by, version_root_id);
ALTER TABLE pet_packs ADD COLUMN IF NOT EXISTS version_note TEXT;
ALTER TABLE pet_packs ADD COLUMN IF NOT EXISTS thumb TEXT;
ALTER TABLE pet_packs ADD COLUMN IF NOT EXISTS pet_count INTEGER;
CREATE TABLE IF NOT EXISTS pet_pack_installs (
  username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  pack_root_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  first_at BIGINT NOT NULL,
  last_at BIGINT NOT NULL,
  PRIMARY KEY (username, pack_root_id)
);
CREATE INDEX IF NOT EXISTS pet_pack_installs_root_idx ON pet_pack_installs (pack_root_id);
DELETE FROM pet_pack_installs i
 WHERE NOT EXISTS (SELECT 1 FROM pet_packs p WHERE p.id = i.pack_root_id);
UPDATE pet_pack_installs i SET version_id = i.pack_root_id
 WHERE NOT EXISTS (SELECT 1 FROM pet_packs p WHERE p.id = i.version_id)
   AND EXISTS (SELECT 1 FROM pet_packs p WHERE p.id = i.pack_root_id);
INSERT INTO pet_pack_installs (username, pack_root_id, version_id, first_at, last_at)
SELECT username, root_id,
       (array_agg(version_id ORDER BY last_at DESC))[1], MIN(first_at), MAX(last_at)
  FROM (
    SELECT i.username, COALESCE(p.version_root_id, p.id) AS root_id,
           i.version_id, i.first_at, i.last_at
      FROM pet_pack_installs i JOIN pet_packs p ON p.id = i.pack_root_id
     WHERE EXISTS (
       SELECT 1 FROM pet_pack_installs stale
       JOIN pet_packs child ON child.id = stale.pack_root_id
       WHERE child.version_root_id IS NOT NULL
     )
  ) installs
 GROUP BY username, root_id
ON CONFLICT (username, pack_root_id) DO UPDATE SET
  first_at = LEAST(pet_pack_installs.first_at, EXCLUDED.first_at),
  version_id = CASE WHEN EXCLUDED.last_at > pet_pack_installs.last_at THEN EXCLUDED.version_id ELSE pet_pack_installs.version_id END,
  last_at = GREATEST(pet_pack_installs.last_at, EXCLUDED.last_at);
DELETE FROM pet_pack_installs i USING pet_packs p
 WHERE p.id = i.pack_root_id AND p.version_root_id IS NOT NULL;
DO $$ BEGIN
  IF to_regclass('public.pets') IS NOT NULL THEN
    ALTER TABLE pets ADD COLUMN IF NOT EXISTS id SERIAL;
    ALTER TABLE pets ADD COLUMN IF NOT EXISTS is_official BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE pets ADD COLUMN IF NOT EXISTS version_root_id INTEGER;
    INSERT INTO pet_packs (name, created_by, pack_data, date_release, is_official, legacy_pet_id)
    SELECT p."pet-name", p."created-by",
           json_build_array(json_build_object('name', p."pet-name", 'pet_data', p."pet-data"))::text,
           COALESCE(p."date-release", CURRENT_DATE), COALESCE(p.is_official, false), p.id
      FROM pets p
     WHERE p.id IS NOT NULL AND p."pet-name" IS NOT NULL AND p."created-by" IS NOT NULL
       AND p."pet-data" IS NOT NULL
    ON CONFLICT (legacy_pet_id) DO NOTHING;
    UPDATE pet_packs older
       SET version_root_id = latest.id
      FROM pets old_pet
      JOIN pet_packs latest ON latest.legacy_pet_id = old_pet.version_root_id
     WHERE older.legacy_pet_id = old_pet.id AND old_pet.version_root_id IS NOT NULL;
    DROP TABLE pets;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS topics (
  id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, username TEXT NOT NULL, timestamp TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS topic_messages (
  id SERIAL PRIMARY KEY, topic_slug TEXT NOT NULL, username TEXT NOT NULL, timestamp TEXT NOT NULL, content TEXT NOT NULL,
  is_deleted BOOLEAN DEFAULT false, deleted_by TEXT, sender TEXT
);
CREATE TABLE IF NOT EXISTS message_reactions (
  channel TEXT NOT NULL CHECK (channel IN ('public', 'dm', 'topic')),
  message_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  reaction_code SMALLINT NOT NULL CHECK (reaction_code BETWEEN 1 AND 32767),
  PRIMARY KEY (channel, message_id, username)
);
ALTER TABLE message_reactions DROP CONSTRAINT IF EXISTS message_reactions_reaction_code_check;
ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_reaction_code_check CHECK (reaction_code BETWEEN 1 AND 32767);
CREATE INDEX IF NOT EXISTS message_reactions_message_idx ON message_reactions (channel, message_id);
CREATE TABLE IF NOT EXISTS neighborhood_posts (
  id SERIAL PRIMARY KEY, username TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL,
  is_deleted BOOLEAN DEFAULT false, deleted_by TEXT, sender TEXT
);
CREATE TABLE IF NOT EXISTS neighborhood_comments (
  id SERIAL PRIMARY KEY, post_id INTEGER NOT NULL, username TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL,
  is_deleted BOOLEAN DEFAULT false, deleted_by TEXT, sender TEXT
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE dms ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE topic_messages ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE neighborhood_posts ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE neighborhood_comments ADD COLUMN IF NOT EXISTS deleted_by TEXT;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender TEXT;
ALTER TABLE topic_messages ADD COLUMN IF NOT EXISTS sender TEXT;
ALTER TABLE neighborhood_posts ADD COLUMN IF NOT EXISTS sender TEXT;
ALTER TABLE neighborhood_comments ADD COLUMN IF NOT EXISTS sender TEXT;

ALTER TABLE dms ADD COLUMN IF NOT EXISTS username TEXT;



CREATE INDEX IF NOT EXISTS idx_messages_id_desc ON messages (id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_username ON messages (username);
CREATE INDEX IF NOT EXISTS idx_topic_messages_slug_id ON topic_messages (topic_slug, id DESC);
CREATE INDEX IF NOT EXISTS idx_topic_messages_username ON topic_messages (username);
CREATE INDEX IF NOT EXISTS idx_dms_participants_id ON dms (sender, receiver, id DESC);
CREATE INDEX IF NOT EXISTS idx_neighborhood_posts_id_desc ON neighborhood_posts (id DESC);
CREATE INDEX IF NOT EXISTS idx_neighborhood_comments_post_id ON neighborhood_comments (post_id, id ASC);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

CREATE TABLE IF NOT EXISTS roles (
  role TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  style TEXT NOT NULL,
  class TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS class TEXT;

CREATE TABLE IF NOT EXISTS banned_ips (
  ip TEXT PRIMARY KEY,
  banned_by TEXT NOT NULL,
  reason TEXT,
  timestamp BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_removal_proposals (
  id SERIAL PRIMARY KEY,
  target_username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  proposed_by TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  eligible_voters TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected')),
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_removal_one_open_per_target
  ON admin_removal_proposals (target_username) WHERE status = 'open';
CREATE TABLE IF NOT EXISTS admin_removal_votes (
  proposal_id INTEGER NOT NULL REFERENCES admin_removal_proposals(id) ON DELETE CASCADE,
  voter_username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  approve BOOLEAN NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (proposal_id, voter_username)
);

CREATE TABLE IF NOT EXISTS "portal-2d" (
  "level-id" SERIAL PRIMARY KEY,
  "level-name" VARCHAR(255) NOT NULL,
  "username" VARCHAR(100) NOT NULL,
  "level-data" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal2d_demos (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  demo_name VARCHAR(100) NOT NULL,
  demo_data TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS portal2d_demos_owner_idx
  ON portal2d_demos (username, id DESC);

CREATE TABLE IF NOT EXISTS suggestions (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  suggestions TEXT NOT NULL,
  username TEXT NOT NULL,
  admin_filter TEXT,
  completion BOOLEAN
);
CREATE TABLE IF NOT EXISTS suggestion_comments (
  id SERIAL PRIMARY KEY,
  suggestion_id INTEGER NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS suggestion_comments_suggestion_idx
  ON suggestion_comments (suggestion_id, id ASC);

CREATE TABLE IF NOT EXISTS doodle_scores (
  username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK (score >= 0),
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS doodle_scores_rank_idx ON doodle_scores (score DESC, updated_at ASC);

CREATE TABLE IF NOT EXISTS wikipedia (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  html TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS github_changelog_cache (
  page INTEGER NOT NULL,
  per_page INTEGER NOT NULL,
  commits JSONB NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (page, per_page)
);
`;

export const backfill = `
UPDATE messages SET sender = username WHERE sender IS NULL;
UPDATE topic_messages SET sender = username WHERE sender IS NULL;
UPDATE neighborhood_posts SET sender = username WHERE sender IS NULL;
UPDATE neighborhood_comments SET sender = username WHERE sender IS NULL;
UPDATE dms SET username = sender WHERE username IS NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_migrations WHERE name = 'dm_read_state_baseline_v1') THEN
    INSERT INTO dm_read_state (username, peer_username, last_read_id)
    SELECT participant, peer, MAX(id)
    FROM (
      SELECT sender AS participant, receiver AS peer, id FROM dms
      UNION ALL
      SELECT receiver AS participant, sender AS peer, id FROM dms
    ) conversations
    GROUP BY participant, peer
    ON CONFLICT (username, peer_username) DO NOTHING;
    INSERT INTO app_migrations (name) VALUES ('dm_read_state_baseline_v1')
    ON CONFLICT (name) DO NOTHING;
  END IF;
END $$;
`;

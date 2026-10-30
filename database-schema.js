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
ALTER TABLE users ADD COLUMN IF NOT EXISTS "BotPasswordData" TEXT;
CREATE TABLE IF NOT EXISTS mod_logs (
  id SERIAL PRIMARY KEY, mod_username TEXT NOT NULL, action_type TEXT NOT NULL,
  target_username TEXT, target_id INTEGER, reason TEXT, timestamp BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY, username TEXT NOT NULL, timestamp TEXT NOT NULL, content TEXT NOT NULL,
  is_deleted BOOLEAN DEFAULT false, deleted_by TEXT, sender TEXT
);
CREATE TABLE IF NOT EXISTS dms (
  id SERIAL PRIMARY KEY, username TEXT, sender TEXT NOT NULL, receiver TEXT NOT NULL, timestamp TEXT NOT NULL, content TEXT NOT NULL,
  is_deleted BOOLEAN DEFAULT false, deleted_by TEXT
);
CREATE TABLE IF NOT EXISTS profiles (
  username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE, bio TEXT DEFAULT 'Being a human fahhh.', location TEXT DEFAULT 'Earth', avatar_emoji TEXT DEFAULT '👤'
);
CREATE TABLE IF NOT EXISTS profile_images (
  username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
  image_data TEXT NOT NULL,
  "user" TEXT NOT NULL DEFAULT 'user'
);
ALTER TABLE profile_images ADD COLUMN IF NOT EXISTS "user" TEXT NOT NULL DEFAULT 'user';
CREATE TABLE IF NOT EXISTS pets (
  "pet-name" VARCHAR(255),
  "created-by" VARCHAR(255),
  "pet-data" TEXT,
  "date-release" DATE
);
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
`;

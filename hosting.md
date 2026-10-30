# Testing and contribute

So. You want to contribute right? (insert Lord Verity "NOOOOO" reaction here because I'm lazy as shit) Well you're in luck!
We're not giving out any internal database stuff, but you can host your own with locally made databases, and make required changes!


# PREREQUISITES

I assume you have all of these installed:
- Git
- Node.JS
- PostgreSQL (skip if your testing environment contains a service like Neon or Supabase.)
- A browser, preferably Chromium 75. (Skip if you can test on a Kindle, preferably on firmware 5.16.4 and above.)

# Set up the environment.

First step is to set this up. Start by cloning the repo by going to your preferred location, open a terminal there, then
``` bash
git clone https://github.com/tock-dev/unreader.git
cd unreader
```
For the hosting, create an empty database with the provider of choice, or if using PostgreSQL, use this [guide](https://www.geeksforgeeks.org/postgresql/create-database-postgresql/).
Then, start adding your own environment variables.
For starters, here's a reference from our run.sh script (creds stripped, nice try.)

``` bash
#!/usr/bin/env bash
# This script runs the node server

export JWT_SECRET='eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IjE4MWMzOGZkOWI1NDQ2NmYwNzFkYzI5OGIwMDM1YjNmIn0' # whatever fits your JWT needs, unsure how tock whipped this up, but ok.
export NEON_DB_URL='postgresql://username:password@neon-host:5432/database_name?sslmode=require'
export LB_DB_URL='postgresql://username:password@layerbase-host:5432/database_name?sslmode=require'
export DB_REPLICA_DIR="$PWD/.database-replica"
export PORT=80

node index.js
```

Now that all is set up, on your PC, go to 127.0.0.1:80 to test, if you used the same port as the example script.
If you also want to test on your Kindle, make sure to keep port 80, since for some reason the browser rejects port numbers. Check your PC's local IP address, then go to that IP address on your Kindle.

# Neon and Layerbase failover

Use `NEON_DB_URL` for Neon and `LB_DB_URL` for Layerbase. `DATABASE_URL` is no longer used.
With just one URL configured, the app uses that database normally. With neither URL,
it uses the local PostgreSQL database from the example above.

Two databases need one shared writer to prevent conflicting changes during outages.
Run one persistent instance of this app as the database coordinator, and route all
other instances through it. The coordinator needs these environment variables:

```bash
NEON_DB_URL=postgresql://...
LB_DB_URL=postgresql://...
DB_REPLICA_DIR=/var/data/unreader-replica
DB_COORDINATOR_SECRET=your-long-random-secret
```

Mount persistent disk at `DB_REPLICA_DIR`. On Render, use one instance with an attached
disk. Keep the directory when restarting or redeploying, and back it up securely:
it contains database row data and the write recovery journal. Do not run multiple
coordinators against the same database pair, even with different journal directories.
Stop other writers before the initial copy, then configure every deployment to use
the coordinator before letting it accept writes. Direct SQL edits and older app
versions that bypass the coordinator are outside replication.

Neither provider is primary. On first launch, the app uses an available database
as its baseline. For databases in the same replication group, it uses the newer
checkpoint; otherwise it prefers a populated database, with no vendor preference.
If both are empty, either can initialize the app. On subsequent launches it keeps
the last active database when available and catches up the other before using it.

For a manual migration, stop the app, restore your backup into Layerbase, then start
the app after the restore finishes. Neon does not need to be available. A fresh
coordinator can adopt restored data even when the backup includes old
`_unreader_replica` metadata. It creates a new replication group for that baseline.
When the other provider returns, an empty database receives the baseline; an
already populated database must match the baseline before pending writes replay.
Conflicting data is left intact and that provider stays out of service until you
reconcile it or restore the same backup. No populated database is overwritten.
Keep the existing journal for normal restarts; a deliberate migration to a new
baseline needs its own persistent `DB_REPLICA_DIR`, with the previous directory
preserved for recovery.

The app records each transaction's row changes on durable disk before committing,
then sends them to the other database. If a provider is unavailable or reaches its
limits, the other catches up from this journal before serving requests. The
coordinator checks for recovery every 30 seconds (`DB_RETRY_MS`) and replays pending
changes in order. Transactions, updates, deletes and generated IDs are preserved;
replayed transactions have an atomic checkpoint to prevent duplicate application.
The healthy database remains active after recovery, avoiding unnecessary switches.

For Vercel, Netlify Functions, and additional persistent servers, configure:

```bash
DB_COORDINATOR_URL=https://your-persistent-server.example
DB_COORDINATOR_SECRET=the-same-secret-as-the-coordinator
```

These instances do not need either database URL or a local journal. Database calls
use the coordinator's authenticated `/internal/database` endpoint; transaction
sessions expire after 60 seconds. Use HTTPS outside localhost and keep the secret
server-side. Existing frontend routes and WebSocket behavior stay the same.
Serverless instances must not use temporary disk as the journal.

This design survives either database provider becoming unavailable, provided the
coordinator and its disk remain available. If both databases or the coordinator are
unavailable, requests fail until service recovers. Losing the journal disk during
an outage can lose writes that have not reached the second database; restore the
journal from backup rather than initializing a new coordinator. Never remove the
replica metadata tables to force a new bootstrap.

Run `node --test test/database.test.js` for basic configuration checks. To include
real replication and outage tests, set `TEST_NEON_DB_URL` and `TEST_LB_DB_URL` to
PostgreSQL accounts allowed to create databases. The suite creates its own uniquely
named test database on each provider and removes only those test databases afterward.

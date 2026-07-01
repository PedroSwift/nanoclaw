# NanoClaw Project Context

This is a multi-channel agent orchestration system. Main work happens on 7dlearn.com (CFML/Lucee web platform).

## Session Initialization

**CRITICAL - Load these at start of EVERY session:**

1. **Run snapshot** (if available):
   ```bash
   bash /c/SecondBrain/tools/snapshot.sh
   ```

2. **Load behavioral instructions from Postgres**:
   ```bash
   docker exec second-brain-db psql -U peter -d secondbrain -c "SELECT content FROM memories WHERE category = 'feedback' ORDER BY captured_at DESC LIMIT 20;"
   ```
   
   Key instructions to load:
   - **Debugging methodology**: Pragmatic discovery, trace workflows, evidence before theory
   - **No trailing summaries**: Peter can read the diff
   - **Read files before editing**: Always understand before modifying
   - **.md files are static only**: All history/state/context goes in Postgres
   - **No secrets in commands**: Never grep/cat env vars or config on remote servers
   - **Signal doubt early**: Flag constraints before iterating on fixes
   - **Run save-session.mjs at end**: `node C:\SecondBrain\tools\save-session.mjs "summary"`

3. **Check project state**:
   ```bash
   docker exec second-brain-db psql -U peter -d secondbrain -c "SELECT p.name, ps.section, ps.content FROM project_state ps JOIN projects p ON p.id=ps.project_id ORDER BY p.name, ps.section;"
   ```

4. **Check unread agent messages**:
   ```bash
   docker exec second-brain-db psql -U peter -d secondbrain -c "SELECT id, from_agent, subject, body FROM agent_messages WHERE to_agent = 'claude_code' AND status = 'unread' ORDER BY created_at ASC;"
   ```

## Primary Projects

### 7D Learn (test.7dlearn.com, www.7dlearn.com)
- **Stack**: Lucee 5.4 + Fusebox 5.5 + PostgreSQL
- **SSH**: `7d-prod` (both test and prod on same server)
- **Test webroot**: `/var/www/test.7dlearn.com/`
- **Prod webroot**: `/var/www/www.7dlearn.com/`
- **Test URL**: `https://test.7dlearn.com/` (HTTP Basic Auth: peter / \IdLOAAfme9#{6*9([' )
- **Framework notes**: Fusebox circuit-based routing, circuit.xml.cfm files

#### CRITICAL: 7dlearn Deployment Workflow

**NEVER use `git add .` or `git add -A` — always name files explicitly**
**NEVER use git pull/reset on www.7dlearn.com — rsync only**
**NEVER declare deployment done without running diff verification**

**Step 1 — Commit on test (explicit adds only):**
```bash
git -C /var/www/test.7dlearn.com add <specific files only>
git -C /var/www/test.7dlearn.com commit -m "message"
git -C /var/www/test.7dlearn.com push origin main
```

**Step 2 — Deploy to www via rsync:**
```bash
sudo rsync -av --exclude='.git' --exclude='WEB-INF' \
  /var/www/test.7dlearn.com/ /var/www/www.7dlearn.com/
```

**Step 3 — Verify parity (MANDATORY):**
```bash
diff -rq --exclude='.git' --exclude='WEB-INF' \
  /var/www/test.7dlearn.com/ /var/www/www.7dlearn.com/ \
  2>/dev/null | grep -v '\.log' | grep -v 'parsed/'
```
Must produce no output (or only expected test-only files). If .cfm or .cfc diffs appear, deployment is NOT complete.

**Why:** WEB-INF/ is owned by Lucee (different OS user). Using `git add .` commits WEB-INF/, causing Permission Denied on all future git operations. Git pull on www has repeatedly left www 6+ commits behind without detection.

### NanoClaw (this repo)
- Telegram channel active (not WhatsApp)
- Multi-bot support with isolated contexts
- Container-based agent execution

## Key Commands

```bash
# 7dlearn - restart Lucee after code changes
ssh 7d-prod "sudo systemctl restart lucee_tomcat"

# 7dlearn - check logs
ssh 7d-prod "tail -100 /var/www/test.7dlearn.com/WEB-INF/lucee/logs/application.log"
ssh 7d-prod "tail -100 /var/www/test.7dlearn.com/WEB-INF/lucee/logs/exception.log"
ssh 7d-prod "tail -100 /var/www/test.7dlearn.com/WEB-INF/lucee/logs/routing.log"

# NanoClaw - check status
pm2 status
pm2 logs nanoclaw --lines 50
```

## Memory System

**All persistent memory goes in Postgres `memories` table:**
- Categories: `project:7dlearn`, `project:nanoclaw`, `project:second_brain`, `feedback`, `user`
- Query: `docker exec second-brain-db psql -U peter -d secondbrain`
- **Never write history, state, or context to .md files** - they are for static instructions only

## Git Workflow

Always commit changes with descriptive messages. Include co-author:
```
Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

## Troubleshooting

**7dlearn common issues:**
- After Lucee restart: visit `?reinit=1` to reinitialize Application.cfc
- After code changes: restart Lucee service
- Fusebox circuits cached: may need Lucee restart to pick up changes
- Session issues: check routing.log for SESSIONAUTHENTICATED status

**NanoClaw:**
- PM2 restarts lose in-flight container output (Docker instability)
- IPC file-based sends survive restarts, marker-based text doesn't

-- Team names may repeat across game types (competition categories).
-- Only `team_id` (รหัสทีม) is globally unique now; the per-category
-- name rule is enforced by the application (teamService / importer).
DROP INDEX IF EXISTS "teams_team_name_key";
CREATE INDEX IF NOT EXISTS "teams_team_name_idx" ON "teams"("team_name");

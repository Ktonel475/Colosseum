/*
  Warnings:

  - The primary key for the `teams` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `teams` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_matches" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "team1_id" TEXT NOT NULL,
    "team2_id" TEXT NOT NULL,
    "discord_thread_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "matches_team1_id_fkey" FOREIGN KEY ("team1_id") REFERENCES "teams" ("team_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "matches_team2_id_fkey" FOREIGN KEY ("team2_id") REFERENCES "teams" ("team_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_matches" ("created_at", "discord_thread_id", "id", "status", "team1_id", "team2_id", "updated_at") SELECT "created_at", "discord_thread_id", "id", "status", "team1_id", "team2_id", "updated_at" FROM "matches";
DROP TABLE "matches";
ALTER TABLE "new_matches" RENAME TO "matches";
CREATE UNIQUE INDEX "matches_discord_thread_id_key" ON "matches"("discord_thread_id");
CREATE INDEX "matches_team1_id_idx" ON "matches"("team1_id");
CREATE INDEX "matches_team2_id_idx" ON "matches"("team2_id");
CREATE INDEX "matches_discord_thread_id_idx" ON "matches"("discord_thread_id");
CREATE INDEX "matches_status_idx" ON "matches"("status");
CREATE TABLE "new_players" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "discord_user_id" TEXT NOT NULL,
    "discord_username" TEXT NOT NULL,
    "team_id" TEXT,
    "team_role_id" TEXT,
    "registered_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "players_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams" ("team_id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_players" ("discord_user_id", "discord_username", "id", "registered_at", "team_id", "team_role_id", "updated_at") SELECT "discord_user_id", "discord_username", "id", "registered_at", "team_id", "team_role_id", "updated_at" FROM "players";
DROP TABLE "players";
ALTER TABLE "new_players" RENAME TO "players";
CREATE UNIQUE INDEX "players_discord_user_id_key" ON "players"("discord_user_id");
CREATE INDEX "players_discord_user_id_idx" ON "players"("discord_user_id");
CREATE INDEX "players_team_id_idx" ON "players"("team_id");
CREATE TABLE "new_teams" (
    "team_id" TEXT NOT NULL PRIMARY KEY,
    "team_name" TEXT NOT NULL,
    "game_type" TEXT,
    "discord_role_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_teams" ("created_at", "discord_role_id", "is_active", "team_id", "team_name", "updated_at") SELECT "created_at", "discord_role_id", "is_active", "team_id", "team_name", "updated_at" FROM "teams";
-- Re-map any existing foreign keys from the old internal cuid to the team code.
UPDATE "matches"
SET "team1_id" = (SELECT "team_id" FROM "teams" WHERE "teams"."id" = "matches"."team1_id")
WHERE EXISTS (SELECT 1 FROM "teams" WHERE "teams"."id" = "matches"."team1_id");
UPDATE "matches"
SET "team2_id" = (SELECT "team_id" FROM "teams" WHERE "teams"."id" = "matches"."team2_id")
WHERE EXISTS (SELECT 1 FROM "teams" WHERE "teams"."id" = "matches"."team2_id");
UPDATE "players"
SET "team_id" = (SELECT "team_id" FROM "teams" WHERE "teams"."id" = "players"."team_id")
WHERE "team_id" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "teams" WHERE "teams"."id" = "players"."team_id");
DROP TABLE "teams";
ALTER TABLE "new_teams" RENAME TO "teams";
CREATE UNIQUE INDEX "teams_team_name_key" ON "teams"("team_name");
CREATE INDEX "teams_game_type_idx" ON "teams"("game_type");
CREATE INDEX "teams_is_active_idx" ON "teams"("is_active");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

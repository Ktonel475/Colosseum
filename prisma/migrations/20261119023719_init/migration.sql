-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "team_id" TEXT NOT NULL,
    "team_name" TEXT NOT NULL,
    "discord_role_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "players" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "discord_user_id" TEXT NOT NULL,
    "discord_username" TEXT NOT NULL,
    "team_id" TEXT,
    "team_role_id" TEXT,
    "registered_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "players_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "matches" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "team1_id" TEXT NOT NULL,
    "team2_id" TEXT NOT NULL,
    "discord_thread_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "matches_team1_id_fkey" FOREIGN KEY ("team1_id") REFERENCES "teams" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "matches_team2_id_fkey" FOREIGN KEY ("team2_id") REFERENCES "teams" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "match_id" TEXT NOT NULL,
    "score1" INTEGER NOT NULL,
    "score2" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "submitted_by" TEXT NOT NULL,
    "submitted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" DATETIME,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "results_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "results_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "players" ("discord_user_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "result_confirmations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "result_id" TEXT NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "confirmation_status" TEXT NOT NULL,
    "confirmed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    CONSTRAINT "result_confirmations_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "results" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor_discord_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "previous_value" TEXT,
    "new_value" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "player_selections" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "discord_user_id" TEXT NOT NULL,
    "discord_username" TEXT NOT NULL,
    "guild_id" TEXT NOT NULL,
    "team_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'awaiting_selection',
    "expiration" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "teams_team_id_key" ON "teams"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_team_name_key" ON "teams"("team_name");

-- CreateIndex
CREATE INDEX "teams_team_id_idx" ON "teams"("team_id");

-- CreateIndex
CREATE INDEX "teams_is_active_idx" ON "teams"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "players_discord_user_id_key" ON "players"("discord_user_id");

-- CreateIndex
CREATE INDEX "players_discord_user_id_idx" ON "players"("discord_user_id");

-- CreateIndex
CREATE INDEX "players_team_id_idx" ON "players"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "matches_discord_thread_id_key" ON "matches"("discord_thread_id");

-- CreateIndex
CREATE INDEX "matches_team1_id_idx" ON "matches"("team1_id");

-- CreateIndex
CREATE INDEX "matches_team2_id_idx" ON "matches"("team2_id");

-- CreateIndex
CREATE INDEX "matches_discord_thread_id_idx" ON "matches"("discord_thread_id");

-- CreateIndex
CREATE INDEX "matches_status_idx" ON "matches"("status");

-- CreateIndex
CREATE INDEX "results_match_id_idx" ON "results"("match_id");

-- CreateIndex
CREATE INDEX "results_status_idx" ON "results"("status");

-- CreateIndex
CREATE INDEX "results_submitted_by_idx" ON "results"("submitted_by");

-- CreateIndex
CREATE INDEX "results_submitted_at_idx" ON "results"("submitted_at");

-- CreateIndex
CREATE INDEX "result_confirmations_result_id_idx" ON "result_confirmations"("result_id");

-- CreateIndex
CREATE INDEX "result_confirmations_discord_user_id_idx" ON "result_confirmations"("discord_user_id");

-- CreateIndex
CREATE INDEX "result_confirmations_confirmation_status_idx" ON "result_confirmations"("confirmation_status");

-- CreateIndex
CREATE INDEX "audit_logs_actor_discord_id_idx" ON "audit_logs"("actor_discord_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_idx" ON "audit_logs"("entity_type");

-- CreateIndex
CREATE INDEX "audit_logs_entity_id_idx" ON "audit_logs"("entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "player_selections_discord_user_id_idx" ON "player_selections"("discord_user_id");

-- CreateIndex
CREATE INDEX "player_selections_status_idx" ON "player_selections"("status");

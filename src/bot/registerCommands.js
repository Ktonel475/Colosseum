import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import config from "../config/index.js";
import { matchCommandDefinitions } from "../modules/match/commands.js";

export const LEGACY_MATCH_COMMANDS = new Set([
  "match-list",
  "match-info",
  "match-close",
  "result-status",
  "result-review",
  "result-edit",
  "result-cancel",
]);

/**
 * When MATCH_MODULE_ONLY=true the legacy team-code match/result commands are
 * not registered, leaving only the standalone module commands. When false
 * (default) both sets continue to coexist.
 */
export function applyMatchModuleMode(definitions, moduleOnly) {
  if (!moduleOnly) return definitions;
  return definitions.filter(
    (command) => !LEGACY_MATCH_COMMANDS.has(command.name),
  );
}

const allCommandDefinitions = [
  new SlashCommandBuilder()
    .setName("team-import")
    .setDescription("Import the team list from an Excel (.xlsx) file")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addAttachmentOption((o) =>
      o
        .setName("file")
        .setDescription(
          "XLSX export (Thai headers: ประเภทเกม / รหัสทีม / ชื่อทีม)",
        )
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("team-list")
    .setDescription("List active competition teams")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("team-add")
    .setDescription("Add a team manually")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("team_id")
        .setDescription("Team code (รหัสทีม) — primary key")
        .setRequired(true)
        .setMaxLength(100),
    )
    .addStringOption((o) =>
      o
        .setName("team_name")
        .setDescription("Team name (ชื่อทีม)")
        .setRequired(true)
        .setMaxLength(100),
    )
    .addStringOption((o) =>
      o
        .setName("game_type")
        .setDescription("Game type (ประเภทเกม)")
        .setRequired(false)
        .setMaxLength(100),
    ),
  new SlashCommandBuilder()
    .setName("team-remove")
    .setDescription("Deactivate a team (historical data is kept)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("team")
        .setDescription("Team code (รหัสทีม) or team name")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("team-sync")
    .setDescription("Create/synchronize Discord roles for all active teams")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("myteam")
    .setDescription("Show your current team")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("language")
    .setDescription("Choose the language the bot uses for you (English / ไทย)")
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("language")
        .setDescription("Your preferred language")
        .setRequired(true)
        .addChoices(
          { name: "English", value: "en" },
          { name: "ไทย (Thai)", value: "th" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("regist")
    .setDescription("Register as a player and pick your team")
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("teamname")
        .setDescription(
          "Team name or team code (ชื่อทีม / รหัสทีม). Leave empty to search.",
        )
        .setRequired(false)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("repick-team")
    .setDescription("Change the team you belong to")
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("teamname")
        .setDescription(
          "Team name or team code (ชื่อทีม / รหัสทีม). Leave empty to search.",
        )
        .setRequired(false)
        .setAutocomplete(true),
    ),

  // Match module commands (standalone extractable subsystem).
  ...matchCommandDefinitions,
  new SlashCommandBuilder()
    .setName("match-list")
    .setDescription("List matches")
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("status")
        .setDescription("Filter by status")
        .addChoices(
          { name: "active", value: "active" },
          { name: "closed", value: "closed" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("match-info")
    .setDescription(
      "Show match information (uses the current thread by default)",
    )
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("match")
        .setDescription("Match ID (optional)")
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("match-close")
    .setDescription("Close a match and archive its thread")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("match")
        .setDescription("Match ID (optional)")
        .setAutocomplete(true),
    ),

  new SlashCommandBuilder()
    .setName("result-status")
    .setDescription("Show the result status of this match")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("result-review")
    .setDescription("Review pending results")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("result-edit")
    .setDescription("Correct an existing result")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("result_id")
        .setDescription("Result ID")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addIntegerOption((o) =>
      o
        .setName("score1")
        .setDescription("New score 1")
        .setRequired(true)
        .setMinValue(0),
    )
    .addIntegerOption((o) =>
      o
        .setName("score2")
        .setDescription("New score 2")
        .setRequired(true)
        .setMinValue(0),
    ),
  new SlashCommandBuilder()
    .setName("result-cancel")
    .setDescription("Cancel the pending result in this thread")
    .setDMPermission(false),
];

const devCommandDefinitions = [
  new SlashCommandBuilder()
    .setName("init")
    .setDescription(
      "DEV: reset a user to the initial player state and resend the welcome DM",
    )
    .setDMPermission(false)
    .addUserOption((o) =>
      o
        .setName("target")
        .setDescription("The user to initialize (on-server or off-server)")
        .setRequired(true),
    ),
];

const baseCommandDefinitions = applyMatchModuleMode(
  allCommandDefinitions,
  config.match.moduleOnly,
);

export const commandDefinitions = config.devCommands
  ? [...baseCommandDefinitions, ...devCommandDefinitions]
  : baseCommandDefinitions;

/**
 * Register the slash commands without requiring a pre-configured guild id.
 *
 * - With an explicit `guildId`, only that guild is updated (used when the bot
 *   joins a new server).
 * - Otherwise every guild the bot is currently in is updated, so commands are
 *   available instantly without `DISCORD_SERVER_ID`.
 * - If the bot is not in any guild yet, fall back to global registration.
 */
export async function registerCommands(client, guildId) {
  const body = commandDefinitions.map((c) => c.toJSON());

  if (guildId) {
    const guild = await client.guilds.fetch(guildId);
    await guild.commands.set(body);
    return { scope: "guild", guildId: guild.id, count: body.length };
  }

  const guilds = [...client.guilds.cache.values()];
  if (!guilds.length) {
    await client.application.commands.set(body);
    return { scope: "global", count: body.length };
  }

  const results = await Promise.allSettled(
    guilds.map((guild) => guild.commands.set(body)),
  );
  const registered = guilds
    .filter((_, index) => results[index].status === "fulfilled")
    .map((guild) => guild.id);
  const failed = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message ?? String(result.reason));

  return {
    scope: "guilds",
    guilds: registered,
    count: body.length,
    ...(failed.length ? { failed } : {}),
  };
}

import { ChannelType, SlashCommandBuilder } from "discord.js";

/**
 * Shared channel option: the round channel where the private match thread
 * will be created. Defaults to the channel the command is run in.
 */
const roundChannelOption = (o) =>
  o
    .setName("channel")
    .setDescription(
      "Round channel where the private thread is created (defaults to the current channel)",
    )
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setRequired(false);

/**
 * /match-create
 * Creates one private match thread for two teams.
 *
 * The `team1` / `team2` options accept a team name or team code. The handler
 * resolves the matching Discord Role by name (Method 1) so the intro message
 * can ping the team via a real `<@&roleId>` mention.
 */
const matchCreate = new SlashCommandBuilder()
  .setName("match-create")
  .setDescription("Create one match thread in a round channel")
  .setDMPermission(false)
  .addStringOption((o) =>
    o
      .setName("team1")
      .setDescription("First team (team name or code / ชื่อทีมหรือรหัสทีม)")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((o) =>
    o
      .setName("team2")
      .setDescription("Second team (team name or code / ชื่อทีมหรือรหัสทีม)")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addChannelOption(roundChannelOption)
  // NEW: allow requiring the role to exist. Defaults to true so a match
  // is never created with a plain-name (non-ping) intro by accident.
  .addBooleanOption((o) =>
    o
      .setName("require_role")
      .setDescription(
        "Require a matching Discord Role for each team so the intro can ping them (default: true)",
      )
      .setRequired(false),
  );

/**
 * /match-create-bulk
 * Creates several private match threads in the current round channel.
 * The team pairs are provided by the handler (options / DB / modal).
 */
const matchCreateBulk = new SlashCommandBuilder()
  .setName("match-create-bulk")
  .setDescription("Create several match threads in the current round channel")
  .setDMPermission(false)
  .addChannelOption(roundChannelOption)
  // NEW: same require-role behavior as the single-match command.
  .addBooleanOption((o) =>
    o
      .setName("require_role")
      .setDescription(
        "Require a matching Discord Role for each team so the intro can ping them (default: true)",
      )
      .setRequired(false),
  );
// NEW: optional round-channel override, matching /match-create.

/**
 * /result
 * Admin-only. Records the winner in the current match thread.
 */
const result = new SlashCommandBuilder()
  .setName("result")
  .setDescription("Record the winner of this match thread (admin only)")
  .setDMPermission(false);

export const matchCommandDefinitions = [matchCreate, matchCreateBulk, result];

export const matchCommandNames = new Set(
  matchCommandDefinitions.map((command) => command.name),
);

export default { matchCommandDefinitions, matchCommandNames };

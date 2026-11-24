import { ChannelType, SlashCommandBuilder } from 'discord.js';

const roundChannelOption = (o) =>
  o
    .setName('channel')
    .setDescription(
      'Round channel where the private thread is created (defaults to the current channel)',
    )
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setRequired(false);

const matchCreate = new SlashCommandBuilder()
  .setName('match-create')
  .setDescription('Create one match thread in a round channel')
  .setDMPermission(false)
  .addChannelOption(roundChannelOption)
  .addUserOption((o) =>
    o.setName('team1').setDescription('First team (Discord user)').setRequired(true),
  )
  .addUserOption((o) =>
    o.setName('team2').setDescription('Second team (Discord user)').setRequired(true),
  );

const matchCreateBulk = new SlashCommandBuilder()
  .setName('match-create-bulk')
  .setDescription('Create several match threads in the current round channel')
  .setDMPermission(false);

const result = new SlashCommandBuilder()
  .setName('result')
  .setDescription('Record the winner of this match thread (admin only)')
  .setDMPermission(false);

export const matchCommandDefinitions = [matchCreate, matchCreateBulk, result];

export const matchCommandNames = new Set(matchCommandDefinitions.map((command) => command.name));

export default { matchCommandDefinitions, matchCommandNames };

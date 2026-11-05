const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Post the OGSHOP support ticket panel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("close")
    .setDescription("Close the current support ticket")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Mute or unmute AI replies in this ticket")
    .addBooleanOption(option =>
      option.setName("enabled")
        .setDescription("True to mute AI, false to unmute AI")
        .setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("voucher")
    .setDescription("Manually create a one-use Netflix voucher in this ticket")
    .toJSON()
];

module.exports = commands;

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
  ,
  new SlashCommandBuilder()
    .setName("blacklist")
    .setDescription("Manage the Netflix replacement blacklist")
    .addStringOption(option =>
      option.setName("action")
        .setDescription("Add, remove, or check a user")
        .setRequired(true)
        .addChoices(
          { name: "Add", value: "add" },
          { name: "Remove", value: "remove" },
          { name: "Check", value: "check" }
        ))
    .addStringOption(option =>
      option.setName("user_id")
        .setDescription("The Discord user ID (numbers only)")
        .setRequired(true))
    .addStringOption(option =>
      option.setName("reason")
        .setDescription("Optional staff note for the blacklist")
        .setRequired(false))
    .toJSON()
];

module.exports = commands;

require("dotenv").config();
const { REST, Routes } = require("discord.js");
const commands = require("./commands");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) throw new Error("Set DISCORD_TOKEN and DISCORD_CLIENT_ID.");
const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`Registered commands in guild ${guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("Registered global commands (may take time to appear).");
  }
})().catch(err => { console.error(err); process.exit(1); });

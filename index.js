const {
  Client, GatewayIntentBits, Partials, ChannelType, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  EmbedBuilder, Events, REST, Routes
} = require("discord.js");
const express = require("express");
const crypto = require("node:crypto");
const config = require("./config");
const commands = require("./commands");
const store = require("./db");
const { generateReply } = require("./ai");
const { verifyInvoice, createNetflixCoupon } = require("./sellauth");

const COMMAND_ROLE_ID = "1567889731851911250";

function hasCommandRole(member) {
  return Boolean(member?.roles?.cache?.has(COMMAND_ROLE_ID));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const app = express();
app.get("/", (_req, res) => res.status(200).send("OGSHOP support bot is online."));
app.get("/health", (_req, res) => res.status(200).json({
  ok: true,
  discordReady: client.isReady(),
  timestamp: new Date().toISOString()
}));
app.listen(config.port, "0.0.0.0", () => {
  console.log(`Health server listening on 0.0.0.0:${config.port}`);
});

if (config.pingUrl) {
  setInterval(async () => {
    try {
      const response = await fetch(config.pingUrl, { signal: AbortSignal.timeout(10000) });
      console.log(`[PING] ${config.pingUrl} -> ${response.status}`);
    } catch (err) {
      console.error("[PING] Failed:", err.message);
    }
  }, 60_000).unref();
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isStaff(member) {
  if (!member) return false;
  return member.permissions?.has(PermissionFlagsBits.Administrator) ||
    (config.staffRoleId && member.roles?.cache?.has(config.staffRoleId));
}

function panelComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket:replacement").setLabel("Replacement").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ticket:question").setLabel("Question").setStyle(ButtonStyle.Primary)
  )];
}

async function createTicketChannel(interaction, kind) {
  const guild = interaction.guild;
  if (!guild) throw new Error("Tickets can only be opened inside a server.");
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles
    ] }
  ];
  if (config.staffRoleId) {
    overwrites.push({ id: config.staffRoleId, allow: [
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles
    ] });
  }
  overwrites.push({ id: client.user.id, allow: [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.AttachFiles
  ] });

  const channel = await guild.channels.create({
    name: `${kind}-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 90),
    type: ChannelType.GuildText,
    parent: config.ticketCategoryId || undefined,
    permissionOverwrites: overwrites,
    topic: `OGSHOP ${kind} ticket for ${interaction.user.tag} (${interaction.user.id})`
  });
  const id = crypto.randomUUID();
  await store.createTicket({
    id, guild_id: guild.id, channel_id: channel.id, user_id: interaction.user.id,
    kind, product: null, status: kind === "question" ? "question" : "choose_product",
    created_at: Date.now()
  });
  return { channel, id };
}

async function sendAI(channel, ticketId, userText, context = "") {
  const ticket = await store.getTicket(ticketId);
  if (ticket?.ai_muted) {
    console.log(`[AI MUTED] Skipping AI reply in ticket ${ticketId}`);
    return;
  }
  let answer;
  try {
    answer = await generateReply(ticketId, userText, context);
  } catch (err) {
    console.error("OpenRouter error:", err.message);
    answer = "Thanks for your message. I've had trouble generating a reply just now, but your message is saved and our team can still help.";
  }
  await store.addMessage(ticketId, "assistant", answer);
  await channel.send({ content: answer });
}

function productSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("product:select")
      .setPlaceholder("Choose the product")
      .addOptions(
        { label: "Netflix", value: "netflix", description: "Netflix replacement request" },
        { label: "Other", value: "other", description: "General product support" }
      )
  );
}

function staffDecisionButtons(ticketId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`staff:accept:${ticketId}`).setLabel("Accept replacement").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`staff:decline:${ticketId}`).setLabel("Decline replacement").setStyle(ButtonStyle.Danger)
  );
}

async function notifyStaff(ticket, channel, proofFiles) {
  if (!config.staffLogChannelId) throw new Error("STAFF_LOG_CHANNEL_ID is not configured.");
  const logChannel = await client.channels.fetch(config.staffLogChannelId);
  if (!logChannel?.isTextBased()) throw new Error("Staff log channel is not a text channel.");

  const deadline = ticket.deadline_at;
  const embed = new EmbedBuilder()
    .setTitle("New Netflix replacement request")
    .setColor(0xF0B232)
    .addFields(
      { name: "Customer", value: `<@${ticket.user_id}>`, inline: true },
      { name: "Product", value: "Netflix", inline: true },
      { name: "Invoice", value: ticket.invoice_id || "Not recorded", inline: true },
      { name: "Evidence", value: `${proofFiles.length} image/video attachment(s)`, inline: true },
      { name: "Ticket", value: `<#${ticket.channel_id}>`, inline: true },
      { name: "Auto-approval", value: `<t:${Math.floor(deadline / 1000)}:R>`, inline: true }
    )
    .setFooter({ text: `Ticket ID: ${ticket.id}` })
    .setTimestamp();
  const sent = await logChannel.send({ embeds: [embed], components: [staffDecisionButtons(ticket.id)] });
  await store.updateTicket({ id: ticket.id, staff_message_id: sent.id });
  return sent;
}

function isImageOrVideo(attachment) {
  const type = (attachment.contentType || "").toLowerCase();
  const name = (attachment.name || "").toLowerCase();
  const image = type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
  const video = type.startsWith("video/") || /\.(mp4|mov|webm|m4v|avi)$/i.test(name);
  return image || video;
}

async function handleCustomerMessage(message) {
  if (message.author.bot || !message.guild) return;
  const ticket = await store.getByChannel(message.channel.id);
  if (!ticket || ticket.user_id !== message.author.id) return;
  if (["approved", "declined", "auto_approved", "closed"].includes(ticket.status)) return;

  const text = message.content?.trim() || "";
  await store.addMessage(ticket.id, "user", text || "[attachment]");
  const attachments = [...message.attachments.values()];

  if (ticket.kind === "question" || ticket.product === "other") {
    await sendAI(message.channel, ticket.id, text || "The customer uploaded an attachment.", "This is a general question/support ticket. Do not issue or offer replacements.");
    return;
  }

  if (ticket.status === "choose_product") {
    await sendAI(message.channel, ticket.id, text || "Hello", "Ask the customer to choose a product from the dropdown below.");
    await message.channel.send({ content: "Please select the product you're contacting us about:", components: [productSelect()] });
    return;
  }

  if (ticket.status === "awaiting_invoice") {
    const labelledInvoiceId = text.match(/(?:sell\s*auth\s*)?invoice\s*(?:id|number|#)?\s*(?:is|:|#|-)?\s*([A-Za-z0-9][A-Za-z0-9_-]{3,79})/i);
    const ignoredInvoiceWords = new Set([
      "here", "heres", "this", "that", "the", "my", "your", "please",
      "invoice", "invoiceid", "number", "id", "order", "orderid", "is",
      "it", "attached", "below", "thanks", "hello"
    ]);
    const fallbackInvoiceIds = text.match(/\b[A-Za-z0-9][A-Za-z0-9_-]{3,79}\b/g) || [];
    const invoiceId = labelledInvoiceId?.[1] ||
      fallbackInvoiceIds.filter(value => !ignoredInvoiceWords.has(value.toLowerCase())).at(-1);
    if (!invoiceId) {
      await sendAI(message.channel, ticket.id, text, "The customer has not provided a recognizable invoice ID. Ask them to send the invoice ID as text.");
      return;
    }
    await message.channel.sendTyping();
    let result;
    try {
      result = await verifyInvoice(invoiceId);
    } catch (err) {
      console.error("SellAuth invoice verification error:", err.message);
      await message.channel.send("OGSHOP is unable to check your invoice right now. Please try again in a moment; staff have not marked it as verified.");
      return;
    }

    if (!result.found || !result.paid || !result.hasNetflix) {
      const verificationContext = !result.found
        ? "IMPORTANT VERIFIED BACKEND RESULT: The submitted invoice ID was NOT found in the OGS​​HOP SellAuth store logs. Explain this naturally and helpfully. Ask the customer to double-check that they copied the invoice ID, not the order number, and try again. Do not claim the invoice was found, paid, or verified."
        : !result.paid
          ? "IMPORTANT VERIFIED BACKEND RESULT: The invoice exists in OGS​​HOP SellAuth, but it is NOT marked paid/completed. Explain this naturally and ask them to check payment status or contact staff if they already paid. Do not claim it is paid or verified."
          : "IMPORTANT VERIFIED BACKEND RESULT: The invoice exists, but it does NOT contain the Netflix product required for this replacement request. Explain this naturally and ask them to check the invoice or contact staff. Do not claim the product matches.";
      await sendAI(message.channel, ticket.id, text, verificationContext);
      return;
    }

    await store.updateTicket({ id: ticket.id, status: "awaiting_proof", invoice_id: invoiceId });
    const verifiedContext = "IMPORTANT VERIFIED BACKEND RESULT: The SellAuth backend has confirmed that this invoice exists, is paid/completed, and includes the Netflix product. Reply naturally in your own words: thank the customer for providing the invoice, confirm it has been verified, and ask them to attach a screenshot or video showing the issue with their order. Make clear that the evidence must be attached directly to this ticket. Do not ask for the invoice ID again, do not claim evidence has already been received, and do not promise approval.";
    await sendAI(message.channel, ticket.id, text || "The customer provided their invoice ID.", verifiedContext);
    return;
  }

  if (ticket.status === "awaiting_proof") {
    const proof = attachments.filter(isImageOrVideo);
    if (proof.length === 0) {
      // If the customer repeats the already-verified invoice ID as text, don't
      // mistake it for an evidence submission. Reconfirm the verified state and
      // ask for the required screenshot/video using the AI support voice.
      const verifiedInvoiceId = String(ticket.invoice_id || "").trim().toLowerCase();
      if (verifiedInvoiceId && text.toLowerCase().includes(verifiedInvoiceId)) {
        const repeatInvoiceContext = "IMPORTANT VERIFIED BACKEND RESULT: This ticket's invoice has already been successfully verified as found, paid/completed, and containing the Netflix product. The customer has repeated the same invoice ID but has NOT attached evidence in this message. Naturally reassure them that the invoice is already verified and ask them to attach a screenshot or video showing the issue directly to this ticket. Do not verify or reject the invoice again, do not ask for the invoice ID again, and do not claim evidence has been received or promise approval.";
        await sendAI(message.channel, ticket.id, text, repeatInvoiceContext);
        return;
      }

      const noProofMessage = "I haven't received an image or video attachment yet. Please attach a screenshot or video showing the issue directly to this ticket. Your invoice is verified, but your replacement request cannot be sent to staff until the evidence is attached.";
      await store.addMessage(ticket.id, "assistant", noProofMessage);
      await message.channel.send(noProofMessage);
      return;
    }

    const proofData = proof.map(a => ({
      name: a.name, url: a.url, contentType: a.contentType || "unknown", size: a.size
    }));
    const deadline = Date.now() + config.autoApproveMinutes * 60_000;
    await store.updateTicket({
      id: ticket.id, status: "awaiting_staff",
      proof_json: JSON.stringify(proofData), deadline_at: deadline
    });

    const evidenceReceivedMessage = "Thank you for submitting the evidence. Our team is now reviewing your case. You can expect an update within the next 2 hours regarding your replacement request. If you have any further questions or concerns, feel free to ask.";
    await store.addMessage(ticket.id, "assistant", evidenceReceivedMessage);
    await message.channel.send(evidenceReceivedMessage);
    const updated = await store.getTicket(ticket.id);
    try {
      await notifyStaff(updated, message.channel, proof);
    } catch (err) {
      console.error("Staff notification failed:", err.message);
      await message.channel.send("Your evidence was received, but staff notification failed. Please wait while we retry or contact staff.");
    }
    return;
  }

  if (ticket.status === "awaiting_staff") {
    await sendAI(message.channel, ticket.id, text || "Customer sent another message.", "The replacement request is already waiting for staff review. Acknowledge the message without changing the review status.");
    return;
  }

  await sendAI(message.channel, ticket.id, text || "Customer sent an attachment.", "Continue support. Do not approve replacements or create coupons.");
}

async function decideReplacement(interaction, ticketId, decision) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({ content: "You don't have permission to review replacement requests.", ephemeral: true });
  }
  const ticket = await store.getTicket(ticketId);
  if (!ticket || ticket.status !== "awaiting_staff") {
    return interaction.reply({ content: "This ticket is no longer awaiting a staff decision.", ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  if (decision === "accept") {
    const code = `OGSHOP-${Array.from({ length: 5 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[crypto.randomInt(26)]).join("")}`;
    try {
      await createNetflixCoupon(code);
    } catch (err) {
      console.error("Coupon creation failed:", err.message);
      const detail = String(err.message || "Unknown SellAuth error").slice(0, 1200);
      return interaction.editReply(`SellAuth coupon creation failed. No coupon was issued. API detail: ${detail}`);
    }

    await store.updateTicket({
      id: ticket.id, status: "approved", decided_at: Date.now(),
      decision_by: interaction.user.id, coupon_code: code
    });
    await updateStaffMessage(interaction, ticket, "APPROVED", `Approved by ${interaction.user.tag}. Coupon: ${code}`);
    const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
    if (channel) {
      await channel.send(`Good news! Your replacement request has been approved. Your one-time Netflix replacement code is **${code}**. It is intended for the Netflix product only.`);
    }
    return interaction.editReply(`Replacement approved. Coupon created: ${code}`);
  }

  await store.updateTicket({
    id: ticket.id, status: "declined", decided_at: Date.now(),
    decision_by: interaction.user.id
  });
  await updateStaffMessage(interaction, ticket, "DECLINED", `Declined by ${interaction.user.tag}`);
  const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
  if (channel) {
    await sendAI(channel, ticket.id,
      "Staff declined the replacement request.",
      "Staff declined the request. Politely explain that this may be due to too many replacement claims or insufficient proof. If they believe this is a mistake, ask them to upload additional proof for staff to review. Do not accuse them of fraud.");
  }
  return interaction.editReply("Replacement declined.");
}

async function updateStaffMessage(interaction, ticket, status, detail) {
  try {
    const msg = await interaction.channel.messages.fetch(ticket.staff_message_id);
    const embed = EmbedBuilder.from(msg.embeds[0] || new EmbedBuilder())
      .setColor(status === "APPROVED" ? 0x2ECC71 : 0xE74C3C)
      .setTitle(`Replacement ${status}`)
      .addFields({ name: "Decision", value: detail });
    await msg.edit({ embeds: [embed], components: [] });
  } catch (err) {
    console.error("Could not update staff log message:", err.message);
  }
}

async function autoApprove(ticket) {
  const current = await store.getTicket(ticket.id);
  if (!current || current.status !== "awaiting_staff" || !current.deadline_at || current.deadline_at > Date.now()) return;

  const code = `OGSHOP-${Array.from({ length: 5 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[crypto.randomInt(26)]).join("")}`;
  try {
    await createNetflixCoupon(code);
    await store.updateTicket({
      id: current.id, status: "auto_approved", decided_at: Date.now(),
      decision_by: "AUTO_TIMEOUT", coupon_code: code
    });
    const channel = await client.channels.fetch(current.channel_id).catch(() => null);
    if (channel) {
      await channel.send(`Your Netflix replacement request was automatically approved because staff did not respond within ${config.autoApproveMinutes} minutes. Your one-time replacement code is **${code}**. It is restricted to Netflix.`);
    }
    const log = await client.channels.fetch(config.staffLogChannelId).catch(() => null);
    if (log && current.staff_message_id) {
      const msg = await log.messages.fetch(current.staff_message_id).catch(() => null);
      if (msg) {
        const embed = EmbedBuilder.from(msg.embeds[0] || new EmbedBuilder())
          .setTitle("Replacement AUTO-APPROVED")
          .setColor(0x2ECC71)
          .addFields({ name: "Automatic decision", value: `No staff decision within ${config.autoApproveMinutes} minutes. Coupon: ${code}` });
        await msg.edit({ embeds: [embed], components: [] });
      }
    }
  } catch (err) {
    console.error(`Auto-approval failed for ticket ${current.id}:`, err.message);
    // Keep awaiting_staff so a later timer tick retries; never mark approved without a confirmed API success.
  }
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  try {
    const rest = new REST({ version: "10" }).setToken(config.discordToken);
    const route = config.guildId
      ? Routes.applicationGuildCommands(config.clientId, config.guildId)
      : Routes.applicationCommands(config.clientId);
    await rest.put(route, { body: commands });
    console.log(config.guildId
      ? `Registered slash commands in guild ${config.guildId}`
      : "Registered global slash commands (Discord may take time to show them).");
  } catch (err) {
    console.error("Slash command registration failed:", err);
  }
  setInterval(async () => {
    for (const ticket of await store.getPending()) await autoApprove(ticket);
  }, 15_000).unref();
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "setup") {
        await interaction.deferReply({ ephemeral: true });
        const panelChannel = await client.channels.fetch(config.ticketPanelChannelId);
        if (!panelChannel?.isTextBased() || !panelChannel.guild || panelChannel.guild.id !== interaction.guildId) {
          return interaction.editReply("The configured ticket panel channel is unavailable or is not a text channel in this server. Check TICKET_PANEL_CHANNEL_ID and the bot's channel permissions.");
        }
        const panelMessage = await panelChannel.send({
          content: "**OGSHOP SUPPORT**\nChoose the type of support you need below.",
          components: panelComponents()
        });
        await interaction.editReply(`Ticket panel posted in <#${panelChannel.id}>: ${panelMessage.url}`);
      } else if (interaction.commandName === "close") {
        const ticket = await store.getByChannel(interaction.channelId);
        if (!ticket) return interaction.reply({ content: "This is not a ticket channel.", ephemeral: true });
        if (interaction.user.id !== ticket.user_id && !isStaff(interaction.member)) {
          return interaction.reply({ content: "Only the ticket owner or staff can close this ticket.", ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        await store.updateTicket({ id: ticket.id, status: "closed", decided_at: Date.now() });
        await interaction.channel.delete("Ticket closed by ticket owner or staff");
        await interaction.deleteReply().catch(() => {});
      } else if (interaction.commandName === "mute" || interaction.commandName === "voucher") {
        if (!hasCommandRole(interaction.member)) {
          return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
        }
        const ticket = await store.getByChannel(interaction.channelId);
        if (!ticket) {
          return interaction.reply({ content: "This command can only be used inside a support ticket.", ephemeral: true });
        }

        if (interaction.commandName === "mute") {
          const enabled = interaction.options.getBoolean("enabled", true);
          await store.updateTicket({ id: ticket.id, ai_muted: enabled });
          return interaction.reply({
            content: enabled
              ? "AI replies are now muted in this ticket. Use /mute enabled:false to turn them back on."
              : "AI replies are now enabled again in this ticket.",
            ephemeral: true
          });
        }

        await interaction.deferReply({ ephemeral: true });
        const code = `OGSHOP-${Array.from({ length: 5 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[crypto.randomInt(26)]).join("")}`;
        try {
          await createNetflixCoupon(code);
        } catch (err) {
          console.error("Manual voucher creation failed:", err.message);
          const detail = String(err.message || "Unknown SellAuth error").slice(0, 1000);
          return interaction.editReply(`SellAuth could not create the Netflix voucher. No code was issued. API detail: ${detail}`);
        }
        await store.updateTicket({ id: ticket.id, coupon_code: code });
        await interaction.channel.send(
          `A Netflix voucher has been manually created by <@${interaction.user.id}>: **${code}**\nThis is a one-use code restricted to the Netflix product.`
        );
        return interaction.editReply(`Netflix voucher created successfully: **${code}**`);
      }
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === "ticket:replacement" || interaction.customId === "ticket:question") {
        const kind = interaction.customId.endsWith("question") ? "question" : "replacement";
        await interaction.deferReply({ ephemeral: true });
        const { channel, id } = await createTicketChannel(interaction, kind);
        await interaction.editReply(`Your ticket has been created: ${channel}`);
        if (kind === "question") {
          await channel.send(`Hello <@${interaction.user.id}>! I'm OGSHOP's AI support assistant. Tell me what you need help with. A staff member can join if needed.`);
        } else {
          await channel.send({
            content: `Hello <@${interaction.user.id}>! Please choose which product your replacement request is about.`,
            components: [productSelect()]
          });
        }
        return;
      }

      if (interaction.customId.startsWith("staff:accept:")) {
        return decideReplacement(interaction, interaction.customId.split(":")[2], "accept");
      }
      if (interaction.customId.startsWith("staff:decline:")) {
        return decideReplacement(interaction, interaction.customId.split(":")[2], "decline");
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "product:select") {
      const ticket = await store.getByChannel(interaction.channelId);
      if (!ticket || ticket.user_id !== interaction.user.id || ticket.status !== "choose_product") {
        return interaction.reply({ content: "This product menu is no longer active for you.", ephemeral: true });
      }
      const product = interaction.values[0];
      if (product === "other") {
        await store.updateTicket({ id: ticket.id, status: "question", product: "other" });
        await interaction.reply({ content: "Other selected.", ephemeral: true });
        await interaction.channel.send(`Thanks <@${interaction.user.id}>. Tell us what happened and I'll help you with the next steps.`);
      } else {
        await store.updateTicket({ id: ticket.id, status: "awaiting_invoice", product: "netflix" });
        await interaction.reply({ content: "Netflix selected.", ephemeral: true });
        await interaction.channel.send("Please send your OGSHOP invoice ID so I can check it against our store. Don't send passwords or account credentials.");
      }
    }
  } catch (err) {
    console.error("Interaction error:", err?.stack || err);
    const message = "Something went wrong. Please try again or contact staff.";
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});

client.on(Events.MessageCreate, message => {
  handleCustomerMessage(message).catch(err => console.error("Message handler error:", err));
});

client.login(config.discordToken);

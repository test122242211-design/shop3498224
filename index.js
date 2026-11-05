const {
  Client, GatewayIntentBits, Partials, ChannelType, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  EmbedBuilder, Events
} = require("discord.js");
const express = require("express");
const crypto = require("node:crypto");
const config = require("./config");
const store = require("./db");
const { generateReply } = require("./ai");
const { verifyInvoice, createNetflixCoupon } = require("./sellauth");

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
  store.createTicket({
    id, guild_id: guild.id, channel_id: channel.id, user_id: interaction.user.id,
    kind, product: null, status: kind === "question" ? "question" : "choose_product",
    created_at: Date.now()
  });
  return { channel, id };
}

async function sendAI(channel, ticketId, userText, context = "") {
  let answer;
  try {
    answer = await generateReply(ticketId, userText, context);
  } catch (err) {
    console.error("OpenRouter error:", err.message);
    answer = "Thanks for your message. I've had trouble generating a reply just now, but your message is saved and our team can still help.";
  }
  store.addMessage(ticketId, "assistant", answer);
  await channel.send({ content: answer });
}

function productSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("product:select")
      .setPlaceholder("Choose the product")
      .addOptions(
        { label: "Netflix", value: "netflix", description: "Netflix replacement request" },
        { label: "Other", value: "other", description: "Other product support (no automatic replacement)" }
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
  store.updateTicket({ id: ticket.id, staff_message_id: sent.id });
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
  const ticket = store.getByChannel(message.channel.id);
  if (!ticket || ticket.user_id !== message.author.id) return;
  if (["approved", "declined", "auto_approved", "closed"].includes(ticket.status)) return;

  const text = message.content?.trim() || "";
  store.addMessage(ticket.id, "user", text || "[attachment]");
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
    const invoiceId = text.match(/\b[A-Za-z0-9_-]{4,80}\b/)?.[0];
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
      await message.channel.send("I'm unable to check the invoice with SellAuth right now. Please try again in a moment; staff have not marked it as verified.");
      return;
    }

    if (!result.found || !result.paid || !result.hasNetflix) {
      const reason = !result.found ? "No matching invoice was found." :
        !result.paid ? "The invoice was found but is not marked paid/completed." :
        "The invoice does not contain the configured Netflix product.";
      await sendAI(message.channel, ticket.id, text, `${reason} Ask the customer to double-check the invoice ID. Do not say it is verified.`);
      return;
    }

    store.updateTicket({ id: ticket.id, status: "awaiting_proof", invoice_id: invoiceId });
    await sendAI(message.channel, ticket.id, text, "Backend verified a paid invoice matching the Netflix product. Ask the customer for a screenshot or video clearly showing the issue.");
    return;
  }

  if (ticket.status === "awaiting_proof") {
    const proof = attachments.filter(isImageOrVideo);
    if (proof.length === 0) {
      await sendAI(message.channel, ticket.id, text || "No valid evidence attachment was included.", "The customer must upload at least one image or video attachment. Text alone is not proof. Ask them to attach a screenshot or video.");
      return;
    }

    const proofData = proof.map(a => ({
      name: a.name, url: a.url, contentType: a.contentType || "unknown", size: a.size
    }));
    const deadline = Date.now() + config.autoApproveMinutes * 60_000;
    store.updateTicket({
      id: ticket.id, status: "awaiting_staff",
      proof_json: JSON.stringify(proofData), deadline_at: deadline
    });

    await sendAI(message.channel, ticket.id, text || "Customer submitted evidence.", "The backend detected at least one image/video attachment. Tell the customer their complaint has been sent to staff for review and they should wait. Do not promise approval.");
    const updated = store.getTicket(ticket.id);
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
  const ticket = store.getTicket(ticketId);
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
      return interaction.editReply("SellAuth coupon creation failed. No coupon was issued. Check the SellAuth endpoint/payload configuration and try again.");
    }

    store.updateTicket({
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

  store.updateTicket({
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
  const current = store.getTicket(ticket.id);
  if (!current || current.status !== "awaiting_staff" || !current.deadline_at || current.deadline_at > Date.now()) return;

  const code = `OGSHOP-${Array.from({ length: 5 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[crypto.randomInt(26)]).join("")}`;
  try {
    await createNetflixCoupon(code);
    store.updateTicket({
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

client.once(Events.ClientReady, readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  setInterval(async () => {
    for (const ticket of store.getPending()) await autoApprove(ticket);
  }, 15_000).unref();
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "setup") {
        await interaction.reply({
          content: "**OGSHOP SUPPORT**\nChoose the type of support you need below.",
          components: panelComponents()
        });
      } else if (interaction.commandName === "close") {
        const ticket = store.getByChannel(interaction.channelId);
        if (!ticket) return interaction.reply({ content: "This is not a ticket channel.", ephemeral: true });
        if (interaction.user.id !== ticket.user_id && !isStaff(interaction.member)) {
          return interaction.reply({ content: "Only the ticket owner or staff can close this ticket.", ephemeral: true });
        }
        store.updateTicket({ id: ticket.id, status: "closed", decided_at: Date.now() });
        await interaction.reply("Ticket closed. Staff can delete this channel when appropriate.");
        await interaction.channel.permissionOverwrites.edit(ticket.user_id, { SendMessages: false });
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
      const ticket = store.getByChannel(interaction.channelId);
      if (!ticket || ticket.user_id !== interaction.user.id || ticket.status !== "choose_product") {
        return interaction.reply({ content: "This product menu is no longer active for you.", ephemeral: true });
      }
      const product = interaction.values[0];
      if (product === "other") {
        store.updateTicket({ id: ticket.id, status: "question", product: "other" });
        await interaction.reply("Thanks. This will be handled as a normal support question; no automatic replacement coupon is available for this product.");
        await interaction.channel.send(`Thanks <@${interaction.user.id}>. Tell us what happened and I'll help you with the next steps.`);
      } else {
        store.updateTicket({ id: ticket.id, status: "awaiting_invoice", product: "netflix" });
        await interaction.reply("Netflix selected.");
        await interaction.channel.send("Please send your SellAuth invoice ID so I can check it against the store. Don't send passwords or account credentials.");
      }
    }
  } catch (err) {
    console.error("Interaction error:", err);
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

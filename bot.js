const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    MessageFlags,
    Partials,
    SlashCommandBuilder,
    PermissionFlagsBits
} = require('discord.js');
const config = require('./config.js');
const fs = require('fs').promises;
const path = require('path');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel]
});

// Data storage
const activeTickets = new Map();
const TICKETS_FILE = path.join(__dirname, 'tickets.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const legitimateAdditions = new Set();

// Per-guild settings (e.g. ticket channel), keyed by guild ID
const guildSettings = new Map();

// Constants
const TICKET_REASONS = [
    'Verification',
    'Behavior/Rules Violation',
    'Role Correction',
    'Consent Verification',
    'General Support'
];

const COLORS = {
    OPEN: 0x5865F2,
    CLAIMED: 0xFEE75C,
    CLOSED: 0xED4245,
    INFO: 0x5865F2,
    ERROR: 0xFF6B6B
};

// Helper functions
const getRoleByName = (guild, name) =>
    guild.roles.cache.find(role => role.name.toLowerCase() === name.toLowerCase()) || null;

const getModeratorRole = (guild) => getRoleByName(guild, config.moderatorRoleName);
const getVerifiedRole = (guild) => getRoleByName(guild, config.verifiedRoleName);

const isModerator = (member) => {
    const role = getModeratorRole(member.guild);
    return role ? member.roles.cache.has(role.id) : false;
};

const getUserLevel = (member) => {
    let highestLevel = 0;
    for (const role of member.roles.cache.values()) {
        const match = role.name.match(/^Level (\d+)$/i);
        if (match) {
            const level = parseInt(match[1]);
            if (level > highestLevel) highestLevel = level;
        }
    }
    return highestLevel;
};

const findUser = async (guild, userInput) => {
    // Try user mention
    const mentionMatch = userInput.match(/<@!?(\d+)>/);
    if (mentionMatch) {
        try {
            return await client.users.fetch(mentionMatch[1]);
        } catch { return null; }
    }
    
    // Try user ID
    if (/^\d+$/.test(userInput.trim())) {
        try {
            return await client.users.fetch(userInput.trim());
        } catch { }
    }
    
    // Try username or tag
    const members = await guild.members.fetch();
    const member = members.find(m => 
        m.user.username.toLowerCase() === userInput.toLowerCase() ||
        m.user.tag.toLowerCase() === userInput.toLowerCase()
    );
    return member ? member.user : null;
};

const removeMembersExcept = async (thread, keepIds) => {
    const members = await thread.members.fetch();
    for (const [memberId] of members) {
        if (!keepIds.includes(memberId)) {
            try {
                await thread.members.remove(memberId);
            } catch (error) {
                console.error(`Could not remove member ${memberId}:`, error);
            }
        }
    }
};

const updateTicketStatus = async (thread, ticketData, status, color = null) => {
    if (!ticketData?.controlMessageId) return;
    
    try {
        const controlMessage = await thread.messages.fetch(ticketData.controlMessageId);
        const embed = EmbedBuilder.from(controlMessage.embeds[0]);
        
        if (color) embed.setColor(color);
        
        const fieldsWithoutStatus = controlMessage.embeds[0].fields.filter(f => f.name !== 'Status');
        embed.setFields(fieldsWithoutStatus).spliceFields(1, 0, { 
            name: 'Status', 
            value: status, 
            inline: true 
        });
        
        await controlMessage.edit({ embeds: [embed] });
    } catch (error) {
        console.error('Error updating control message:', error);
    }
};

// Ticket data persistence
async function saveTickets() {
    try {
        const ticketsData = {};
        for (const [threadId, data] of activeTickets.entries()) {
            const { autoCloseTimer, ...saveData } = data;
            ticketsData[threadId] = saveData;
        }
        await fs.writeFile(TICKETS_FILE, JSON.stringify(ticketsData, null, 2));
        console.log('💾 Tickets saved to disk');
    } catch (error) {
        console.error('Error saving tickets:', error);
    }
}

async function loadTickets() {
    try {
        const data = await fs.readFile(TICKETS_FILE, 'utf8');
        const ticketsData = JSON.parse(data);
        
        for (const [threadId, ticketData] of Object.entries(ticketsData)) {
            if (!ticketData.archivedAttachments) {
                ticketData.archivedAttachments = [];
            }
            activeTickets.set(threadId, ticketData);
        }
        
        console.log(`📂 Loaded ${activeTickets.size} active tickets from disk`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('📝 No existing tickets file found, starting fresh');
        } else {
            console.error('Error loading tickets:', error);
        }
    }
}

// Guild settings persistence
async function loadSettings() {
    try {
        const data = await fs.readFile(SETTINGS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        for (const [guildId, settings] of Object.entries(parsed)) {
            guildSettings.set(guildId, settings);
        }
        console.log(`⚙️  Loaded settings for ${guildSettings.size} guild(s)`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('📝 No settings file found, starting fresh');
        } else {
            console.error('Error loading settings:', error);
        }
    }
}

async function saveSettings() {
    try {
        const obj = {};
        for (const [guildId, settings] of guildSettings.entries()) {
            obj[guildId] = settings;
        }
        await fs.writeFile(SETTINGS_FILE, JSON.stringify(obj, null, 2));
    } catch (error) {
        console.error('Error saving settings:', error);
    }
}

function getTicketChannelId(guildId) {
    return guildSettings.get(guildId)?.ticketChannelId || null;
}

async function setTicketChannel(guildId, channelId) {
    const settings = guildSettings.get(guildId) || {};
    settings.ticketChannelId = channelId;
    guildSettings.set(guildId, settings);
    await saveSettings();
}

// Slash command definitions
const slashCommands = [
    new SlashCommandBuilder()
        .setName('setup-tickets')
        .setDescription('Set this channel as the ticket channel and post the ticket panel')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('add')
        .setDescription('Add a user to the current ticket')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to add to this ticket')
                .setRequired(true))
].map(command => command.toJSON());

async function registerSlashCommands(guild) {
    try {
        await guild.commands.set(slashCommands);
    } catch (error) {
        console.error(`Error registering slash commands for guild ${guild.id}:`, error);
    }
}

// Event handlers
client.once('clientReady', async () => {
    console.log('\n╔═══════════════════════════════════════╗');
    console.log('║   🤫 Psst - Private Support System   ║');
    console.log('║        Tickets Bot Ready!             ║');
    console.log('╚═══════════════════════════════════════╝\n');
    console.log(`Logged in as ${client.user.tag}`);
    
    await loadSettings();
    await loadTickets();
    
    // Register slash commands for every guild the bot is in
    for (const guild of client.guilds.cache.values()) {
        await registerSlashCommands(guild);
    }
    console.log(`🔧 Slash commands registered for ${client.guilds.cache.size} guild(s)`);
    
    // Run cleanup on startup to remove orphaned/expired tickets
    await cleanupOrphanedTickets();
    
    console.log('\n✅ System ready to handle tickets!\n');
    
    // Schedule periodic cleanup check
    setInterval(checkAutoCloseTickets, 60 * 60 * 1000);
});

client.on('guildCreate', async (guild) => {
    await registerSlashCommands(guild);
    console.log(`🔧 Slash commands registered for new guild ${guild.name}`);
});

client.on('threadMembersUpdate', async (addedMembers, removedMembers, thread) => {
    if (!activeTickets.has(thread.id)) return;
    
    for (const member of addedMembers.values()) {
        if (member.id === client.user.id) continue;
        
        const addKey = `${thread.id}-${member.id}`;
        if (legitimateAdditions.has(addKey)) {
            legitimateAdditions.delete(addKey);
            continue;
        }
        
        const messages = await thread.messages.fetch({ limit: 5 });
        const recentMessage = messages.find(msg => 
            msg.mentions.users.has(member.id) && 
            msg.author.id !== client.user.id &&
            Date.now() - msg.createdTimestamp < 5000
        );
        
        if (recentMessage) {
            try {
                await thread.members.remove(member.id);
                await thread.send({
                    content: `❌ <@${recentMessage.author.id}>, you cannot add members by tagging them. Moderators can use the \`/add\` command to add members to this ticket.`
                });
            } catch (error) {
                console.error('Error removing tagged member:', error);
            }
        }
    }
});

client.on('messageDelete', async (message) => {
    if (!message.channel.isThread() || !activeTickets.has(message.channel.id)) return;
    if (message.author?.bot) return;
    
    const hasAttachments = message.attachments && message.attachments.size > 0;
    const hasEmbeds = message.embeds && message.embeds.length > 0;
    
    if (!hasAttachments && !hasEmbeds) return;
    
    try {
        const member = await message.guild.members.fetch(message.author.id);
        if (isModerator(member)) return;
        
        const ticketData = activeTickets.get(message.channel.id);
        if (!ticketData) return;
        
        if (!ticketData.archivedAttachments) {
            ticketData.archivedAttachments = [];
        }
        
        if (hasAttachments) {
            for (const attachment of message.attachments.values()) {
                ticketData.archivedAttachments.push({
                    name: attachment.name,
                    url: attachment.url
                });
            }
        }
        
        await saveTickets();
        
        const controlMessage = await message.channel.messages.fetch(ticketData.controlMessageId);
        const currentEmbed = EmbedBuilder.from(controlMessage.embeds[0]);
        
        const fieldsWithoutArchive = currentEmbed.data.fields.filter(f => f.name !== '📎 Archived Attachments');
        currentEmbed.setFields(fieldsWithoutArchive);
        
        const attachmentList = ticketData.archivedAttachments
            .map(att => `[${att.name}](${att.url})`)
            .join('\n');
        
        currentEmbed.addFields({
            name: '📎 Archived Attachments',
            value: attachmentList.substring(0, 1024) || 'None',
            inline: false
        });
        
        await controlMessage.edit({ embeds: [currentEmbed] });
    } catch (error) {
        console.error('Error archiving deleted message:', error);
    }
});

// Ticket management functions
async function checkAutoCloseTickets() {
    const now = Date.now();
    const autoCloseDuration = config.autoCloseAfterDays * 24 * 60 * 60 * 1000;
    
    for (const [threadId, ticketData] of activeTickets.entries()) {
        const timeSinceCreation = now - ticketData.createdAt;
        
        if (timeSinceCreation >= autoCloseDuration) {
            try {
                const thread = await client.channels.fetch(threadId);
                if (thread && !thread.archived) {
                    await closeTicket(thread, null, 'Auto-closed after 7 days of inactivity');
                }
            } catch (error) {
                console.error(`Error auto-closing ticket ${threadId}:`, error);
                activeTickets.delete(threadId);
            }
        }
    }
}

async function cleanupOrphanedTickets() {
    const totalTickets = activeTickets.size;
    console.log(`🧹 Running startup cleanup on ${totalTickets} ticket(s)...`);
    
    if (totalTickets === 0) {
        console.log('✅ Cleanup complete: No tickets to check');
        return;
    }
    
    const ticketsToRemove = [];
    let expiredCount = 0;
    let orphanedCount = 0;
    let processedCount = 0;
    
    // Process tickets in batches to avoid rate limiting
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 2000; // 2 seconds between batches
    
    const ticketEntries = Array.from(activeTickets.entries());
    const batches = [];
    
    // Split into batches
    for (let i = 0; i < ticketEntries.length; i += BATCH_SIZE) {
        batches.push(ticketEntries.slice(i, i + BATCH_SIZE));
    }
    
    console.log(`   Processing ${batches.length} batch(es) of up to ${BATCH_SIZE} tickets each...`);
    
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        
        // Process all tickets in this batch concurrently
        await Promise.all(batch.map(async ([threadId, ticketData]) => {
            try {
                // Try to fetch the thread to verify it exists
                const thread = await client.channels.fetch(threadId);
                
                if (!thread) {
                    console.log(`   ❌ Thread ${threadId} not found - marking for removal`);
                    ticketsToRemove.push(threadId);
                    orphanedCount++;
                    return;
                }
                
                // Check if the ticket is expired
                const now = Date.now();
                const autoCloseDuration = config.autoCloseAfterDays * 24 * 60 * 60 * 1000;
                const timeSinceCreation = now - ticketData.createdAt;
                
                if (timeSinceCreation >= autoCloseDuration) {
                    console.log(`   ⏰ Ticket ${threadId} expired - closing`);
                    if (!thread.archived) {
                        await closeTicket(thread, null, 'Auto-closed after 7 days of inactivity');
                    } else {
                        activeTickets.delete(threadId);
                    }
                    expiredCount++;
                }
            } catch (error) {
                // If we can't fetch the thread, it probably doesn't exist anymore
                if (error.code === 10003 || error.code === 10008) { // Unknown Channel or Unknown Message
                    console.log(`   ❌ Thread ${threadId} doesn't exist in server - marking for removal`);
                    ticketsToRemove.push(threadId);
                    orphanedCount++;
                } else {
                    console.error(`   ⚠️ Error checking ticket ${threadId}:`, error.message);
                }
            }
        }));
        
        processedCount += batch.length;
        
        // Show progress for large cleanups
        if (totalTickets > BATCH_SIZE) {
            console.log(`   Progress: ${processedCount}/${totalTickets} tickets checked`);
        }
        
        // Wait between batches (except for the last one)
        if (batchIndex < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
        }
    }
    
    // Remove orphaned tickets
    for (const threadId of ticketsToRemove) {
        activeTickets.delete(threadId);
    }
    
    // Save the cleaned up state
    if (ticketsToRemove.length > 0 || expiredCount > 0) {
        await saveTickets();
        console.log(`✅ Cleanup complete: Removed ${orphanedCount} orphaned ticket(s), closed ${expiredCount} expired ticket(s)`);
    } else {
        console.log('✅ Cleanup complete: No issues found');
    }
}

async function createTicketPanel(channel) {
    // Clear channel
    try {
        let fetched;
        do {
            fetched = await channel.messages.fetch({ limit: 100 });
            if (fetched.size > 0) {
                try {
                    await channel.bulkDelete(fetched, true);
                } catch {
                    for (const message of fetched.values()) {
                        try {
                            await message.delete();
                        } catch { }
                    }
                }
            }
        } while (fetched.size >= 100);
    } catch (error) {
        console.error('Error clearing channel:', error);
    }

    // Set permissions
    try {
        if (channel && channel.permissionOverwrites) {
            await channel.permissionOverwrites.set([
                {
                    id: channel.guild.roles.everyone.id,
                    deny: ['SendMessages', 'CreatePublicThreads', 'CreatePrivateThreads'],
                    allow: ['ViewChannel', 'ReadMessageHistory', 'SendMessagesInThreads', 'AttachFiles', 'EmbedLinks']
                },
                {
                    id: client.user.id,
                    allow: ['SendMessages', 'ViewChannel', 'ReadMessageHistory', 'ManageThreads', 'CreatePrivateThreads', 'SendMessagesInThreads', 'EmbedLinks', 'AttachFiles']
                }
            ]);
        }
    } catch (error) {
        console.error('Error setting channel permissions:', error);
    }

    const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle('🎫 Support Ticket System')
        .setDescription('Need help from the moderation team? Create a private support ticket below.')
        .addFields(
            { name: '✅ Verification (Level 5+)', value: 'Verify your identity to join the VIP club', inline: false },
            { name: '⚠️ Behavior/Rules Violation', value: 'Report or discuss rule violations or concerning behavior', inline: false },
            { name: '🎭 Role Correction', value: 'Request changes or corrections to your roles', inline: false },
            { name: '📸 Consent Verification (Level 5+)', value: 'Verify consent for individuals featured in shared media', inline: false },
            { name: '💬 General Support', value: 'Any other questions or support needs', inline: false }
        )
        .setFooter({ text: '⚠️ Abuse of this system may result in a ban from the community\n🔒 All tickets are private - only visible to you and the moderation team' });

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('create_ticket')
                .setLabel('Create Ticket')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🎫'),
            new ButtonBuilder()
                .setCustomId('contact_user')
                .setLabel('Contact User')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('📧')
        );

    await channel.send({ embeds: [embed], components: [row] });
}

function createTicketControls(reason, claimed = false) {
    const buttons = [
        new ButtonBuilder()
            .setCustomId('ticket_close')
            .setLabel('Close')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔒'),
        new ButtonBuilder()
            .setCustomId(claimed ? 'ticket_release' : 'ticket_claim')
            .setLabel(claimed ? 'Release' : 'Claim')
            .setStyle(claimed ? ButtonStyle.Secondary : ButtonStyle.Success)
            .setEmoji(claimed ? '🔓' : '✋')
    ];

    if (reason === 'Verification') {
        buttons.push(
            new ButtonBuilder()
                .setCustomId('ticket_verify')
                .setLabel('Verify User')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('✅')
        );
    }

    return new ActionRowBuilder().addComponents(buttons);
}

async function createTicket(guild, creator, reason, moderator = null, onBehalfOf = false) {
    try {
        const ticketChannelId = getTicketChannelId(guild.id);
        if (!ticketChannelId) {
            throw new Error('Ticket channel not configured. An administrator must run /setup-tickets.');
        }

        const ticketChannel = await guild.channels.fetch(ticketChannelId);
        if (!ticketChannel) throw new Error('Ticket channel not found');

        const thread = await ticketChannel.threads.create({
            name: `${creator.username} - ${reason}`,
            autoArchiveDuration: 10080,
            type: ChannelType.PrivateThread,
            reason: `Ticket created by ${creator.tag}`,
            invitable: false
        });

        await thread.members.add(creator.id);

        const embed = new EmbedBuilder()
            .setColor(COLORS.OPEN)
            .setTitle(`🎫 Support Ticket - ${reason}`)
            .setDescription(`Ticket created ${onBehalfOf ? `on behalf of` : 'by'} <@${creator.id}>`)
            .addFields(
                { name: 'Reason', value: reason, inline: true },
                { name: 'Status', value: '🟢 Open', inline: true },
                { name: 'Created', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
            )
            .setFooter({ text: `Ticket will auto-close after ${config.autoCloseAfterDays} days` })
            .setTimestamp();

        const controls = createTicketControls(reason, !!moderator);
        
        const moderatorRole = getModeratorRole(guild);
        const initialMessage = await thread.send({ 
            content: `<@${creator.id}>${moderatorRole ? ` <@&${moderatorRole.id}>` : ''}`,
            embeds: [embed], 
            components: [controls] 
        });

        // Send auto-instructions
        if (reason === 'Verification') {
            const verificationEmbed = new EmbedBuilder()
                .setColor(COLORS.INFO)
                .setTitle('📋 Verification Instructions')
                .setDescription('**Please assign yourself gender and identity roles before verifying.**\n<id:customize>\n\nSubmit a photo prominently featuring yourself holding a **HANDWRITTEN, CRINKLED** note containing:')
                .addFields(
                    { 
                        name: 'Required on Note', 
                        value: `• Your Discord username: **${creator.tag}**\n• Server name: **${guild.name}**\n• The date`,
                        inline: false 
                    },
                    {
                        name: 'Important',
                        value: 'Your face & nudity are not required, but your tags (sex, age, etc) should match the photo. If you are trans, accurately represent that in your chosen tags.',
                        inline: false
                    }
                )
                .setFooter({ text: 'A moderator will review your verification and approve it' });
            
            await thread.send({ embeds: [verificationEmbed] });
        }
        
        if (reason === 'Consent Verification') {
            const consentEmbed = new EmbedBuilder()
                .setColor(COLORS.ERROR)
                .setTitle('📋 Consent Verification Required')
                .setDescription('**Under community rules:**\n*Sharing media requires consent from every identifiable subject. Possessing media does not constitute permission to share it.*\n\nMedia shared within the community featuring identifiable individuals must have verified consent.\n\nSubmit a photo with the subject prominently shown holding a **HANDWRITTEN, CRINKLED** note containing:')
                .addFields(
                    { 
                        name: 'Required on Note', 
                        value: `• The date\n• Server name: **${guild.name}**\n• Username: **${creator.tag}**`,
                        inline: false 
                    },
                    {
                        name: 'Important',
                        value: 'Subject must be shown in equally identifiable manner as in the original content\n (*if full face was shown in-server, then verification must do the same*). \nImages with visible editing, filtering, or smoothing may be rejected.\n\n• **24 hours** to submit verification from the time of this message\n• Failure to verify consent upon request will result in a ban from the community',
                        inline: false 
                    }
                )
                .setFooter({ text: 'Submit verification in this ticket' });
            
            await thread.send({ embeds: [consentEmbed] });
        }

        const ticketData = {
            creatorId: creator.id,
            reason: reason,
            claimedBy: moderator?.id || null,
            createdAt: Date.now(),
            controlMessageId: initialMessage.id,
            onBehalfOf: onBehalfOf,
            archivedAttachments: []
        };
        activeTickets.set(thread.id, ticketData);

        if (moderator && onBehalfOf) {
            ticketData.claimedBy = moderator.id;
            await removeMembersExcept(thread, [client.user.id, creator.id, moderator.id]);
        }

        await saveTickets();

        return thread;
    } catch (error) {
        console.error('Error creating ticket:', error);
        throw error;
    }
}

async function closeTicket(thread, closedBy, reason = 'Ticket closed') {
    try {
        const ticketData = activeTickets.get(thread.id);
        const isAutoClose = closedBy === null;
        
        if (isAutoClose) {
            console.log(`Deleting auto-closed ticket: ${thread.name}`);
            await thread.delete();
            activeTickets.delete(thread.id);
            await saveTickets();
            return;
        }
        
        const messages = await thread.messages.fetch({ limit: 100 });
        const hasUserActivity = messages.some(msg => !msg.author.bot);
        
        if (!hasUserActivity) {
            console.log(`Deleting empty ticket: ${thread.name}`);
            await thread.delete();
            activeTickets.delete(thread.id);
            await saveTickets();
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(COLORS.CLOSED)
            .setTitle('🔒 Ticket Closed')
            .setDescription(reason)
            .addFields(
                { name: 'Closed By', value: closedBy ? `<@${closedBy.id}>` : 'System', inline: true },
                { name: 'Closed At', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
            )
            .setTimestamp();

        await thread.send({ embeds: [embed] });
        await updateTicketStatus(thread, ticketData, '🔴 Closed', COLORS.CLOSED);
        await removeMembersExcept(thread, [client.user.id]);

        if (thread.archived) {
            await thread.setArchived(false);
        }

        await thread.setLocked(true);
        await thread.setArchived(true);

        activeTickets.delete(thread.id);
        await saveTickets();
    } catch (error) {
        console.error('Error closing ticket:', error);
        throw error;
    }
}

// Interaction handlers
client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            await handleSlashCommand(interaction);
        } else if (interaction.isButton()) {
            await handleButtonInteraction(interaction);
        } else if (interaction.isStringSelectMenu()) {
            await handleSelectMenuInteraction(interaction);
        } else if (interaction.isModalSubmit()) {
            await handleModalInteraction(interaction);
        }
    } catch (error) {
        console.error('Error handling interaction:', error);
        
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
                content: '❌ An error occurred while processing your request.', 
                flags: MessageFlags.Ephemeral 
            }).catch(console.error);
        }
    }
});

async function handleSlashCommand(interaction) {
    const { commandName } = interaction;

    if (commandName === 'setup-tickets') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ 
                content: '❌ You need Administrator permissions to use this command.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        await interaction.reply({ 
            content: '✅ Setting up ticket panel...', 
            flags: MessageFlags.Ephemeral 
        });

        try {
            await createTicketPanel(interaction.channel);
            await setTicketChannel(interaction.guildId, interaction.channelId);
            await interaction.editReply({ 
                content: '✅ Ticket panel created! This channel is now set as the ticket channel.' 
            });
        } catch (error) {
            console.error('Error creating ticket panel:', error);
            await interaction.editReply({ 
                content: '❌ Error creating ticket panel. Please check bot permissions.' 
            });
        }
    }

    if (commandName === 'add') {
        if (!interaction.channel.isThread() || !activeTickets.has(interaction.channel.id)) {
            return interaction.reply({ 
                content: '❌ This command can only be used inside a ticket.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        if (!isModerator(interaction.member)) {
            return interaction.reply({ 
                content: '❌ Only moderators can add users to tickets.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        const targetUser = interaction.options.getUser('user');

        try {
            const addKey = `${interaction.channel.id}-${targetUser.id}`;
            legitimateAdditions.add(addKey);

            await interaction.channel.members.add(targetUser.id);
            await interaction.reply({ 
                content: `✅ Added <@${targetUser.id}> to this ticket.`, 
                flags: MessageFlags.Ephemeral 
            });

            setTimeout(() => legitimateAdditions.delete(addKey), 10000);
        } catch (error) {
            console.error('Error adding member to thread:', error);
            await interaction.reply({ 
                content: '❌ Error adding user to this ticket. Please check bot permissions.', 
                flags: MessageFlags.Ephemeral 
            });
        }
    }
}

async function handleButtonInteraction(interaction) {
    const { customId } = interaction;

    if (customId === 'create_ticket') {
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('ticket_reason_select')
            .setPlaceholder('Select a reason for your ticket')
            .addOptions(
                TICKET_REASONS.map(reason => 
                    new StringSelectMenuOptionBuilder()
                        .setLabel(reason)
                        .setValue(reason)
                )
            );

        const row = new ActionRowBuilder().addComponents(selectMenu);

        await interaction.reply({
            content: '🎫 **Create a Support Ticket**\nPlease select the reason for your ticket:',
            components: [row],
            flags: MessageFlags.Ephemeral
        });
    }

    if (customId === 'contact_user') {
        if (!isModerator(interaction.member)) {
            return interaction.reply({ 
                content: '❌ Only moderators can use this button.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        const modal = new ModalBuilder()
            .setCustomId('contact_user_modal')
            .setTitle('Contact User');

        const userInput = new TextInputBuilder()
            .setCustomId('user_input')
            .setLabel('Username or User ID')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter username or user ID')
            .setRequired(true);

        const row1 = new ActionRowBuilder().addComponents(userInput);
        modal.addComponents(row1);

        await interaction.showModal(modal);
    }

    if (customId === 'ticket_claim') {
        if (!isModerator(interaction.member)) {
            return interaction.reply({ 
                content: '❌ Only moderators can claim tickets.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        const thread = interaction.channel;
        const ticketData = activeTickets.get(thread.id);

        if (!ticketData) {
            return interaction.reply({ 
                content: '❌ This ticket is no longer active.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        if (ticketData.claimedBy) {
            return interaction.reply({ 
                content: '❌ This ticket has already been claimed.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        ticketData.claimedBy = interaction.user.id;
        await removeMembersExcept(thread, [client.user.id, ticketData.creatorId, interaction.user.id]);

        const controlMessage = await thread.messages.fetch(ticketData.controlMessageId);
        const updatedControls = createTicketControls(ticketData.reason, true);
        await updateTicketStatus(thread, ticketData, `🟡 Claimed by ${interaction.user.username}`, COLORS.CLAIMED);
        await controlMessage.edit({ components: [updatedControls] });

        await saveTickets();

        await interaction.reply({ 
            content: `✅ Ticket claimed by <@${interaction.user.id}>`
        });
    }

    if (customId === 'ticket_release') {
        if (!isModerator(interaction.member)) {
            return interaction.reply({ 
                content: '❌ Only moderators can release tickets.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        const thread = interaction.channel;
        const ticketData = activeTickets.get(thread.id);

        if (!ticketData) {
            return interaction.reply({ 
                content: '❌ This ticket is no longer active.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        if (!ticketData.claimedBy) {
            return interaction.reply({ 
                content: '❌ This ticket is not claimed.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        ticketData.claimedBy = null;

        const guild = interaction.guild;
        const members = await guild.members.fetch();
        for (const [memberId, member] of members) {
            if (isModerator(member)) {
                try {
                    await thread.members.add(memberId);
                } catch { }
            }
        }

        const controlMessage = await thread.messages.fetch(ticketData.controlMessageId);
        const updatedControls = createTicketControls(ticketData.reason, false);
        await updateTicketStatus(thread, ticketData, '🟢 Open', COLORS.OPEN);
        await controlMessage.edit({ components: [updatedControls] });

        await saveTickets();

        await interaction.reply({ 
            content: `🔓 Ticket released and returned to the queue.`
        });
    }

    if (customId === 'ticket_close') {
        const thread = interaction.channel;
        const ticketData = activeTickets.get(thread.id);

        if (!ticketData) {
            return interaction.reply({ 
                content: '❌ This ticket is no longer active.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        await interaction.reply({ 
            content: `🔒 Closing ticket...`, 
            flags: MessageFlags.Ephemeral 
        });

        await closeTicket(thread, interaction.user, `Ticket closed by <@${interaction.user.id}>`);
    }

    if (customId === 'ticket_verify') {
        if (!isModerator(interaction.member)) {
            return interaction.reply({ 
                content: '❌ Only moderators can verify users.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        const thread = interaction.channel;
        const ticketData = activeTickets.get(thread.id);

        if (!ticketData) {
            return interaction.reply({ 
                content: '❌ This ticket is no longer active.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        try {
            const verifiedRole = getVerifiedRole(interaction.guild);
            if (!verifiedRole) {
                return interaction.reply({ 
                    content: `❌ Could not find a role named "${config.verifiedRoleName}". Please create it or update the configuration.`, 
                    flags: MessageFlags.Ephemeral 
                });
            }

            const member = await interaction.guild.members.fetch(ticketData.creatorId);
            await member.roles.add(verifiedRole.id);

            await interaction.reply({ 
                content: `✅ <@${ticketData.creatorId}> has been verified! Closing ticket...`
            });

            setTimeout(async () => {
                await closeTicket(thread, interaction.user, `User verified by <@${interaction.user.id}>`);
            }, 3000);
        } catch (error) {
            console.error('Error verifying user:', error);
            
            let errorMessage = '❌ Error verifying user. ';
            if (error.code === 50013) {
                errorMessage += 'The bot\'s role must be higher than the Verified role in the server\'s role hierarchy. Please adjust the role positions in Server Settings > Roles.';
            } else {
                errorMessage += 'Please check the role configuration and bot permissions.';
            }
            
            await interaction.reply({ 
                content: errorMessage, 
                flags: MessageFlags.Ephemeral 
            });
        }
    }
}

async function handleSelectMenuInteraction(interaction) {
    const { customId } = interaction;

    if (customId === 'ticket_reason_select') {
        const reason = interaction.values[0];

        if (reason === 'Verification' || reason === 'Consent Verification') {
            const member = await interaction.guild.members.fetch(interaction.user.id);
            const userLevel = getUserLevel(member);
            
            if (userLevel < 5) {
                return interaction.update({
                    content: `❌ **${reason} requires Level 5 or higher**\n\nYou are currently Level ${userLevel}. Please chat in the server to gain levels, then try again once you reach Level 5.`,
                    components: []
                });
            }
        }

        await interaction.update({ 
            content: '🎫 Creating your ticket...', 
            components: []
        });

        try {
            const thread = await createTicket(interaction.guild, interaction.user, reason);
            await interaction.editReply({ 
                content: `✅ Ticket created! <#${thread.id}>` 
            });
        } catch (error) {
            console.error('Error creating ticket:', error);
            await interaction.editReply({ 
                content: '❌ Error creating ticket. Please contact an administrator.' 
            });
        }
    }

    if (customId.startsWith('contact_user_reason_select_')) {
        const userId = customId.replace('contact_user_reason_select_', '');
        const reason = interaction.values[0];

        await interaction.update({ 
            content: '🎫 Creating ticket...', 
            components: []
        });

        try {
            const targetUser = await client.users.fetch(userId);
            const thread = await createTicket(interaction.guild, targetUser, reason, interaction.user, true);
            await interaction.editReply({ 
                content: `✅ Ticket created for ${targetUser.tag}! <#${thread.id}>` 
            });
        } catch (error) {
            console.error('Error creating ticket:', error);
            await interaction.editReply({ 
                content: '❌ Error creating ticket. Please contact an administrator.' 
            });
        }
    }
}

async function handleModalInteraction(interaction) {
    const { customId } = interaction;

    if (customId === 'contact_user_modal') {
        const userInput = interaction.fields.getTextInputValue('user_input');
        const targetUser = await findUser(interaction.guild, userInput);

        if (!targetUser) {
            return interaction.reply({ 
                content: '❌ Could not find that user. Please check the username or ID.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`contact_user_reason_select_${targetUser.id}`)
            .setPlaceholder('Select a reason for the ticket')
            .addOptions(
                TICKET_REASONS.map(reason => 
                    new StringSelectMenuOptionBuilder()
                        .setLabel(reason)
                        .setValue(reason)
                )
            );

        const row = new ActionRowBuilder().addComponents(selectMenu);

        await interaction.reply({
            content: `📧 **Create Ticket for ${targetUser.tag}**\nPlease select the reason for the ticket:`,
            components: [row],
            flags: MessageFlags.Ephemeral 
        });
    }
}

client.login(config.token);

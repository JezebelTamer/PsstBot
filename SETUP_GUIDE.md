# Quick Setup Guide

*🤫 Psst... let's get your ticket system running in 5 minutes!*

## Prerequisites

- Discord server with Level 2 boost (or higher) for private threads
- Administrator permissions on the server
- A moderator role and verified role already created

## Setup Steps

### 1. Get Your Discord IDs

Enable Developer Mode:
- User Settings → Advanced → Enable "Developer Mode"

Then get these IDs by right-clicking and selecting "Copy ID":
- **Moderator Role**: Server Settings → Roles → Right-click moderator role
- **Verified Role**: Server Settings → Roles → Right-click verified role
- **Ticket Channel**: Right-click your support/ticket channel

### 2. Configure the Bot

Copy the example config:
```bash
cp config.js.example config.js
```

Edit `config.js` with your values:
```javascript
module.exports = {
    token: 'YOUR_BOT_TOKEN_HERE',
    moderatorRoleId: '123456789012345678',
    verifiedRoleId: '123456789012345678',
    ticketChannelId: '123456789012345678',
    autoCloseAfterDays: 7
};
```

**⚠️ Never commit `config.js` - it contains your bot token!**

### 3. Set Bot Role Position

**Critical:** Bot role must be ABOVE the Verified role

1. Server Settings → Roles
2. Drag bot's role above the Verified role
3. This allows the "Verify User" button to work

### 4. Start the Bot

```bash
npm start
```

You should see:
```
╔═══════════════════════════════════════╗
║   🤫 Psst - Private Support System   ║
║        Tickets Bot Ready!             ║
╚═══════════════════════════════════════╝

Logged in as YourBot#1234
📂 Loaded 0 active tickets from disk

✅ System ready to handle tickets!
```

### 5. Initialize the Ticket Panel

In your ticket channel, type:
```
!setup-tickets
```

The bot will:
- Clear the channel
- Set proper permissions automatically
- Create the ticket panel with buttons

### 6. Test It

**User Test:**
1. Click "Create Ticket"
2. Select "General Support"
3. Verify thread is created and you can send messages

**Moderator Test:**
1. Click "Claim" in a ticket
2. Verify other moderators are removed
3. Click "Release" to return it to queue
4. Click "Close" to close the ticket

## Common Issues

**"Missing Permissions" for Verify User**
- Solution: Bot role must be ABOVE Verified role in Server Settings → Roles

**Can't Create Private Threads**
- Server needs Level 2 boost
- Bot needs "Create Private Threads" permission

**Bot Doesn't Respond**
- Check bot is online
- Verify token in config.js is correct

**Tickets Not Saving**
- Check console for errors
- Ensure bot has write permissions in its folder

## Quick Reference

### Commands
- `!setup-tickets` - Initialize panel (Admin only)
- `!add <user>` - Add user to ticket (Moderators, in tickets only)

### Ticket Reasons
- Verification (Level 5+)
- Behavior/Rules Violation
- Role Correction
- Consent Verification (Level 5+)
- General Support

### Moderator Actions
- 🟢 **Claim** - Take ownership of ticket
- 🔓 **Release** - Return to queue
- 🔴 **Close** - Archive ticket
- ✅ **Verify User** - Add verified role (verification only)

## You're Done! 🎉

Users can now create tickets, and moderators can manage them efficiently. For more details, see README.md.

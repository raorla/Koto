# Koto

**Your personal AI agent on Telegram. It understands what you're working on and what matters to you, and helps you move forward every day.**

![Tests](https://img.shields.io/badge/tests-285%20passing-2ea44f?style=flat-square)
![Claude](https://img.shields.io/badge/Claude-agent%20loop-D97757?style=flat-square&logo=claude&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-Gmail%20%26%20Calendar-111?style=flat-square&logo=modelcontextprotocol&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram-bot%20%2B%20mini%20app-26A5E4?style=flat-square&logo=telegram&logoColor=white)

> 🇫🇷 The full documentation (setup, every command, costs, 24/7 deployment) is in French: [README.fr.md](./README.fr.md).

Koto has no app of its own: you talk to it on Telegram, like you would to someone you trust.

---

## What it does

| | |
|---|---|
| 🧠 **Memory** | Remembers your projects and where they stand, your priorities, the people who matter and your preferences. You review it with `/memoire` and correct it by just talking. |
| 🔎 **Long-term recall** | Past conversations, photos and PDFs come back months later (*"what did Rado say about the quote?"*), and it can reopen a document to reread a clause. It tidies its memory from time to time, merging duplicates and archiving stale facts, never deleting. |
| ☀️ **Morning brief** | The 1 to 3 things that matter today, weather, calendar, emails that need action, reminders, news on the topics you follow, as text or voice. |
| ⏰ **Reminders & follow-ups** | *"Remind me to call Rado tomorrow at 10"*, recurring reminders, and check-ins after an event you mentioned. |
| 📅📧 **Calendar & Gmail** | Reads your agenda, finds slots, triages and drafts emails, through MCP. |
| ✅ **Nothing goes out without you** | Sending an email or changing an event shows a **✅ Confirm / ❌ Cancel** card first. |
| 🌐 **Web tasks** | Opens a real browser in the background to search, compare and fill forms. Before any payment, booking or submission it shows a screenshot and waits for your ✅. Passwords are filled by 1Password, never seen by the model. |
| 🎯 **Missions** | Background jobs that run for days (*"watch this flight and tell me if it drops under 600 €"*) and only message you with a result. |
| 🎙️📞 **Voice & live calls** | Send a voice note and get a voice reply, or call Koto live inside Telegram, with no phone number. |
| 🫂 **Groups** | Add it to a Telegram group: shared memory, reminders and lists, and nothing anyone said in private ever leaks into the group. |
| 👥 **Multi-user** | Invite-only sign-up, data isolated per person, a daily API budget per user, full export and erase. |

## How it works

```
src/
├── agent/        Claude agent loop: tools, pause, refusals, cost per call
├── bot/          grammY: access, commands, photos and PDFs, groups
├── memory/       long-term recall: SQLite FTS5 search, document cards, memory tidy-up
├── missions/     background missions run as sub-agents by the scheduler
├── integrations/ Gmail and Google Calendar through an MCP client
├── call/         live calls: Telegram mini app, server, signature checks
├── scheduler.ts  reminders, follow-ups, briefs, missions (every 20 s)
└── db.ts         SQLite, every query filtered by user_id
```

For each message: grammY receives it, Koto checks the sender's rate limit and budget, then calls Claude with three blocks (a frozen system prompt shared by everyone, the person's context, the recent history). Claude calls tools (`remember`, `schedule`, `web_search`…) until it has its answer, and the turn and its cost are recorded.

### Engineering choices

- **Prompt caching across users:** the system prompt and tools are identical for everyone and form a shared cached prefix. A cached read costs 0.20 $ per million tokens instead of 4 $.
- **Cache-friendly history:** messages are only appended during a turn and trimmed in steps (60 messages or 60,000 characters), so the prefix stays stable. The long term is the memory, and the full history stays searchable for free with FTS5.
- **Real costs, hard budgets:** every call is priced from the usage the API returns, then charged to the person's daily budget (0.50 $ by default). A simple message costs 0.0005 to 0.002 $.
- **Privacy by design:** logs hold ids, statuses and costs, never messages or memories. An id supplied by the model can never reach another user's data. Obvious secrets (passwords, card numbers) are refused in memory.
- **Free sources first:** weather (MET Norway), places (OpenStreetMap), RSS and CoinGecko cost nothing and never go through the model.

## Tests

`npm test` runs three levels with no network and no real key, in about ten seconds:

| Level | What is tested |
|---|---|
| **Unit** | Every tool, memory, groups, missions, voice, export, browser guards. External services are mocked. |
| **Integration** | Real pieces together: agent loop with SQLite, grammY bot, scheduler, the web sub-agent and the call page in a real Chrome. |
| **System** | The real Koto process against a fake Telegram and a fake OpenRouter, playing a full journey: invitations, voice, reminders, brief, groups, missions, long-term memory, live call, export, budget, clean shutdown. |
| **Live** | `npm run test:live`, by hand: the real services with real keys, for about 0.01 $. |

## Quick start

Node 22.13+, a Telegram bot token and an OpenRouter or Anthropic key.

```bash
cp .env.example .env      # set TELEGRAM_BOT_TOKEN and OPENROUTER_API_KEY or ANTHROPIC_API_KEY
npm install
npm run doctor            # checks the setup without printing secrets, for free
npm run dev
```

Then write to your bot, add your Telegram id to `ADMIN_TELEGRAM_IDS` and invite people with `/inviter`. Step-by-step setup and 24/7 deployment are in [README.fr.md](./README.fr.md).

## License

Copyright © 2026 Orlando R. All rights reserved. The source is published for review only, see [LICENSE](./LICENSE).

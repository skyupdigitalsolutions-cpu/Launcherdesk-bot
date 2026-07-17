# LauncherDesk WhatsApp Bot

Complete WhatsApp automation for LauncherDesk — built on MSG91, MongoDB, and Google Sheets.

---

## Project Structure

```
launcherdesk-bot/
├── src/
│   ├── index.js                  ← Express server + webhook endpoint
│   ├── config/
│   │   └── categories.js         ← All 7 service categories (edit copy here)
│   ├── handlers/
│   │   ├── parser.js             ← MSG91 inbound payload normaliser
│   │   ├── messages.js           ← All outbound message builders
│   │   └── stateMachine.js       ← Core bot logic (all states)
│   ├── models/
│   │   ├── Session.js            ← MongoDB session schema
│   │   └── Lead.js               ← MongoDB lead schema
│   └── services/
│       ├── msg91.js              ← MSG91 WhatsApp API calls
│       └── sheets.js             ← Google Sheets integration
├── .env.example                  ← Copy to .env and fill values
├── render.yaml                   ← Render.com deploy config
└── package.json
```

---

## Conversation Flow

```
Marketing Template (Meta-approved)
  ↓ "Explore Services" tapped
Interactive List Menu (8 categories + Talk to Expert)
  ↓ Category selected
Category Detail + buttons [Need This Service] [Back to Menu]
  ↓ "Need This Service" tapped
Lead Capture:
  1. Name (text input)
  2. Email (validated)
  3. Business name (text or "Not registered yet" button)
  4. City (text input)
  ↓ Confirmation shown
  ↓ "Confirm & Submit" tapped
Lead saved → MongoDB + Google Sheets
Sales team notified via WhatsApp (utility template)
```

---

## Setup Guide

### 1. Clone and install

```bash
git clone <your-repo>
cd launcherdesk-bot
npm install
cp .env.example .env
```

### 2. Fill in .env

| Variable | Where to get it |
|---|---|
| `MONGO_URI` | MongoDB Atlas → Connect → Driver |
| `MSG91_AUTH_KEY` | MSG91 → API Keys |
| `MSG91_WHATSAPP_NUMBER` | MSG91 → WhatsApp → Phone numbers |
| `TEMPLATE_ID_SALES_ALERT` | MSG91 → Templates → ID column |
| `SALES_WA_NUMBER` | Sales person's WhatsApp (91XXXXXXXXXX) |
| `GOOGLE_SHEET_ID` | From the Sheet URL: `/d/THIS_PART/edit` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Google Cloud → IAM → Service Accounts |
| `GOOGLE_PRIVATE_KEY` | Service account JSON → private_key field |
| `ADMIN_SECRET` | Make up a strong random string |

### 3. Google Sheets setup

1. Create a new Google Sheet
2. Rename the first tab to **Leads**
3. Add these headers in Row 1:
   `Name | Phone | Email | Business | City | Service | Source | Status | Date`
4. Create a Service Account in Google Cloud Console
5. Share the Sheet with the service account email (Editor access)
6. Copy the private key JSON values into .env

### 4. MSG91 Inbound Webhook

1. Go to MSG91 → WhatsApp → Settings
2. Set Inbound Webhook URL to:
   `https://your-render-url.onrender.com/webhook/whatsapp`
3. Save

### 5. Deploy to Render

1. Push code to GitHub
2. Create a new Web Service on Render → connect GitHub repo
3. Add all .env variables in Render dashboard → Environment
4. Deploy

### 6. Prevent cold starts on Render free tier

Add an uptime monitor (UptimeRobot free) pinging:
`https://your-render-url.onrender.com/`
Every 5 minutes — keeps the server warm so WhatsApp responses are instant.

---

## Admin Endpoints

### Resume bot after human takeover
```bash
POST /admin/resume
{ "phone": "919XXXXXXXXX", "secret": "your_admin_secret" }
```

### View recent leads
```bash
GET /admin/leads?secret=your_admin_secret
```

---

## Testing Without Approved Template

1. Send any WhatsApp message FROM the client's registered WABA number TO your test number
2. This opens a 24-hour session window
3. Your test number can now receive list/button messages
4. Test the full flow end to end

---

## Adding a New Service Category

1. Open `src/config/categories.js`
2. Add a new key to the `CATEGORIES` object with `label`, `title`, `body`
3. Add a new row to `MENU_ROWS`
4. That's it — no other files to touch

---

## Templates Required (Meta approval)

| Template | Type | Purpose |
|---|---|---|
| `launcherdesk_intro` | Marketing | First outreach blast (already submitted ✅) |
| `launcherdesk_lead_alert` | Utility | Sales team notification |
| `launcherdesk_followup` _(optional)_ | Utility | Re-engage abandoned leads after 24h |

All other messages are session messages — no approval needed.

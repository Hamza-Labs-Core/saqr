# Story 23: Email & Notification System

## Overview

The platform has push notification support in the mobile app (expo-notifications) and desktop app (native OS notifications), but there's no **email notification system** and no **user notification preferences**. Users can't control which events trigger notifications or receive important alerts via email when they're not using the app.

This story builds a unified notification system that spans email, push, and in-app channels with per-user preferences. It also adds the transactional email infrastructure needed by Story 20 (Auth) for verification and password reset emails.

**Architecture**: A notification service in the sync server (Cloudflare Worker) accepts notification requests, checks user preferences, and routes to the appropriate channel (email via Resend, push via Expo Push API, in-app via WebSocket). Preferences are stored in the user's KV record.

**Guiding principle**: Notifications should be helpful, not spammy. Default to conservative settings. Let users control everything. Never send marketing emails — only transactional and event-driven notifications.

---

## Scope

### In Scope

- Notification preferences system (per-user, per-channel, per-event-type)
- Email delivery via Resend API (transactional emails)
- Push notification routing via Expo Push API
- In-app notifications via existing WebSocket connections
- Notification templates for all event types
- Do-Not-Disturb scheduling (quiet hours)
- Notification history (last 30 days, stored in DO SQLite)
- Unread count badge for mobile/desktop apps
- Email templates: HTML + plaintext, responsive design
- Preference management API

### Out of Scope

- SMS notifications (future)
- Slack/Discord integrations (future)
- Marketing emails / newsletters
- Notification grouping / digest (future — send individual for now)
- Custom notification sounds

---

## Requirements

### 1. Notification Event Types

| Event | Default Channels | Description |
|-------|-----------------|-------------|
| `agent.finished` | push, in-app | Agent completed its task |
| `agent.error` | push, email, in-app | Agent encountered an error |
| `agent.permission` | push, in-app | Agent needs permission approval |
| `agent.idle` | in-app | Agent waiting for input (no prompt in 5 min) |
| `sync.conflict` | email, in-app | Sync conflict detected between machines |
| `security.new_login` | email | Login from new device/location |
| `security.password_changed` | email | Password was changed |
| `security.lockout` | email | Account locked after failed attempts |
| `billing.trial_ending` | email, in-app | Trial ends in 3 days |
| `billing.payment_failed` | email, in-app | Payment failed, action needed |
| `billing.downgraded` | email, in-app | Subscription canceled, now on free tier |

### 2. Preference API

```
GET /api/notifications/preferences
  Auth: JWT required
  Response: 200 {
    channels: {
      email: true,
      push: true,
      inApp: true
    },
    events: {
      "agent.finished": { email: false, push: true, inApp: true },
      "agent.error": { email: true, push: true, inApp: true },
      "agent.permission": { email: false, push: true, inApp: true },
      ...per-event overrides
    },
    quietHours: {
      enabled: false,
      start: "22:00",
      end: "08:00",
      timezone: "America/New_York"
    },
    pushTokens: [
      { token: "ExponentPushToken[...]", device: "iPhone 16", addedAt: "..." }
    ]
  }

PUT /api/notifications/preferences
  Auth: JWT required
  Body: { ...partial preferences to merge }
  Response: 200 { ...updated preferences }

POST /api/notifications/push-token
  Auth: JWT required
  Body: { token: "ExponentPushToken[...]", device: "iPhone 16" }
  Response: 201

DELETE /api/notifications/push-token/:token
  Auth: JWT required
  Response: 200
```

### 3. Notification Dispatch

```typescript
// notification-service.ts
async function notify(userId: string, event: NotificationEvent): Promise<void> {
  const prefs = await getPreferences(userId);

  // Check quiet hours
  if (isQuietHours(prefs)) {
    // Queue for later (store in DO, alarm to send at end of quiet hours)
    await queueNotification(userId, event);
    return;
  }

  // Check per-event channel preferences
  const channels = getChannelsForEvent(prefs, event.type);

  // Dispatch to each enabled channel
  await Promise.allSettled([
    channels.email && sendEmail(userId, event),
    channels.push && sendPush(userId, event),
    channels.inApp && sendInApp(userId, event),
  ]);

  // Store in notification history
  await storeNotification(userId, event, channels);
}
```

### 4. Email Templates

All emails use responsive HTML with plaintext fallback.

#### Common Structure
```html
<!-- Header: Saqr logo + event icon -->
<!-- Body: event-specific content -->
<!-- Footer: "Manage notifications" link + unsubscribe from this type -->
```

#### Template: Agent Error
```
Subject: ⚠️ Agent error on {machineName}

Your agent "{agentName}" encountered an error while working on {projectName}.

Error: {errorMessage}

[View Agent →] [Restart Agent →]

---
Machine: {machineName}
Model: {modelName}
Session duration: {duration}
```

#### Template: Permission Request
```
Subject: 🔐 Agent needs permission on {machineName}

Your agent "{agentName}" is requesting permission to:

Tool: {toolName}
File: {filePath}
Action: {description}

[Approve →] [Deny →] [Open in App →]

Note: This approval link expires in 1 hour.
```

#### Template: Trial Ending
```
Subject: Your Saqr Pro trial ends in 3 days

Your 14-day free trial of Saqr Pro ends on {endDate}.

What you'll lose on the free plan:
- Machine limit drops from 5 to 2
- Storage drops from 1GB to 50MB
- Real-time sync → polling only

[Keep Pro ($5/mo) →] [Compare Plans →]
```

### 5. Push Notification Routing

Use Expo Push API for mobile notifications:

```typescript
// push-service.ts
async function sendPush(userId: string, event: NotificationEvent): Promise<void> {
  const prefs = await getPreferences(userId);
  const tokens = prefs.pushTokens.map(t => t.token);

  if (tokens.length === 0) return;

  const messages = tokens.map(token => ({
    to: token,
    title: getTitleForEvent(event),
    body: getBodyForEvent(event),
    data: { eventType: event.type, agentId: event.agentId },
    sound: 'default',
    badge: 1,
    categoryId: event.type,  // iOS action categories
  }));

  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(messages),
  });
}
```

### 6. Notification History

Stored in the user's Durable Object SQLite:

```sql
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data TEXT,  -- JSON
  channels TEXT NOT NULL,  -- JSON array: ["email", "push"]
  read INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
```

#### API
```
GET /api/notifications
  Auth: JWT required
  Query: ?limit=20&offset=0&unreadOnly=false
  Response: 200 { notifications: [...], unreadCount: 5, total: 42 }

PUT /api/notifications/:id/read
  Auth: JWT required
  Response: 200

PUT /api/notifications/read-all
  Auth: JWT required
  Response: 200
```

### 7. Quiet Hours

- User sets start/end time + timezone
- During quiet hours: notifications queued in DO
- At end of quiet hours: DO alarm fires, sends queued notifications as batch
- Exception: `security.*` events always sent immediately (bypass quiet hours)

---

## Test Cases

### Preferences
- TC23.1: Default preferences include all channels enabled
- TC23.2: Update per-event preference overrides channel for that event
- TC23.3: Disable email channel stops all email notifications
- TC23.4: Register push token stores it with device name
- TC23.5: Remove push token removes it from preferences

### Email Dispatch
- TC23.6: Agent error sends email with correct template
- TC23.7: Permission request email includes approve/deny links
- TC23.8: Email disabled for event type → no email sent
- TC23.9: Email template renders HTML and plaintext versions
- TC23.10: Trial ending email sent 3 days before expiry

### Push Dispatch
- TC23.11: Agent permission sends push with correct title/body
- TC23.12: Multiple push tokens → message sent to all devices
- TC23.13: Invalid push token removed from preferences on failure
- TC23.14: Push disabled for event type → no push sent

### In-App Notifications
- TC23.15: In-app notification sent via existing WebSocket
- TC23.16: Unread count increments on new notification
- TC23.17: Mark as read decrements unread count
- TC23.18: Mark all as read sets count to 0

### Quiet Hours
- TC23.19: Notification during quiet hours is queued
- TC23.20: Queued notification sent when quiet hours end
- TC23.21: Security events bypass quiet hours
- TC23.22: Quiet hours respect timezone correctly

### Notification History
- TC23.23: Notifications stored with correct fields
- TC23.24: History query with limit/offset works
- TC23.25: unreadOnly filter returns only unread
- TC23.26: History auto-deletes after 30 days

---

## Dependencies

- Story 11 (Sync Server): Durable Objects, WebSocket infrastructure
- Story 20 (Auth): email infrastructure shared (Resend)
- Story 16 (Mobile): expo-notifications for push tokens
- Story 17 (Desktop): native notification integration
- Resend API key (shared with Story 20)
- Expo Push API (no key needed for sending)

## Acceptance Criteria

- [ ] Users can configure notification preferences per event type and channel
- [ ] Email notifications sent via Resend with HTML + plaintext templates
- [ ] Push notifications routed via Expo Push API to registered devices
- [ ] In-app notifications delivered via WebSocket
- [ ] Quiet hours queue notifications and release after window
- [ ] Security notifications bypass quiet hours
- [ ] Notification history stored for 30 days with read/unread tracking
- [ ] 25+ unit tests passing

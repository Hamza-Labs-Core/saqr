# Implementation Plan: Story 23 -- Email & Notification System

**Date**: 2026-02-25
**Story**: 23-email-notifications
**Status**: Planning
**Estimated Total Effort**: ~10 days (40-50 hours)
**Prerequisites**: Story 11 (Sync Server) implemented -- Durable Objects, Worker routing, JWT auth. Story 16 (Mobile) implemented -- expo-notifications push token registration. Resend API key provisioned.
**Architecture**: Extends the existing sync-server Cloudflare Worker + UserSyncDO with notification services. Email via Resend API, push via Expo Push API, in-app via WebSocket broadcast. Preferences and history stored in DO SQLite alongside existing user data.

### Relationship to Other Stories

- **Story 11** (Sync Server): Provides the Worker gateway, UserSyncDO, JWT auth, and DO SQLite infrastructure that this story extends. All notification routes are added to the existing worker and DO.
- **Story 16** (Mobile App): Consumes push notifications via expo-notifications. Push tokens registered via the preference API defined here.
- **Story 17** (Desktop App): Consumes native OS notifications triggered by in-app WebSocket events delivered by this story.
- **Story 20** (Auth): Shares the Resend email infrastructure. Security event notifications (`security.new_login`, `security.password_changed`, `security.lockout`) are triggered by auth flows.

### Key Design Decisions

1. **Preferences in DO SQLite** -- not KV. The story mentions KV, but preferences are relational (per-event-type channel overrides) and read/written alongside notification history in the same DO. SQLite is the right home. A single `notification_preferences` row stores the full JSON blob; `push_tokens` gets its own table for token CRUD.
2. **Security events bypass quiet hours** -- `security.*` events are always dispatched immediately regardless of quiet hours settings. This is a safety invariant.
3. **30-day auto-cleanup** -- Notification history rows older than 30 days are deleted by the existing DO alarm handler, extended with a new cleanup step.
4. **Templates via string interpolation** -- No template engine dependency. Each template is a pure function `(data) => { subject, html, text }` using tagged template literals. This keeps the Worker bundle small and avoids runtime eval.
5. **Resend API** -- Single external HTTP call per email. No SDK dependency -- raw `fetch()` to `https://api.resend.com/emails`. The `RESEND_API_KEY` env binding is added to `Env`.
6. **Expo Push API** -- Batch send via `https://exp.host/--/api/v2/push/send`. No SDK. Failed tokens (DeviceNotRegistered) are auto-removed from preferences.
7. **DO alarm for quiet hours queue** -- When a notification arrives during quiet hours, it is written to a `notification_queue` SQLite table and a DO alarm is set for the end of the quiet window. The alarm handler drains the queue.

---

## Task Dependency Graph

```
Task 1: Notification Types & Preferences Schema (DO SQLite)
  |
  +---> Task 2: Notification Preferences API
  |       |
  |       +---> Task 5: Notification Dispatch Service (channel routing + quiet hours)
  |       |       |
  |       |       +---> Task 3: Email Service (Resend API + templates)
  |       |       |
  |       |       +---> Task 4: Push Service (Expo Push API)
  |       |       |
  |       |       +---> Task 7: In-App Notifications (WebSocket broadcast + history API)
  |       |       |
  |       |       +---> Task 6: DO Alarm Queuing for Quiet Hours
  |       |
  |       +---> Task 8: Worker Route Integration
  |
  +---> Task 9: Tests (30+ test cases)
```

---

## Tasks

### Task 1: Notification Types & Preferences Schema (DO SQLite)

**Description**

Define all TypeScript types for the notification system and extend the UserSyncDO SQLite schema with tables for notification preferences, push tokens, notification history, and the quiet-hours queue.

**Prerequisites/Inputs**

- Existing `UserSyncDO.initSchema()` in `/home/meywd/Saqr/packages/sync-server/src/durable-objects/user-sync.ts`
- Existing `types.ts` at `/home/meywd/Saqr/packages/sync-server/src/types.ts`
- Mobile notification types at `/home/meywd/Saqr/packages/mobile/src/types/notification.ts` (reference for alignment)

**Implementation Details**

**File: `packages/sync-server/src/notifications/types.ts`**

```typescript
// ---------------------------------------------------------------------------
// Notification Event Types
// ---------------------------------------------------------------------------

export type NotificationEventType =
  | 'agent.finished'
  | 'agent.error'
  | 'agent.permission'
  | 'agent.idle'
  | 'sync.conflict'
  | 'security.new_login'
  | 'security.password_changed'
  | 'security.lockout'
  | 'billing.trial_ending'
  | 'billing.payment_failed'
  | 'billing.downgraded';

export type NotificationChannel = 'email' | 'push' | 'inApp';

// ---------------------------------------------------------------------------
// Notification Event Payload
// ---------------------------------------------------------------------------

export interface NotificationEvent {
  type: NotificationEventType;
  title: string;
  body: string;
  data?: Record<string, string>;
  /** ISO 8601 timestamp */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Default Channel Mapping
// ---------------------------------------------------------------------------

export const DEFAULT_CHANNELS: Record<NotificationEventType, NotificationChannel[]> = {
  'agent.finished':             ['push', 'inApp'],
  'agent.error':                ['push', 'email', 'inApp'],
  'agent.permission':           ['push', 'inApp'],
  'agent.idle':                 ['inApp'],
  'sync.conflict':              ['email', 'inApp'],
  'security.new_login':         ['email'],
  'security.password_changed':  ['email'],
  'security.lockout':           ['email'],
  'billing.trial_ending':       ['email', 'inApp'],
  'billing.payment_failed':     ['email', 'inApp'],
  'billing.downgraded':         ['email', 'inApp'],
};

/** Event types that bypass quiet hours. */
export const SECURITY_EVENT_TYPES: NotificationEventType[] = [
  'security.new_login',
  'security.password_changed',
  'security.lockout',
];

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export interface ChannelToggles {
  email: boolean;
  push: boolean;
  inApp: boolean;
}

export interface EventChannelOverrides {
  [eventType: string]: Partial<ChannelToggles>;
}

export interface QuietHoursConfig {
  enabled: boolean;
  /** "HH:MM" 24-hour format */
  start: string;
  /** "HH:MM" 24-hour format */
  end: string;
  /** IANA timezone, e.g. "America/New_York" */
  timezone: string;
}

export interface PushToken {
  token: string;
  device: string;
  addedAt: string;
}

export interface NotificationPreferences {
  channels: ChannelToggles;
  events: EventChannelOverrides;
  quietHours: QuietHoursConfig;
  pushTokens: PushToken[];
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  channels: { email: true, push: true, inApp: true },
  events: {},
  quietHours: {
    enabled: false,
    start: '22:00',
    end: '08:00',
    timezone: 'UTC',
  },
  pushTokens: [],
};

// ---------------------------------------------------------------------------
// Notification History Row
// ---------------------------------------------------------------------------

export interface NotificationRow {
  id: string;
  event_type: string;
  title: string;
  body: string;
  data: string | null;      // JSON
  channels: string;          // JSON array
  read: number;              // 0 or 1
  created_at: string;        // ISO 8601
}

// ---------------------------------------------------------------------------
// Notification Queue Row (quiet hours)
// ---------------------------------------------------------------------------

export interface NotificationQueueRow {
  id: string;
  event_type: string;
  payload: string;           // JSON-serialized NotificationEvent
  queued_at: string;         // ISO 8601
}
```

**Schema additions in `UserSyncDO.initSchema()`:**

Add the following tables to the existing `initSchema()` method:

```sql
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id    TEXT PRIMARY KEY,
  prefs_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS push_tokens (
  token      TEXT PRIMARY KEY,
  device     TEXT NOT NULL,
  added_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  data        TEXT,
  channels    TEXT NOT NULL,
  read        INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_created
  ON notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(read, created_at);

CREATE TABLE IF NOT EXISTS notification_queue (
  id          TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  queued_at   TEXT NOT NULL
);
```

**Acceptance Criteria**

- [ ] All TypeScript types compile without errors
- [ ] `NotificationEventType` includes all 11 event types from the story
- [ ] `DEFAULT_CHANNELS` maps each event type to its default channels per the requirements table
- [ ] `SECURITY_EVENT_TYPES` lists all three `security.*` types
- [ ] `DEFAULT_PREFERENCES` has all channels enabled and quiet hours disabled
- [ ] Four new SQLite tables created in `initSchema()`: `notification_preferences`, `push_tokens`, `notifications`, `notification_queue`
- [ ] Indexes exist on `notifications(created_at)` and `notifications(read, created_at)`
- [ ] Types align with existing mobile `NotificationType` naming where applicable

**Edge Cases**

- `initSchema()` uses `CREATE TABLE IF NOT EXISTS` -- safe for existing DOs that already have the account/machines/events tables.
- `prefs_json` column stores the full preferences JSON blob. Max realistic size is ~2KB; well within SQLite row limits.

**Estimated Effort**: S (Small) -- ~3 hours

---

### Task 2: Notification Preferences API

**Description**

Implement CRUD handlers for notification preferences, push token management, and wire them into the UserSyncDO fetch router. Preferences are stored as a JSON blob in `notification_preferences`; push tokens are stored in a separate `push_tokens` table for individual add/remove operations.

**Prerequisites/Inputs**

- Task 1 (types and schema)
- Existing DO routing pattern in `UserSyncDO.fetch()`

**Implementation Details**

**File: `packages/sync-server/src/notifications/preferences.ts`**

```typescript
import type { NotificationPreferences, PushToken } from './types.js';
import { DEFAULT_PREFERENCES } from './types.js';

/**
 * Load preferences from DO SQLite.
 * Returns DEFAULT_PREFERENCES merged with any stored overrides.
 */
export function loadPreferences(sql: SqlStorage, userId: string): NotificationPreferences {
  const row = sql.exec(
    'SELECT prefs_json FROM notification_preferences WHERE user_id = ?',
    userId,
  ).toArray()[0] as { prefs_json: string } | undefined;

  const tokens = sql.exec('SELECT token, device, added_at FROM push_tokens').toArray() as PushToken[];

  const base = { ...DEFAULT_PREFERENCES };
  if (row) {
    const stored = JSON.parse(row.prefs_json);
    Object.assign(base, stored);
  }
  base.pushTokens = tokens.map(t => ({
    token: t.token,
    device: t.device,
    addedAt: t.added_at,
  }));

  return base;
}

/**
 * Save preferences (channels, events, quietHours -- not pushTokens).
 * pushTokens are managed via addPushToken / removePushToken.
 */
export function savePreferences(
  sql: SqlStorage,
  userId: string,
  prefs: Partial<NotificationPreferences>,
): void {
  // Strip pushTokens -- they have their own table
  const { pushTokens, ...toStore } = prefs;
  const json = JSON.stringify(toStore);

  sql.exec(
    `INSERT INTO notification_preferences (user_id, prefs_json)
     VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET prefs_json = ?`,
    userId, json, json,
  );
}

export function addPushToken(sql: SqlStorage, token: string, device: string): void {
  const now = new Date().toISOString();
  sql.exec(
    `INSERT INTO push_tokens (token, device, added_at)
     VALUES (?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET device = ?, added_at = ?`,
    token, device, now, device, now,
  );
}

export function removePushToken(sql: SqlStorage, token: string): boolean {
  const before = sql.exec('SELECT token FROM push_tokens WHERE token = ?', token).toArray();
  if (before.length === 0) return false;
  sql.exec('DELETE FROM push_tokens WHERE token = ?', token);
  return true;
}
```

**DO route handlers (added to `UserSyncDO`):**

```typescript
// GET /api/notifications/preferences
private handleGetPreferences(authCtx: AuthContext): Response {
  const prefs = loadPreferences(this.sql, authCtx.userId);
  return jsonResponse(200, prefs);
}

// PUT /api/notifications/preferences
private async handleUpdatePreferences(request: Request, authCtx: AuthContext): Promise<Response> {
  const body = await request.json() as Partial<NotificationPreferences>;
  // Validate quietHours if provided
  if (body.quietHours) {
    if (body.quietHours.start && !/^\d{2}:\d{2}$/.test(body.quietHours.start)) {
      return errorResponse(400, 'invalid_time', 'start must be HH:MM format');
    }
    if (body.quietHours.end && !/^\d{2}:\d{2}$/.test(body.quietHours.end)) {
      return errorResponse(400, 'invalid_time', 'end must be HH:MM format');
    }
  }
  // Merge with existing
  const existing = loadPreferences(this.sql, authCtx.userId);
  const merged = {
    channels: { ...existing.channels, ...(body.channels || {}) },
    events: { ...existing.events, ...(body.events || {}) },
    quietHours: { ...existing.quietHours, ...(body.quietHours || {}) },
  };
  savePreferences(this.sql, authCtx.userId, merged);
  const updated = loadPreferences(this.sql, authCtx.userId);
  return jsonResponse(200, updated);
}

// POST /api/notifications/push-token
private async handleAddPushToken(request: Request): Promise<Response> {
  const body = await request.json() as { token: string; device: string };
  if (!body.token || !body.device) {
    return errorResponse(400, 'missing_fields', 'token and device are required');
  }
  if (!body.token.startsWith('ExponentPushToken[')) {
    return errorResponse(400, 'invalid_token', 'Token must be a valid Expo push token');
  }
  addPushToken(this.sql, body.token, body.device);
  return jsonResponse(201, { ok: true });
}

// DELETE /api/notifications/push-token/:token
private handleRemovePushToken(token: string): Response {
  const removed = removePushToken(this.sql, decodeURIComponent(token));
  if (!removed) return errorResponse(404, 'not_found', 'Push token not found');
  return jsonResponse(200, { ok: true });
}
```

**Acceptance Criteria**

- [ ] `GET /api/notifications/preferences` returns full preferences with default channels and empty event overrides for new users
- [ ] `PUT /api/notifications/preferences` merges partial updates into existing preferences
- [ ] `PUT` with invalid `quietHours.start` format returns 400
- [ ] `POST /api/notifications/push-token` stores token and device name
- [ ] `POST` with non-ExponentPushToken prefix returns 400
- [ ] `DELETE /api/notifications/push-token/:token` removes the token
- [ ] `DELETE` with unknown token returns 404
- [ ] Push tokens appear in `GET /api/notifications/preferences` response under `pushTokens`

**Edge Cases**

- URL-encoded push token in DELETE path (tokens contain `[` and `]`) -- use `decodeURIComponent`.
- Duplicate push token registration updates device name and timestamp rather than creating a duplicate (UPSERT).
- Empty `events` override object is valid -- means "use all defaults".

**Estimated Effort**: M (Medium) -- ~5 hours

---

### Task 3: Email Service (Resend API + HTML/Plaintext Templates)

**Description**

Implement the email delivery service using Resend's REST API. Build HTML + plaintext templates for all notification event types using pure string interpolation (no template engine). Each template is a function that returns `{ subject, html, text }`.

**Prerequisites/Inputs**

- Task 1 (notification types)
- `RESEND_API_KEY` env binding (added to `Env` interface)
- `RESEND_FROM_EMAIL` env binding (e.g., `"Saqr <notifications@saqr.dev>"`)

**Implementation Details**

**File: `packages/sync-server/src/notifications/email-service.ts`**

```typescript
import type { Env } from '../types.js';
import type { NotificationEvent } from './types.js';
import { renderTemplate } from './email-templates.js';

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send a transactional email via Resend API.
 */
export async function sendEmail(
  env: Env,
  toEmail: string,
  event: NotificationEvent,
): Promise<EmailResult> {
  const template = renderTemplate(event);
  if (!template) {
    return { success: false, error: `No template for event type: ${event.type}` };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [toEmail],
      subject: template.subject,
      html: template.html,
      text: template.text,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    return { success: false, error: `Resend API ${response.status}: ${errBody}` };
  }

  const result = await response.json() as { id: string };
  return { success: true, messageId: result.id };
}
```

**File: `packages/sync-server/src/notifications/email-templates.ts`**

Each template function receives `NotificationEvent.data` and returns `{ subject, html, text }`.

```typescript
import type { NotificationEvent } from './types.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Render email template for a notification event.
 * Returns null if the event type has no email template.
 */
export function renderTemplate(event: NotificationEvent): RenderedEmail | null {
  const renderer = TEMPLATES[event.type];
  if (!renderer) return null;
  return renderer(event);
}

/** Escape HTML special characters to prevent XSS in email templates. */
function esc(str: string | undefined): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wrap body content in the standard email layout. */
function wrapHtml(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         margin: 0; padding: 0; background: #f5f5f5; color: #1a1a1a; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px;
               overflow: hidden; }
  .header { background: #0f172a; color: #fff; padding: 24px; text-align: center; }
  .header h1 { margin: 0; font-size: 20px; }
  .body { padding: 24px; line-height: 1.6; }
  .footer { padding: 16px 24px; font-size: 12px; color: #666; border-top: 1px solid #eee;
            text-align: center; }
  .btn { display: inline-block; padding: 10px 20px; background: #2563eb; color: #fff;
         text-decoration: none; border-radius: 6px; font-weight: 600; margin: 4px; }
  .meta { margin-top: 16px; padding: 12px; background: #f8fafc; border-radius: 4px;
          font-size: 13px; color: #475569; }
</style>
</head>
<body>
<div class="container">
  <div class="header"><h1>Saqr</h1></div>
  <div class="body">${body}</div>
  <div class="footer">
    <a href="https://app.saqr.dev/settings/notifications">Manage notification preferences</a>
  </div>
</div>
</body>
</html>`;
}

type TemplateRenderer = (event: NotificationEvent) => RenderedEmail;

const TEMPLATES: Record<string, TemplateRenderer> = {
  'agent.error': (event) => {
    const d = event.data || {};
    return {
      subject: `Agent error on ${d.machineName || 'unknown machine'}`,
      html: wrapHtml(`
        <p>Your agent "<strong>${esc(d.agentName)}</strong>" encountered an error while working on <strong>${esc(d.projectName)}</strong>.</p>
        <p><strong>Error:</strong> ${esc(d.errorMessage)}</p>
        <div class="meta">
          Machine: ${esc(d.machineName)}<br>
          Model: ${esc(d.modelName)}<br>
          Session duration: ${esc(d.duration)}
        </div>
      `),
      text: `Agent error on ${d.machineName || 'unknown machine'}

Your agent "${d.agentName}" encountered an error while working on ${d.projectName}.

Error: ${d.errorMessage}

Machine: ${d.machineName}
Model: ${d.modelName}
Session duration: ${d.duration}`,
    };
  },

  'agent.permission': (event) => {
    const d = event.data || {};
    return {
      subject: `Agent needs permission on ${d.machineName || 'unknown machine'}`,
      html: wrapHtml(`
        <p>Your agent "<strong>${esc(d.agentName)}</strong>" is requesting permission to:</p>
        <div class="meta">
          Tool: ${esc(d.toolName)}<br>
          File: ${esc(d.filePath)}<br>
          Action: ${esc(d.description)}
        </div>
        <p style="margin-top:16px">
          <a class="btn" href="${esc(d.approveUrl)}">Approve</a>
          <a class="btn" style="background:#dc2626" href="${esc(d.denyUrl)}">Deny</a>
        </p>
        <p style="font-size:12px;color:#666">This approval link expires in 1 hour.</p>
      `),
      text: `Agent needs permission on ${d.machineName || 'unknown machine'}

Your agent "${d.agentName}" is requesting permission to:

Tool: ${d.toolName}
File: ${d.filePath}
Action: ${d.description}

This approval link expires in 1 hour.`,
    };
  },

  'security.new_login': (event) => {
    const d = event.data || {};
    return {
      subject: 'New login to your Saqr account',
      html: wrapHtml(`
        <p>A new login was detected on your Saqr account.</p>
        <div class="meta">
          Device: ${esc(d.deviceName)}<br>
          Location: ${esc(d.location)}<br>
          IP: ${esc(d.ipAddress)}<br>
          Time: ${esc(event.timestamp)}
        </div>
        <p>If this wasn't you, <a href="https://app.saqr.dev/security">secure your account immediately</a>.</p>
      `),
      text: `New login to your Saqr account

A new login was detected on your Saqr account.

Device: ${d.deviceName}
Location: ${d.location}
IP: ${d.ipAddress}
Time: ${event.timestamp}

If this wasn't you, visit https://app.saqr.dev/security to secure your account.`,
    };
  },

  'security.password_changed': (event) => ({
    subject: 'Your Saqr password was changed',
    html: wrapHtml(`
      <p>Your Saqr account password was successfully changed.</p>
      <p>Time: ${esc(event.timestamp)}</p>
      <p>If you did not make this change, <a href="https://app.saqr.dev/security">secure your account immediately</a>.</p>
    `),
    text: `Your Saqr password was changed

Your Saqr account password was successfully changed.
Time: ${event.timestamp}

If you did not make this change, visit https://app.saqr.dev/security to secure your account.`,
  }),

  'security.lockout': (event) => {
    const d = event.data || {};
    return {
      subject: 'Your Saqr account has been locked',
      html: wrapHtml(`
        <p>Your Saqr account has been temporarily locked after multiple failed login attempts.</p>
        <div class="meta">
          Failed attempts: ${esc(d.failedAttempts)}<br>
          Last attempt IP: ${esc(d.ipAddress)}<br>
          Locked until: ${esc(d.lockedUntil)}
        </div>
        <p>If this was you, wait for the lockout to expire. If not, <a href="https://app.saqr.dev/security">reset your password</a>.</p>
      `),
      text: `Your Saqr account has been locked

Your account has been temporarily locked after ${d.failedAttempts} failed login attempts.

Last attempt IP: ${d.ipAddress}
Locked until: ${d.lockedUntil}

If this was you, wait for the lockout to expire. If not, visit https://app.saqr.dev/security to reset your password.`,
    };
  },

  'sync.conflict': (event) => {
    const d = event.data || {};
    return {
      subject: 'Sync conflict detected',
      html: wrapHtml(`
        <p>A sync conflict was detected between your machines.</p>
        <div class="meta">
          Project: ${esc(d.projectName)}<br>
          Machine A: ${esc(d.machineA)}<br>
          Machine B: ${esc(d.machineB)}<br>
          File: ${esc(d.filePath)}
        </div>
      `),
      text: `Sync conflict detected

A sync conflict was detected between your machines.

Project: ${d.projectName}
Machine A: ${d.machineA}
Machine B: ${d.machineB}
File: ${d.filePath}`,
    };
  },

  'billing.trial_ending': (event) => {
    const d = event.data || {};
    return {
      subject: 'Your Saqr Pro trial ends in 3 days',
      html: wrapHtml(`
        <p>Your 14-day free trial of Saqr Pro ends on <strong>${esc(d.endDate)}</strong>.</p>
        <p><strong>What you'll lose on the free plan:</strong></p>
        <ul>
          <li>Machine limit drops from 5 to 2</li>
          <li>Storage drops from 1GB to 50MB</li>
          <li>Real-time sync replaced with polling only</li>
        </ul>
        <p><a class="btn" href="https://app.saqr.dev/billing">Keep Pro ($5/mo)</a></p>
      `),
      text: `Your Saqr Pro trial ends in 3 days

Your 14-day free trial of Saqr Pro ends on ${d.endDate}.

What you'll lose on the free plan:
- Machine limit drops from 5 to 2
- Storage drops from 1GB to 50MB
- Real-time sync replaced with polling only

Visit https://app.saqr.dev/billing to keep your Pro plan.`,
    };
  },

  'billing.payment_failed': (event) => {
    const d = event.data || {};
    return {
      subject: 'Payment failed for your Saqr subscription',
      html: wrapHtml(`
        <p>We were unable to process your payment for Saqr Pro.</p>
        <div class="meta">
          Amount: ${esc(d.amount)}<br>
          Card ending: ${esc(d.cardLast4)}<br>
          Next retry: ${esc(d.nextRetryDate)}
        </div>
        <p><a class="btn" href="https://app.saqr.dev/billing">Update payment method</a></p>
      `),
      text: `Payment failed for your Saqr subscription

We were unable to process your payment for Saqr Pro.

Amount: ${d.amount}
Card ending: ${d.cardLast4}
Next retry: ${d.nextRetryDate}

Visit https://app.saqr.dev/billing to update your payment method.`,
    };
  },

  'billing.downgraded': (event) => ({
    subject: 'Your Saqr subscription has been canceled',
    html: wrapHtml(`
      <p>Your Saqr Pro subscription has been canceled. You are now on the free tier.</p>
      <p>Your data will be retained for 30 days. After that, data exceeding the free tier limits will be deleted.</p>
      <p><a class="btn" href="https://app.saqr.dev/billing">Resubscribe</a></p>
    `),
    text: `Your Saqr subscription has been canceled

Your Saqr Pro subscription has been canceled. You are now on the free tier.

Your data will be retained for 30 days. After that, data exceeding the free tier limits will be deleted.

Visit https://app.saqr.dev/billing to resubscribe.`,
  }),
};
```

**Env additions (in `types.ts`):**

```typescript
// Add to Env interface
RESEND_API_KEY: string;
RESEND_FROM_EMAIL: string;
```

**Acceptance Criteria**

- [ ] `sendEmail()` calls Resend API with correct Authorization header and payload
- [ ] All 11 event types either have a template or are intentionally email-free (e.g., `agent.finished`, `agent.idle` have no email template -- they return `null`)
- [ ] `renderTemplate()` returns `null` for event types without email templates
- [ ] HTML templates include responsive layout with header, body, footer
- [ ] Plaintext templates are readable without HTML tags
- [ ] `esc()` function sanitizes `<`, `>`, `&`, `"` characters
- [ ] `wrapHtml()` includes "Manage notification preferences" link in footer
- [ ] Resend API errors are captured and returned as `EmailResult.error`
- [ ] `RESEND_API_KEY` and `RESEND_FROM_EMAIL` added to `Env` interface

**Edge Cases**

- Missing `event.data` fields: templates use `|| ''` or `|| 'unknown machine'` fallbacks.
- Resend API returns non-JSON error body: caught by `response.text()`.
- `agent.finished` and `agent.idle` have no email template by design (not in default email channels).

**Estimated Effort**: M (Medium) -- ~6 hours

---

### Task 4: Push Service (Expo Push API)

**Description**

Implement push notification delivery via the Expo Push API. Sends messages to all registered push tokens for a user. Handles token invalidation by removing `DeviceNotRegistered` tokens from the user's push token list.

**Prerequisites/Inputs**

- Task 1 (types)
- Task 2 (push token storage)

**Implementation Details**

**File: `packages/sync-server/src/notifications/push-service.ts`**

```typescript
import type { NotificationEvent, PushToken } from './types.js';
import { removePushToken } from './preferences.js';

export interface PushResult {
  sent: number;
  failed: number;
  invalidTokensRemoved: string[];
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  sound: 'default';
  badge: number;
  categoryId: string;
}

interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  details?: { error: string };
}

/**
 * Send push notifications via Expo Push API.
 */
export async function sendPush(
  sql: SqlStorage,
  tokens: PushToken[],
  event: NotificationEvent,
  unreadCount: number,
): Promise<PushResult> {
  if (tokens.length === 0) {
    return { sent: 0, failed: 0, invalidTokensRemoved: [] };
  }

  const messages: ExpoPushMessage[] = tokens.map(t => ({
    to: t.token,
    title: event.title,
    body: event.body,
    data: { eventType: event.type, ...(event.data || {}) },
    sound: 'default' as const,
    badge: unreadCount + 1,
    categoryId: event.type,
  }));

  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(messages),
  });

  if (!response.ok) {
    return { sent: 0, failed: tokens.length, invalidTokensRemoved: [] };
  }

  const result = await response.json() as { data: ExpoPushTicket[] };
  const invalidTokensRemoved: string[] = [];
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < result.data.length; i++) {
    const ticket = result.data[i];
    if (ticket.status === 'ok') {
      sent++;
    } else {
      failed++;
      // Remove invalid tokens
      if (ticket.details?.error === 'DeviceNotRegistered') {
        const token = tokens[i].token;
        removePushToken(sql, token);
        invalidTokensRemoved.push(token);
      }
    }
  }

  return { sent, failed, invalidTokensRemoved };
}
```

**Acceptance Criteria**

- [ ] `sendPush()` sends POST to `https://exp.host/--/api/v2/push/send`
- [ ] Message payload includes `title`, `body`, `data`, `sound`, `badge`, `categoryId`
- [ ] Badge count reflects current unread count + 1
- [ ] `DeviceNotRegistered` errors trigger automatic token removal from `push_tokens` table
- [ ] Returns `{ sent: 0, failed: 0, invalidTokensRemoved: [] }` when no tokens exist
- [ ] Expo API HTTP errors return `failed: tokens.length` without throwing

**Edge Cases**

- User with 0 push tokens: early return, no HTTP call.
- Expo API down (non-2xx): all tokens counted as failed, none removed (can't distinguish invalid from transient error).
- Partial success: some tickets ok, some error -- counts tracked individually.

**Estimated Effort**: S (Small) -- ~3 hours

---

### Task 5: Notification Dispatch Service (Channel Routing + Quiet Hours)

**Description**

Implement the central dispatch function that accepts a notification event, checks user preferences, evaluates quiet hours, and routes to the appropriate channel services (email, push, in-app). This is the main `notify()` function called by all notification producers.

**Prerequisites/Inputs**

- Task 1 (types, default channels, security event list)
- Task 2 (preference loading)
- Task 3 (email service)
- Task 4 (push service)

**Implementation Details**

**File: `packages/sync-server/src/notifications/dispatch.ts`**

```typescript
import type { Env, AuthContext } from '../types.js';
import type {
  NotificationEvent,
  NotificationChannel,
  NotificationPreferences,
  NotificationEventType,
} from './types.js';
import { DEFAULT_CHANNELS, SECURITY_EVENT_TYPES } from './types.js';
import { loadPreferences } from './preferences.js';
import { sendEmail } from './email-service.js';
import { sendPush } from './push-service.js';
import { generateId } from '../helpers.js';

export interface DispatchResult {
  dispatched: NotificationChannel[];
  queued: boolean;
  notificationId: string;
}

/**
 * Resolve which channels are enabled for a given event type,
 * considering global channel toggles and per-event overrides.
 */
export function resolveChannels(
  prefs: NotificationPreferences,
  eventType: NotificationEventType,
): Record<NotificationChannel, boolean> {
  const defaults = DEFAULT_CHANNELS[eventType] || [];
  const result: Record<NotificationChannel, boolean> = {
    email: defaults.includes('email') && prefs.channels.email,
    push: defaults.includes('push') && prefs.channels.push,
    inApp: defaults.includes('inApp') && prefs.channels.inApp,
  };

  // Apply per-event overrides
  const overrides = prefs.events[eventType];
  if (overrides) {
    if (overrides.email !== undefined) result.email = overrides.email;
    if (overrides.push !== undefined) result.push = overrides.push;
    if (overrides.inApp !== undefined) result.inApp = overrides.inApp;
  }

  return result;
}

/**
 * Check if the current time falls within the user's quiet hours window.
 */
export function isQuietHours(prefs: NotificationPreferences, now?: Date): boolean {
  if (!prefs.quietHours.enabled) return false;

  const current = now || new Date();

  // Convert current time to user's timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: prefs.quietHours.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(current);
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
  const currentMinutes = hour * 60 + minute;

  const [startH, startM] = prefs.quietHours.start.split(':').map(Number);
  const [endH, endM] = prefs.quietHours.end.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Handle overnight quiet hours (e.g., 22:00 - 08:00)
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
  // Same-day quiet hours (e.g., 13:00 - 15:00)
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * Main dispatch function. Called for every notification event.
 */
export async function notify(
  sql: SqlStorage,
  env: Env,
  userId: string,
  email: string,
  event: NotificationEvent,
): Promise<DispatchResult> {
  const prefs = loadPreferences(sql, userId);
  const channels = resolveChannels(prefs, event.type);
  const notificationId = generateId();
  const isSecurity = SECURITY_EVENT_TYPES.includes(event.type);

  // Check quiet hours (security events bypass)
  if (!isSecurity && isQuietHours(prefs)) {
    // Queue for later delivery
    sql.exec(
      `INSERT INTO notification_queue (id, event_type, payload, queued_at)
       VALUES (?, ?, ?, ?)`,
      notificationId, event.type, JSON.stringify(event), new Date().toISOString(),
    );
    return { dispatched: [], queued: true, notificationId };
  }

  const dispatched: NotificationChannel[] = [];

  // Dispatch to each enabled channel
  const promises: Promise<void>[] = [];

  if (channels.email) {
    promises.push(
      sendEmail(env, email, event).then(() => { dispatched.push('email'); }),
    );
  }

  if (channels.push) {
    const unreadCount = getUnreadCount(sql);
    promises.push(
      sendPush(sql, prefs.pushTokens, event, unreadCount).then(() => { dispatched.push('push'); }),
    );
  }

  if (channels.inApp) {
    dispatched.push('inApp');
    // In-app delivery handled by Task 7 (WebSocket broadcast)
  }

  await Promise.allSettled(promises);

  // Store in notification history
  storeNotification(sql, notificationId, event, dispatched);

  return { dispatched, queued: false, notificationId };
}

/**
 * Store a notification in the history table.
 */
function storeNotification(
  sql: SqlStorage,
  id: string,
  event: NotificationEvent,
  channels: NotificationChannel[],
): void {
  sql.exec(
    `INSERT INTO notifications (id, event_type, title, body, data, channels, read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    id,
    event.type,
    event.title,
    event.body,
    event.data ? JSON.stringify(event.data) : null,
    JSON.stringify(channels),
    event.timestamp,
  );
}

/**
 * Get the current unread notification count.
 */
function getUnreadCount(sql: SqlStorage): number {
  const row = sql.exec('SELECT COUNT(*) as count FROM notifications WHERE read = 0').toArray()[0] as { count: number } | undefined;
  return row?.count || 0;
}
```

**Acceptance Criteria**

- [ ] `resolveChannels()` returns correct channels based on defaults, global toggles, and per-event overrides
- [ ] Per-event overrides take precedence over global channel toggles
- [ ] Disabling global email channel disables email for all event types
- [ ] `isQuietHours()` correctly handles overnight windows (e.g., 22:00-08:00)
- [ ] `isQuietHours()` correctly handles same-day windows (e.g., 13:00-15:00)
- [ ] `isQuietHours()` respects timezone via `Intl.DateTimeFormat`
- [ ] Security events (`security.*`) are dispatched immediately even during quiet hours
- [ ] Non-security events during quiet hours are written to `notification_queue` table
- [ ] `notify()` uses `Promise.allSettled` so one channel failure does not block others
- [ ] Notification stored in `notifications` table after dispatch
- [ ] Unread count incremented correctly

**Edge Cases**

- User with no preferences stored: `loadPreferences()` returns `DEFAULT_PREFERENCES`.
- Unknown event type not in `DEFAULT_CHANNELS`: all channels default to false (no notification sent).
- Quiet hours with timezone that has DST transitions: `Intl.DateTimeFormat` handles DST correctly.
- `channels.inApp` is true but WebSocket not connected: notification is stored in history (Task 7 delivers when user reconnects).

**Estimated Effort**: M (Medium) -- ~5 hours

---

### Task 6: DO Alarm Queuing for Quiet Hours

**Description**

Extend the existing `UserSyncDO.alarm()` handler to drain the `notification_queue` table when quiet hours end. When a notification is queued during quiet hours, a DO alarm is set for the end of the quiet window. When the alarm fires, all queued notifications are dispatched.

**Prerequisites/Inputs**

- Task 1 (queue schema)
- Task 5 (dispatch service)
- Existing `UserSyncDO.alarm()` handler at line 678 of `user-sync.ts`

**Implementation Details**

**Modifications to `UserSyncDO.alarm()` in `user-sync.ts`:**

```typescript
async alarm(): Promise<void> {
  // --- Existing retention cleanup ---
  // (keep existing retention cleanup code unchanged)

  // --- Notification queue drain ---
  await this.drainNotificationQueue();
}

/**
 * Process all queued notifications (accumulated during quiet hours).
 */
private async drainNotificationQueue(): Promise<void> {
  const rows = this.sql.exec(
    'SELECT id, event_type, payload, queued_at FROM notification_queue ORDER BY queued_at ASC',
  ).toArray() as NotificationQueueRow[];

  if (rows.length === 0) return;

  const account = this.sql.exec('SELECT user_id, email FROM account LIMIT 1').toArray()[0] as
    { user_id: string; email: string } | undefined;
  if (!account) return;

  for (const row of rows) {
    const event = JSON.parse(row.payload) as NotificationEvent;
    // Dispatch without quiet hours check (alarm fires at end of quiet hours)
    await notify(this.sql, this.env, account.user_id, account.email, event);
  }

  // Clear the queue
  this.sql.exec('DELETE FROM notification_queue');
}
```

**Setting the alarm (called from `notify()` when queuing):**

When a notification is queued, the dispatch service must also set a DO alarm for the quiet hours end time. Add a helper:

```typescript
/**
 * Calculate the next alarm time for the end of quiet hours.
 */
export function calculateQuietHoursEndAlarm(prefs: NotificationPreferences): number {
  const [endH, endM] = prefs.quietHours.end.split(':').map(Number);
  const now = new Date();

  // Build a date for today at the end time in the user's timezone
  // Use Intl to get the current date in the user's timezone
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: prefs.quietHours.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dateStr = formatter.format(now); // YYYY-MM-DD

  // Parse and construct the target time
  const target = new Date(`${dateStr}T${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`);

  // If the target is in the past, it's tomorrow
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime();
}
```

**30-day notification cleanup (added to existing alarm):**

```typescript
// Clean up notifications older than 30 days
const thirtyDaysAgo = new Date();
thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
this.sql.exec(
  'DELETE FROM notifications WHERE created_at < ?',
  thirtyDaysAgo.toISOString(),
);
```

**Acceptance Criteria**

- [ ] DO alarm is set when first notification is queued during quiet hours
- [ ] `calculateQuietHoursEndAlarm()` returns timestamp for end of quiet hours in user's timezone
- [ ] If end time is in the past for today, alarm is set for tomorrow
- [ ] `drainNotificationQueue()` processes all queued notifications in FIFO order
- [ ] Queue is cleared after successful drain
- [ ] 30-day notification history cleanup runs on every alarm invocation
- [ ] Existing retention cleanup code in `alarm()` is preserved unchanged

**Edge Cases**

- Queue is empty when alarm fires: `drainNotificationQueue()` returns early.
- Multiple notifications queued: all are processed in a single alarm invocation.
- Account deleted before alarm fires: `account` query returns empty, drain skips.
- Alarm set twice (two notifications queued in same quiet window): DO alarms are idempotent -- second `setAlarm()` overwrites the first with the same time.

**Estimated Effort**: S (Small) -- ~3 hours

---

### Task 7: In-App Notifications (WebSocket Broadcast + History API)

**Description**

Implement in-app notification delivery via WebSocket and the notification history REST API (list, mark read, mark all read). When a notification is dispatched to the `inApp` channel, it is broadcast to all active WebSocket connections for the user. The history API provides paginated access to stored notifications.

**Prerequisites/Inputs**

- Task 1 (schema, types)
- Task 5 (dispatch stores notifications in history)

**Implementation Details**

**File: `packages/sync-server/src/notifications/history.ts`**

```typescript
import type { NotificationRow } from './types.js';

export interface NotificationListResponse {
  notifications: NotificationRow[];
  unreadCount: number;
  total: number;
}

/**
 * Query notification history with pagination and optional unread filter.
 */
export function listNotifications(
  sql: SqlStorage,
  options: { limit: number; offset: number; unreadOnly: boolean },
): NotificationListResponse {
  const { limit, offset, unreadOnly } = options;

  const clampedLimit = Math.min(Math.max(limit, 1), 100);
  const clampedOffset = Math.max(offset, 0);

  let query = 'SELECT * FROM notifications';
  const params: unknown[] = [];

  if (unreadOnly) {
    query += ' WHERE read = 0';
  }

  // Total count
  let countQuery = 'SELECT COUNT(*) as count FROM notifications';
  if (unreadOnly) countQuery += ' WHERE read = 0';
  const totalRow = sql.exec(countQuery).toArray()[0] as { count: number };
  const total = totalRow?.count || 0;

  // Unread count (always full, not filtered)
  const unreadRow = sql.exec(
    'SELECT COUNT(*) as count FROM notifications WHERE read = 0',
  ).toArray()[0] as { count: number };
  const unreadCount = unreadRow?.count || 0;

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(clampedLimit, clampedOffset);

  const notifications = sql.exec(query, ...params).toArray() as NotificationRow[];

  return { notifications, unreadCount, total };
}

/**
 * Mark a single notification as read.
 */
export function markRead(sql: SqlStorage, notificationId: string): boolean {
  const existing = sql.exec(
    'SELECT id FROM notifications WHERE id = ?', notificationId,
  ).toArray();
  if (existing.length === 0) return false;

  sql.exec('UPDATE notifications SET read = 1 WHERE id = ?', notificationId);
  return true;
}

/**
 * Mark all notifications as read.
 */
export function markAllRead(sql: SqlStorage): number {
  const before = sql.exec(
    'SELECT COUNT(*) as count FROM notifications WHERE read = 0',
  ).toArray()[0] as { count: number };

  sql.exec('UPDATE notifications SET read = 1 WHERE read = 0');
  return before?.count || 0;
}
```

**DO route handlers (added to `UserSyncDO`):**

```typescript
// GET /api/notifications
private handleListNotifications(request: Request): Response {
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '20', 10);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const unreadOnly = url.searchParams.get('unreadOnly') === 'true';

  const result = listNotifications(this.sql, { limit, offset, unreadOnly });
  return jsonResponse(200, result);
}

// PUT /api/notifications/:id/read
private handleMarkRead(notificationId: string): Response {
  const found = markRead(this.sql, notificationId);
  if (!found) return errorResponse(404, 'not_found', 'Notification not found');
  return jsonResponse(200, { ok: true });
}

// PUT /api/notifications/read-all
private handleMarkAllRead(): Response {
  const count = markAllRead(this.sql);
  return jsonResponse(200, { ok: true, markedRead: count });
}
```

**WebSocket broadcast (when inApp channel is dispatched):**

The WebSocket broadcast integrates with the DO's active WebSocket connections. When a notification is stored with `inApp` in its channels, the DO sends a JSON message to all connected WebSocket clients:

```typescript
/**
 * Broadcast a notification to all active WebSocket connections.
 */
private broadcastNotification(notification: NotificationRow): void {
  const message = JSON.stringify({
    type: 'notification',
    payload: notification,
  });

  // Iterate over accepted WebSocket connections
  for (const ws of this.state.getWebSockets()) {
    try {
      ws.send(message);
    } catch {
      // Connection closed, will be cleaned up
    }
  }
}
```

**Acceptance Criteria**

- [ ] `GET /api/notifications` returns paginated notification list with `unreadCount` and `total`
- [ ] `limit` parameter is clamped to 1-100 range
- [ ] `unreadOnly=true` filters to unread notifications only
- [ ] `PUT /api/notifications/:id/read` marks a single notification as read
- [ ] `PUT /api/notifications/:id/read` returns 404 for unknown notification ID
- [ ] `PUT /api/notifications/read-all` marks all unread notifications as read and returns count
- [ ] WebSocket broadcast sends JSON `{ type: "notification", payload: ... }` to all connected clients
- [ ] WebSocket send errors (closed connections) are caught silently

**Edge Cases**

- No notifications: returns `{ notifications: [], unreadCount: 0, total: 0 }`.
- `limit=0` or negative: clamped to 1.
- `limit=999`: clamped to 100.
- WebSocket not connected: notification is still stored in history; no broadcast error.
- Mark read on already-read notification: idempotent, returns 200.

**Estimated Effort**: M (Medium) -- ~5 hours

---

### Task 8: Worker Route Integration

**Description**

Wire all notification API routes into the existing Worker gateway (`worker.ts`) and the UserSyncDO fetch router (`user-sync.ts`). Add the notification paths to the `requiresAuth()` check and add DO route matching for all notification endpoints.

**Prerequisites/Inputs**

- Tasks 2, 7 (all handlers implemented)
- Existing Worker routing in `/home/meywd/Saqr/packages/sync-server/src/worker.ts`
- Existing DO routing in `/home/meywd/Saqr/packages/sync-server/src/durable-objects/user-sync.ts`

**Implementation Details**

**Modifications to `worker.ts`:**

1. Add notification paths to `requiresAuth()`:

```typescript
function requiresAuth(pathname: string): boolean {
  return (
    pathname.startsWith('/api/sync/') ||
    pathname.startsWith('/api/account') ||
    pathname.startsWith('/api/machines') ||
    pathname.startsWith('/api/notifications') ||  // NEW
    pathname === '/api/codeguard/telemetry'
  );
}
```

All `/api/notifications/*` routes are authenticated and forwarded to the user's DO via `routeToDO()`. No special Worker-level handling needed -- the DO handles all notification logic.

**Modifications to `UserSyncDO.fetch()`:**

Add route matching for all notification endpoints:

```typescript
// Notification preferences
if (url.pathname === '/api/notifications/preferences' && request.method === 'GET') {
  if (!authCtx) return errorResponse(401, 'unauthorized', 'Authentication required');
  return this.handleGetPreferences(authCtx);
}

if (url.pathname === '/api/notifications/preferences' && request.method === 'PUT') {
  if (!authCtx) return errorResponse(401, 'unauthorized', 'Authentication required');
  return this.handleUpdatePreferences(request, authCtx);
}

// Push token management
if (url.pathname === '/api/notifications/push-token' && request.method === 'POST') {
  if (!authCtx) return errorResponse(401, 'unauthorized', 'Authentication required');
  return this.handleAddPushToken(request);
}

if (url.pathname.startsWith('/api/notifications/push-token/') && request.method === 'DELETE') {
  if (!authCtx) return errorResponse(401, 'unauthorized', 'Authentication required');
  const token = url.pathname.split('/api/notifications/push-token/')[1];
  if (!token) return errorResponse(400, 'missing_token', 'Push token required');
  return this.handleRemovePushToken(token);
}

// Notification history
if (url.pathname === '/api/notifications' && request.method === 'GET') {
  if (!authCtx) return errorResponse(401, 'unauthorized', 'Authentication required');
  return this.handleListNotifications(request);
}

if (url.pathname.match(/^\/api\/notifications\/[^/]+\/read$/) && request.method === 'PUT') {
  if (!authCtx) return errorResponse(401, 'unauthorized', 'Authentication required');
  const segments = url.pathname.split('/');
  const notificationId = segments[3]; // /api/notifications/:id/read
  return this.handleMarkRead(notificationId);
}

if (url.pathname === '/api/notifications/read-all' && request.method === 'PUT') {
  if (!authCtx) return errorResponse(401, 'unauthorized', 'Authentication required');
  return this.handleMarkAllRead();
}
```

**Env binding updates in `wrangler.toml`:**

```toml
[vars]
RESEND_API_KEY = ""  # Set via wrangler secret
RESEND_FROM_EMAIL = "Saqr <notifications@saqr.dev>"
```

Note: `RESEND_API_KEY` should be set as a Cloudflare secret (`wrangler secret put RESEND_API_KEY`), not in `[vars]`.

**Acceptance Criteria**

- [ ] All `/api/notifications/*` paths require JWT auth
- [ ] `GET /api/notifications/preferences` routed to DO and returns 200
- [ ] `PUT /api/notifications/preferences` routed to DO and returns 200
- [ ] `POST /api/notifications/push-token` routed to DO and returns 201
- [ ] `DELETE /api/notifications/push-token/:token` routed to DO and returns 200/404
- [ ] `GET /api/notifications` routed to DO and returns 200
- [ ] `PUT /api/notifications/:id/read` routed to DO and returns 200/404
- [ ] `PUT /api/notifications/read-all` routed to DO and returns 200
- [ ] Unauthenticated requests to notification endpoints return 401
- [ ] `RESEND_API_KEY` and `RESEND_FROM_EMAIL` added to Env and wrangler config

**Edge Cases**

- Path `/api/notifications/push-token/ExponentPushToken%5Babc%5D`: URL-encoded brackets handled by `decodeURIComponent` in the handler.
- Path `/api/notifications/read-all` must not collide with `/api/notifications/:id/read` -- route matching order matters; `read-all` is checked before the regex pattern.

**Estimated Effort**: S (Small) -- ~2 hours

---

### Task 9: Tests (30+ Test Cases)

**Description**

Comprehensive unit tests for all notification services, preferences, dispatch logic, templates, and API handlers. Uses vitest with the existing mock infrastructure from `/home/meywd/Saqr/packages/sync-server/src/__tests__/helpers/mock-env.ts`.

**Prerequisites/Inputs**

- All Tasks 1-8 implemented
- Existing test infrastructure: `MockSqlStorage`, `MockKVNamespace`, `MockDurableObjectState`, `createMockEnv()`

**Implementation Details**

**File: `packages/sync-server/src/__tests__/notifications/types.test.ts`**

Tests for type constants and defaults:
1. `DEFAULT_CHANNELS` includes all 11 event types
2. `DEFAULT_CHANNELS['agent.error']` includes email, push, inApp
3. `DEFAULT_CHANNELS['agent.idle']` includes only inApp
4. `SECURITY_EVENT_TYPES` includes all three security types
5. `DEFAULT_PREFERENCES` has all channels enabled

**File: `packages/sync-server/src/__tests__/notifications/preferences.test.ts`**

Tests for preference CRUD:
6. `loadPreferences()` returns defaults for new user (TC23.1)
7. `savePreferences()` stores and retrieves channel overrides
8. `savePreferences()` merges per-event overrides (TC23.2)
9. Disable email channel reflected in loaded preferences (TC23.3)
10. `addPushToken()` stores token with device name (TC23.4)
11. `addPushToken()` with duplicate token updates device name
12. `removePushToken()` removes token (TC23.5)
13. `removePushToken()` returns false for unknown token

**File: `packages/sync-server/src/__tests__/notifications/email-templates.test.ts`**

Tests for email templates:
14. `renderTemplate()` for `agent.error` returns subject, html, text (TC23.6)
15. `renderTemplate()` for `agent.permission` includes approve/deny links (TC23.7)
16. `renderTemplate()` returns null for `agent.finished` (no email template)
17. HTML output contains `<html>` and responsive layout
18. Plaintext output has no HTML tags (TC23.9)
19. `esc()` escapes `<script>` and `"` characters
20. `renderTemplate()` for `billing.trial_ending` includes end date (TC23.10)

**File: `packages/sync-server/src/__tests__/notifications/email-service.test.ts`**

Tests for email sending:
21. `sendEmail()` calls Resend API with correct headers and body
22. `sendEmail()` returns error when Resend returns non-200
23. Email disabled for event type means no email call (TC23.8)

**File: `packages/sync-server/src/__tests__/notifications/push-service.test.ts`**

Tests for push notifications:
24. `sendPush()` sends to Expo API with correct payload (TC23.11)
25. `sendPush()` sends to all tokens (TC23.12)
26. `sendPush()` removes DeviceNotRegistered tokens (TC23.13)
27. `sendPush()` returns early with 0 sent when no tokens (TC23.14)

**File: `packages/sync-server/src/__tests__/notifications/dispatch.test.ts`**

Tests for dispatch logic:
28. `resolveChannels()` applies default channels correctly
29. `resolveChannels()` respects global channel toggle (disable email)
30. `resolveChannels()` applies per-event overrides
31. `isQuietHours()` returns false when disabled
32. `isQuietHours()` returns true during overnight window (TC23.19, TC23.22)
33. `isQuietHours()` returns false outside window
34. `isQuietHours()` handles same-day window
35. `notify()` queues during quiet hours (TC23.19)
36. `notify()` dispatches security events during quiet hours (TC23.21)
37. `notify()` stores notification in history (TC23.23)

**File: `packages/sync-server/src/__tests__/notifications/history.test.ts`**

Tests for notification history:
38. `listNotifications()` returns paginated results (TC23.24)
39. `listNotifications()` with `unreadOnly` filter (TC23.25)
40. `markRead()` marks notification as read (TC23.17)
41. `markRead()` returns false for unknown ID
42. `markAllRead()` marks all unread as read (TC23.18)
43. Unread count increments on new notification (TC23.16)
44. Notifications older than 30 days are cleaned up (TC23.26)

**File: `packages/sync-server/src/__tests__/notifications/quiet-hours-alarm.test.ts`**

Tests for alarm-based queue drain:
45. `calculateQuietHoursEndAlarm()` returns correct timestamp
46. `calculateQuietHoursEndAlarm()` rolls to tomorrow if end time passed
47. `drainNotificationQueue()` processes queued notifications (TC23.20)
48. `drainNotificationQueue()` clears queue after processing
49. `drainNotificationQueue()` skips if queue empty

**Testing approach for HTTP calls (Resend, Expo):**

Use `vi.fn()` to mock global `fetch`. Each test sets up `globalThis.fetch = vi.fn().mockResolvedValue(...)` and asserts the call arguments:

```typescript
const mockFetch = vi.fn().mockResolvedValue(
  new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 }),
);
globalThis.fetch = mockFetch;

await sendEmail(env, 'user@test.com', event);

expect(mockFetch).toHaveBeenCalledWith(
  'https://api.resend.com/emails',
  expect.objectContaining({
    method: 'POST',
    headers: expect.objectContaining({
      'Authorization': 'Bearer test-resend-key',
    }),
  }),
);
```

**Testing approach for SQLite operations:**

Use `MockSqlStorage` extended with a simple in-memory table simulation, or use a more capable mock that tracks INSERT/SELECT calls and returns canned data based on the query pattern.

**Acceptance Criteria**

- [ ] 30+ test cases implemented across 7 test files
- [ ] All tests pass with `vitest run`
- [ ] Tests cover all 26 story test cases (TC23.1 through TC23.26)
- [ ] Email and push HTTP calls are mocked (no real API calls in tests)
- [ ] Quiet hours timezone handling tested with specific timezone values
- [ ] Edge cases tested: empty preferences, no tokens, unknown notification IDs
- [ ] Coverage for `esc()` XSS prevention in email templates

**Edge Cases**

- `MockSqlStorage` may need enhancement to return realistic query results for preference and notification queries. Consider using a lightweight SQLite WASM for integration tests if the mock becomes too complex.
- `globalThis.fetch` mock must be restored in `afterEach` to avoid test pollution.

**Estimated Effort**: L (Large) -- ~8 hours

---

## Summary

| Task | Description | Size | Depends On |
|------|-------------|------|------------|
| 1 | Notification Types & Preferences Schema | S (3h) | -- |
| 2 | Notification Preferences API | M (5h) | 1 |
| 3 | Email Service (Resend + Templates) | M (6h) | 1 |
| 4 | Push Service (Expo Push API) | S (3h) | 1, 2 |
| 5 | Notification Dispatch Service | M (5h) | 1, 2, 3, 4 |
| 6 | DO Alarm Queuing for Quiet Hours | S (3h) | 1, 5 |
| 7 | In-App Notifications (WebSocket + History) | M (5h) | 1, 5 |
| 8 | Worker Route Integration | S (2h) | 2, 7 |
| 9 | Tests (30+ test cases) | L (8h) | 1-8 |
| **Total** | | | **~40-50h** |

### New Files Created

```
packages/sync-server/src/notifications/
  types.ts            (Task 1)
  preferences.ts      (Task 2)
  email-service.ts    (Task 3)
  email-templates.ts  (Task 3)
  push-service.ts     (Task 4)
  dispatch.ts         (Task 5)
  history.ts          (Task 7)

packages/sync-server/src/__tests__/notifications/
  types.test.ts             (Task 9)
  preferences.test.ts       (Task 9)
  email-templates.test.ts   (Task 9)
  email-service.test.ts     (Task 9)
  push-service.test.ts      (Task 9)
  dispatch.test.ts          (Task 9)
  history.test.ts           (Task 9)
  quiet-hours-alarm.test.ts (Task 9)
```

### Existing Files Modified

```
packages/sync-server/src/types.ts                      (Task 1 -- Env additions)
packages/sync-server/src/durable-objects/user-sync.ts   (Tasks 1, 2, 6, 7, 8 -- schema, handlers, alarm, routes)
packages/sync-server/src/worker.ts                      (Task 8 -- requiresAuth update)
```

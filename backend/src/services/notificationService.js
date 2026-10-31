'use strict';
/**
 * Notification Service (FR-11). Every notification is stored as an IN_APP row and pushed to
 * the user's socket room. Optional channels:
 *   - PUSH via Firebase Cloud Messaging when FIREBASE_SERVICE_ACCOUNT is set and the user has
 *     registered an FCM device token (firebase-admin is lazily required; install it separately).
 *   - EMAIL via nodemailer when SMTP_HOST is set and the user has an e-mail address.
 * Delivery outcome of each channel is recorded in the notifications table (status SENT/FAILED).
 */
const fs = require('node:fs');
const config = require('../config');
const time = require('../utils/time');
const realtime = require('./realtime');

let firebaseInitialised = false;
let firebaseMessaging = null;
let mailTransport = null;

function getFirebaseMessaging() {
  if (!config.firebaseServiceAccount) return null;
  if (firebaseInitialised) return firebaseMessaging;
  firebaseInitialised = true;
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const admin = require('firebase-admin');
    const raw = config.firebaseServiceAccount.trim();
    const serviceAccount = raw.startsWith('{') ? JSON.parse(raw) : JSON.parse(fs.readFileSync(raw, 'utf8'));
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firebaseMessaging = admin.messaging();
  } catch (err) {
    console.warn(`[notifications] Push disabled: ${err.message}`);
    firebaseMessaging = null;
  }
  return firebaseMessaging;
}

function getMailTransport() {
  if (!config.smtp.host) return null;
  if (mailTransport) return mailTransport;
  const nodemailer = require('nodemailer');
  mailTransport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return mailTransport;
}

async function logChannel(db, userId, tokenId, channel, message, status) {
  await db.run(
    `INSERT INTO notifications (user_id, token_id, channel, message, sent_at, status, is_read)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [userId, tokenId || null, channel, message, time.nowDb(), status]
  );
}

/**
 * Notify a user.
 * @param {object} db
 * @param {number} userId
 * @param {{ tokenId?: number|null, message: string, email?: boolean, subject?: string }} opts
 */
async function notify(db, userId, { tokenId = null, message, email = false, subject = 'Smart OPD notification' }) {
  const text = String(message).slice(0, 255);
  const { insertId } = await db.run(
    `INSERT INTO notifications (user_id, token_id, channel, message, sent_at, status, is_read)
     VALUES (?, ?, 'IN_APP', ?, ?, 'SENT', 0)`,
    [userId, tokenId || null, text, time.nowDb()]
  );
  realtime.emitNotification(userId, { id: insertId, message: text, tokenId: tokenId || null });

  // Optional external channels run in the background so they never slow down the API.
  if (config.firebaseServiceAccount || (email && config.smtp.host)) {
    setImmediate(() => {
      sendExternal(db, userId, tokenId, text, { email, subject }).catch((err) =>
        console.warn(`[notifications] external delivery failed: ${err.message}`)
      );
    });
  }
  return insertId;
}

async function sendExternal(db, userId, tokenId, text, { email, subject }) {
  const user = await db.get('SELECT email, fcm_token FROM users WHERE user_id = ?', [userId]);
  if (!user) return;
  const messaging = getFirebaseMessaging();
  if (messaging && user.fcm_token) {
    try {
      await messaging.send({
        token: user.fcm_token,
        notification: { title: 'Smart OPD', body: text },
        data: tokenId ? { tokenId: String(tokenId) } : {},
      });
      await logChannel(db, userId, tokenId, 'PUSH', text, 'SENT');
    } catch (err) {
      await logChannel(db, userId, tokenId, 'PUSH', text, 'FAILED');
    }
  }
  const transport = email ? getMailTransport() : null;
  if (transport && user.email) {
    try {
      await transport.sendMail({ from: config.smtp.from, to: user.email, subject, text });
      await logChannel(db, userId, tokenId, 'EMAIL', text, 'SENT');
    } catch (err) {
      await logChannel(db, userId, tokenId, 'EMAIL', text, 'FAILED');
    }
  }
}

/** Has an IN_APP notification starting with `prefix` already been sent for this token? */
async function alreadySent(db, tokenId, prefix) {
  const row = await db.get(
    `SELECT notification_id FROM notifications WHERE token_id = ? AND channel = 'IN_APP' AND message LIKE ?`,
    [tokenId, `${prefix}%`]
  );
  return Boolean(row);
}

async function listForUser(db, userId, limit = 100) {
  const rows = await db.query(
    `SELECT notification_id, token_id, channel, message, sent_at, is_read FROM notifications
      WHERE user_id = ? AND channel = 'IN_APP'
      ORDER BY notification_id DESC LIMIT ${Number(limit) | 0}`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.notification_id,
    tokenId: r.token_id,
    channel: r.channel,
    message: r.message,
    sentAt: time.toApi(r.sent_at),
    isRead: Boolean(r.is_read),
  }));
}

async function markAllRead(db, userId) {
  await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [userId]);
}

module.exports = { notify, alreadySent, listForUser, markAllRead };

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
const { models, sess, insertOne } = require('../db');

const { Notification, User } = models;

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

function notificationDoc(userId, tokenId, channel, message, status) {
  return {
    user_id: userId,
    token_id: tokenId || null,
    channel,
    message,
    sent_at: time.nowDb(),
    status,
    is_read: false,
  };
}

async function logChannel(db, userId, tokenId, channel, message, status) {
  await insertOne(db, Notification, notificationDoc(userId, tokenId, channel, message, status));
}

/**
 * Notify a user.
 * @param {object} db
 * @param {number} userId
 * @param {{ tokenId?: number|null, message: string, email?: boolean, subject?: string }} opts
 */
async function notify(db, userId, { tokenId = null, message, email = false, subject = 'Smart OPD notification' }) {
  const text = String(message).slice(0, 255);
  const insertId = await insertOne(db, Notification, notificationDoc(userId, tokenId, 'IN_APP', text, 'SENT'));
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
  const user = await User.findById(userId, { email: 1, fcm_token: 1 }).session(sess(db)).lean();
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
  const escaped = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = await Notification.exists({
    token_id: tokenId,
    channel: 'IN_APP',
    message: { $regex: `^${escaped}`, $options: 'i' }, // SQL LIKE 'prefix%' (case-insensitive)
  }).session(sess(db));
  return Boolean(row);
}

async function listForUser(db, userId, limit = 100) {
  const rows = await Notification.find({ user_id: userId, channel: 'IN_APP' })
    .sort({ _id: -1 })
    .limit(Number(limit) | 0)
    .session(sess(db))
    .lean();
  return rows.map((r) => ({
    id: r._id,
    tokenId: r.token_id,
    channel: r.channel,
    message: r.message,
    sentAt: time.toApi(r.sent_at),
    isRead: Boolean(r.is_read),
  }));
}

async function markAllRead(db, userId) {
  await Notification.updateMany({ user_id: userId, is_read: false }, { $set: { is_read: true } }, { session: sess(db) });
}

/** Register the device token used for push notifications (POST /notifications/device-token). */
async function setDeviceToken(db, userId, fcmToken) {
  await User.updateOne({ _id: userId }, { $set: { fcm_token: fcmToken } }, { session: sess(db) });
}

module.exports = { notify, alreadySent, listForUser, markAllRead, setDeviceToken };

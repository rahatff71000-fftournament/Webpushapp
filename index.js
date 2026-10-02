const express     = require('express');
const admin       = require('firebase-admin');
const bodyParser  = require('body-parser');
const cors        = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));

// ════════════════════════════════════════════════════════════
// FIREBASE ADMIN INIT
// ════════════════════════════════════════════════════════════
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://prime-rush-esports-default-rtdb.firebaseio.com'
});

const db     = admin.firestore();                              // পুরনো Firestore endpoints এর জন্য
const rtdb   = admin.database();                               // নতুন Realtime DB (token cleanup এর জন্য)

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

function isValidAppId(appId) {
  return appId && /^[a-zA-Z0-9._\-]{3,100}$/.test(appId);
}

function tokenDocId(token) {
  return token.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
}

function devicesRef(appId) {
  return db.collection('push_tokens').doc(appId).collection('devices');
}

function appMetaRef(appId) {
  return db.collection('push_app_meta').doc(appId);
}

// ════════════════════════════════════════════════════════════
// BASIC ROUTES
// ════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.send('Wevlo Push Notification Server is Running!');
});

app.get('/debug', (req, res) => {
  res.json({
    project_id:      serviceAccount.project_id,
    client_email:    serviceAccount.client_email,
    private_key_id:  serviceAccount.private_key_id,
    private_key_len: (serviceAccount.private_key || '').length,
    databaseURL:     'https://prime-rush-esports-default-rtdb.firebaseio.com'
  });
});

app.get('/app-status', async (req, res) => {
  const { appId } = req.query;
  if (!isValidAppId(appId)) return res.status(400).json({ success: false, error: 'valid appId required' });

  try {
    const metaDoc   = await appMetaRef(appId).get();
    const tokenSnap = await devicesRef(appId).get();
    res.json({
      success:      true,
      appId,
      registered:   metaDoc.exists,
      registeredAt: metaDoc.exists ? metaDoc.data().registeredAt : null,
      tokenCount:   tokenSnap.size
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/register-app', async (req, res) => {
  const { appId } = req.body;
  if (!isValidAppId(appId)) return res.status(400).json({ success: false, error: 'valid appId required' });

  try {
    const ref = appMetaRef(appId);
    const doc = await ref.get();

    await ref.set({
      appId,
      registeredAt: doc.exists ? doc.data().registeredAt : Date.now(),
      updatedAt:    Date.now()
    }, { merge: true });

    console.log(`[${appId}] App registered/updated`);
    res.json({ success: true, message: 'app registered' });
  } catch (e) {
    console.error('Register-app error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/register-token', async (req, res) => {
  const { token, appId, userAgent } = req.body;

  if (!token)               return res.status(400).json({ success: false, error: 'token required' });
  if (!isValidAppId(appId)) return res.status(400).json({ success: false, error: 'valid appId required' });

  try {
    await devicesRef(appId).doc(tokenDocId(token)).set({
      token,
      appId,
      userAgent:    userAgent || '',
      registeredAt: Date.now(),
      updatedAt:    Date.now()
    }, { merge: true });

    console.log(`[${appId}] Token registered: ${token.substring(0, 20)}...`);
    res.json({ success: true });
  } catch (e) {
    console.error('Register error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/tokens', async (req, res) => {
  const { appId } = req.query;
  if (!isValidAppId(appId)) return res.status(400).json({ success: false, error: 'valid appId required' });

  try {
    const snap   = await devicesRef(appId).get();
    const tokens = snap.docs.map(d => ({
      token:        d.data().token,
      registeredAt: d.data().registeredAt,
      userAgent:    d.data().userAgent || ''
    }));
    res.json({ success: true, appId, count: tokens.length, tokens });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// 🔔 NEW: PUSH NOTIFICATION ENDPOINT (prime-rush-esports)
// Client থেকে tokens array আসে — DB lookup লাগে না
// ════════════════════════════════════════════════════════════

app.post('/send-push', async (req, res) => {
  try {
    const { tokens, title, body, imageUrl, type, data } = req.body;

    if (!Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ success: false, error: 'No tokens provided' });
    }
    if (!title || !body) {
      return res.status(400).json({ success: false, error: 'title and body required' });
    }

    // ── Sanitize data for FCM (all values must be strings) ──
    const dataStrings = {};
    if (data && typeof data === 'object') {
      Object.entries(data).forEach(([k, v]) => {
        dataStrings[k] = String(v == null ? '' : v);
      });
    }

    // ── Chunk to 500 per FCM request ──
    const chunks = [];
    for (let i = 0; i < tokens.length; i += 500) {
      chunks.push(tokens.slice(i, i + 500));
    }

    let successCount = 0;
    let failureCount = 0;
    const invalidTokens = [];

    for (const chunk of chunks) {
      const message = {
        tokens: chunk,
        notification: {
          title,
          body,
          ...(imageUrl ? { imageUrl } : {})
        },
        data: {
          title:    String(title),
          body:     String(body),
          type:     String(type || 'general'),
          imageUrl: String(imageUrl || ''),
          ...dataStrings
        },
        webpush: {
          notification: {
            title:                title,
            body:                 body,
            icon:                 'https://i.postimg.cc/QNFM0Fcv/file-00000000e14481f59c423448bd73da63.png',
            badge:                'https://i.postimg.cc/QNFM0Fcv/file-00000000e14481f59c423448bd73da63.png',
            ...(imageUrl ? { image: imageUrl } : {}),
            requireInteraction:   type === 'room_details'
          },
          fcmOptions: {
            link: (data && data.url) ? String(data.url) : '/'
          }
        }
      };

      const resp = await admin.messaging().sendEachForMulticast(message);
      successCount += resp.successCount;
      failureCount += resp.failureCount;

      resp.responses.forEach((r, i) => {
        if (!r.success) {
          const code = (r.error && r.error.code) || '';
          if (code.includes('registration-token-not-registered') ||
              code.includes('invalid-registration-token')) {
            invalidTokens.push(chunk[i]);
          }
        }
      });
    }

    // ── Auto-cleanup dead tokens from Realtime DB ──
    if (invalidTokens.length > 0) {
      try {
        const snap = await rtdb.ref('fcm_tokens').once('value');
        const all  = snap.val() || {};
        const updates = {};
        Object.entries(all).forEach(([uid, t]) => {
          if (t && t.token && invalidTokens.includes(t.token)) {
            updates['fcm_tokens/' + uid] = null;
            updates['users/' + uid + '/fcmToken'] = null;
          }
        });
        if (Object.keys(updates).length) {
          await rtdb.ref().update(updates);
          console.log(`Cleaned ${Object.keys(updates).length / 2} dead tokens`);
        }
      } catch (e) {
        console.warn('Token cleanup failed:', e.message);
      }
    }

    console.log(`[send-push] sent=${successCount} failed=${failureCount} invalid=${invalidTokens.length}`);

    res.json({
      success:       true,
      successCount,
      failureCount,
      invalidTokens: invalidTokens.length,
      total:         tokens.length
    });

  } catch (err) {
    console.error('send-push error:', err);
    res.status(500).json({ success: false, error: err.message || 'Send failed' });
  }
});

// ════════════════════════════════════════════════════════════
// EXISTING ENDPOINTS (test app এর জন্য — রেখে দিলাম)
// ════════════════════════════════════════════════════════════

app.post('/send-notification', async (req, res) => {
  const { token, title, body, imageUrl } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'token required' });

  try {
    const t = title || 'Notification';
    const b = body  || '';

    const message = {
      token,
      data: { title: t, body: b, ...(imageUrl ? { imageUrl } : {}) },
      android: { priority: 'high' }
    };

    const msgId = await admin.messaging().send(message);
    res.json({ success: true, messageId: msgId });
  } catch (e) {
    console.error('Send error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/send-all', async (req, res) => {
  const { appId, title, body, imageUrl } = req.body;
  if (!isValidAppId(appId)) return res.status(400).json({ success: false, error: 'valid appId required' });

  try {
    const snap = await devicesRef(appId).get();
    if (snap.empty) return res.json({ success: false, error: 'No tokens found for this app' });

    const tokens = snap.docs.map(d => d.data().token).filter(Boolean);
    const t = title || 'Notification';
    const b = body  || '';
    const messages = tokens.map(token => ({
      token,
      data: { title: t, body: b, ...(imageUrl ? { imageUrl } : {}) },
      android: { priority: 'high' }
    }));

    const result = await admin.messaging().sendEach(messages);
    console.log(`[${appId}] Sent: ${result.successCount} ok, ${result.failureCount} failed`);

    const batch = db.batch();
    let removed = 0;
    result.responses.forEach((r, i) => {
      if (!r.success) { batch.delete(snap.docs[i].ref); removed++; }
    });
    if (removed > 0) await batch.commit();

    res.json({
      success:      true,
      appId,
      total:        tokens.length,
      successCount: result.successCount,
      failureCount: result.failureCount
    });
  } catch (e) {
    console.error('Send-all error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/token', async (req, res) => {
  const { appId, token } = req.query;
  if (!isValidAppId(appId) || !token) return res.status(400).json({ success: false, error: 'appId and token required' });

  try {
    await devicesRef(appId).doc(tokenDocId(token)).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 7860;
app.listen(PORT, () => console.log(`Wevlo Push Server running on port ${PORT}`));
/**
 * 弓道 的中分析アプリ — 課金サーバー
 *
 * AI分析だけ月額500円のサブスクリプションを Stripe で管理する
 * Webhook サーバー。アプリ本体（kyudo.html）とは別プロセスで動く。
 *
 * エンドポイント:
 *   POST /webhook                  Stripe Webhook（署名検証あり）
 *   GET  /create-checkout-session  Checkout Session の作成（?uid=...）
 *   GET  /portal                   Stripe Billing Portal（?uid=... / ?customerId=...）
 *
 * 環境変数:
 *   STRIPE_SECRET_KEY         Stripe のシークレットキー
 *   STRIPE_WEBHOOK_SECRET     Stripe Webhook の署名シークレット
 *   STRIPE_PRICE_ID           月額500円の Price ID
 *   FIREBASE_SERVICE_ACCOUNT  サービスアカウントの JSON 文字列
 *   PORT                      既定 3000
 *   APP_URL                   アプリの公開 URL（成功・キャンセルURL用）
 *
 * 秘密鍵はコードに直書きしないこと。すべて環境変数から読む。
 */

const express = require('express');
const Stripe = require('stripe');
const admin = require('firebase-admin');

// ---- 環境変数の確認（起動時） ----

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error(
    'エラー: 環境変数 FIREBASE_SERVICE_ACCOUNT が設定されていません。\n' +
    'Firebase コンソールで発行したサービスアカウントキー（JSON）の内容を\n' +
    '環境変数 FIREBASE_SERVICE_ACCOUNT に設定してから起動してください。'
  );
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (err) {
  console.error(
    'エラー: 環境変数 FIREBASE_SERVICE_ACCOUNT を JSON として読み取れませんでした。\n' +
    'JSON 文字列が正しいか確認してください。詳細: ' + err.message
  );
  process.exit(1);
}

if (!process.env.STRIPE_SECRET_KEY) {
  console.error(
    'エラー: 環境変数 STRIPE_SECRET_KEY が設定されていません。\n' +
    'Stripe ダッシュボードでシークレットキーを確認し、環境変数に設定してください。'
  );
  process.exit(1);
}

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const APP_URL = process.env.APP_URL || 'https://kyudo-app.onrender.com';
const PORT = process.env.PORT || 3000;

// ---- 初期化 ----

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json());

// ---- ヘルパー ----

/**
 * customer id から members の uid を探す。
 * サブスクリプションの metadata に uid が無い場合のフォールバック。
 * 見つからなければ null を返す。
 */
async function findUidByCustomerId(customerId) {
  const snap = await db
    .collection('members')
    .where('subscription.stripeCustomerId', '==', customerId)
    .limit(1)
    .get();
  if (snap.empty) {
    return null;
  }
  return snap.docs[0].id;
}

/**
 * Stripe イベントを受けて members/{uid} の subscription を更新する。
 * 戻り値: { handled: boolean }（知らないイベントは handled: false）
 */
async function handleWebhookEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const uid = session.metadata && session.metadata.uid;
      if (!uid) {
        console.warn('checkout.session.completed: metadata.uid が無いため処理をスキップします。');
        return { handled: false };
      }

      const subscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription && session.subscription.id;
      let customerId =
        typeof session.customer === 'string'
          ? session.customer
          : session.customer && session.customer.id;
      let currentPeriodEnd = null;

      if (
        session.subscription &&
        typeof session.subscription === 'object' &&
        session.subscription.current_period_end
      ) {
        currentPeriodEnd = session.subscription.current_period_end * 1000;
      } else if (subscriptionId) {
        // Checkout Session には current_period_end が含まれないため、
        // サブスクリプションを取得して期間終了日を読む。
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        if (subscription.current_period_end) {
          currentPeriodEnd = subscription.current_period_end * 1000;
        }
        if (!customerId && subscription.customer) {
          customerId =
            typeof subscription.customer === 'string'
              ? subscription.customer
              : subscription.customer.id;
        }
      }

      await db
        .collection('members')
        .doc(uid)
        .set(
          {
            subscription: {
              plan: 'ai',
              status: 'active',
              currentPeriodEnd: currentPeriodEnd,
              stripeCustomerId: customerId || null,
              updatedAt: Date.now(),
            },
          },
          { merge: true }
        );
      console.log('subscription を active にしました: uid=' + uid);
      return { handled: true };
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const uid =
        (subscription.metadata && subscription.metadata.uid) ||
        (subscription.customer
          ? await findUidByCustomerId(
              typeof subscription.customer === 'string'
                ? subscription.customer
                : subscription.customer.id
            )
          : null);
      if (!uid) {
        console.warn('customer.subscription.updated: uid が特定できないため処理をスキップします。');
        return { handled: false };
      }

      const patch = {
        'subscription.status': subscription.status,
        'subscription.currentPeriodEnd': subscription.current_period_end
          ? subscription.current_period_end * 1000
          : null,
        'subscription.updatedAt': Date.now(),
      };
      try {
        await db.collection('members').doc(uid).update(patch);
      } catch (err) {
        // ドキュメントがまだ無い場合は set（merge）で作る。
        await db
          .collection('members')
          .doc(uid)
          .set(
            {
              subscription: {
                plan: 'ai',
                status: subscription.status,
                currentPeriodEnd: subscription.current_period_end
                  ? subscription.current_period_end * 1000
                  : null,
                stripeCustomerId:
                  typeof subscription.customer === 'string'
                    ? subscription.customer
                    : subscription.customer && subscription.customer.id,
                updatedAt: Date.now(),
              },
            },
            { merge: true }
          );
      }
      console.log(
        'subscription を更新しました: uid=' + uid + ' status=' + subscription.status
      );
      return { handled: true };
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const uid =
        (subscription.metadata && subscription.metadata.uid) ||
        (subscription.customer
          ? await findUidByCustomerId(
              typeof subscription.customer === 'string'
                ? subscription.customer
                : subscription.customer.id
            )
          : null);
      if (!uid) {
        console.warn('customer.subscription.deleted: uid が特定できないため処理をスキップします。');
        return { handled: false };
      }

      try {
        await db
          .collection('members')
          .doc(uid)
          .update({
            'subscription.status': 'inactive',
            'subscription.updatedAt': Date.now(),
          });
      } catch (err) {
        // ドキュメントがまだ無い場合は set（merge）で作る。
        await db
          .collection('members')
          .doc(uid)
          .set(
            {
              subscription: {
                plan: 'ai',
                status: 'inactive',
                stripeCustomerId:
                  typeof subscription.customer === 'string'
                    ? subscription.customer
                    : subscription.customer && subscription.customer.id,
                updatedAt: Date.now(),
              },
            },
            { merge: true }
          );
      }
      console.log('subscription を inactive にしました: uid=' + uid);
      return { handled: true };
    }

    default:
      // 知らないイベントは無視する。
      console.log('無視するイベント: ' + event.type);
      return { handled: false };
  }
}

// ---- エンドポイント ----

// (a) Stripe Webhook。生ボディで署名検証するため express.raw を使う。
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook の署名検証に失敗しました: ' + err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  try {
    await handleWebhookEvent(event);
  } catch (err) {
    console.error('Webhook の処理に失敗しました: ' + err.message);
    return res.status(500).send('Webhook handling failed');
  }
  return res.json({ received: true });
});

// (b) Checkout Session の作成。?uid=<Firebase の uid>
app.get('/create-checkout-session', async (req, res) => {
  const uid = req.query.uid;
  if (!uid) {
    return res.status(400).json({ error: 'uid is required' });
  }
  if (!STRIPE_PRICE_ID) {
    console.error('STRIPE_PRICE_ID が設定されていません。');
    return res.status(500).json({ error: 'STRIPE_PRICE_ID is not configured' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      metadata: { uid: uid },
      subscription_data: { metadata: { uid: uid } },
      success_url: APP_URL + '/?checkout=success',
      cancel_url: APP_URL + '/?checkout=canceled',
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout Session の作成に失敗しました: ' + err.message);
    return res.status(500).json({ error: 'failed to create checkout session' });
  }
});

// (c) Stripe Billing Portal（解約・プラン管理用）。
// ?uid=<Firebase の uid> または ?customerId=<Stripe の customer id>
app.get('/portal', async (req, res) => {
  let customerId = req.query.customerId || req.query.customer || req.query.customer_id;
  const uid = req.query.uid;

  if (!customerId && !uid) {
    return res.status(400).json({ error: 'uid or customerId is required' });
  }

  try {
    if (!customerId) {
      const doc = await db.collection('members').doc(uid).get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'member not found' });
      }
      const data = doc.data() || {};
      customerId =
        data.subscription && data.subscription.stripeCustomerId;
      if (!customerId) {
        return res
          .status(400)
          .json({ error: 'no stripe customer id for this member' });
      }
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: APP_URL,
    });
    return res.json({ url: portalSession.url });
  } catch (err) {
    console.error('Billing Portal の作成に失敗しました: ' + err.message);
    return res.status(500).json({ error: 'failed to create portal session' });
  }
});

// ---- 起動（require されたときは起動しない。テスト用） ----

if (require.main === module) {
  app.listen(PORT, () => {
    console.log('課金サーバーが起動しました: port=' + PORT + ' app=' + APP_URL);
  });
}

module.exports = { app, handleWebhookEvent, findUidByCustomerId, db, stripe };

/**
 * Webhook サーバーの単体テスト。
 *
 * stripe / firebase-admin / express は require の仕組み（Module._load）を
 * 差し替えてモックするため、本物のパッケージのインストールは不要。
 * node だけで実行できる。
 *
 * 実行方法:
 *   node test/webhook.test.js
 */

'use strict';

// ---- 環境変数（server.js を読む前に設定する。値はすべてダミー） ----
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
process.env.STRIPE_PRICE_ID = 'price_dummy';
process.env.APP_URL = 'https://kyudo-app.onrender.com';
process.env.PORT = '3000';
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  projectId: 'test-project',
  clientEmail: 'test@test-project.iam.gserviceaccount.com',
  privateKey: '-----BEGIN PRIVATE KEY-----\nMIIFAKEKEY\n-----END PRIVATE KEY-----\n',
});

// ---- モック ----

const Module = require('module');
const origLoad = Module._load;

// Firestore モックへの呼び出し記録
const firestoreCalls = [];
// Stripe モックへの呼び出し記録
const stripeCalls = [];

const mockDb = {
  collection: (name) => ({
    doc: (id) => ({
      set: async (data, options) => {
        firestoreCalls.push({ op: 'set', collection: name, id, data, options });
      },
      update: async (data) => {
        firestoreCalls.push({ op: 'update', collection: name, id, data });
      },
      get: async () => ({
        exists: true,
        data: () => ({
          subscription: {
            plan: 'ai',
            status: 'active',
            currentPeriodEnd: 1780000000000,
            stripeCustomerId: 'cus_test_123',
          },
        }),
      }),
    }),
    where: () => ({
      limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      get: async () => ({ empty: true, docs: [] }),
    }),
  }),
};

const mockAdmin = {
  initializeApp: () => {},
  credential: { cert: (obj) => ({ __cert: obj }) },
  firestore: () => mockDb,
};

const mockStripeClient = {
  checkout: {
    sessions: {
      create: async (params) => {
        stripeCalls.push({ op: 'checkout.create', params });
        return { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' };
      },
    },
  },
  billingPortal: {
    sessions: {
      create: async (params) => {
        stripeCalls.push({ op: 'portal.create', params });
        return { id: 'bps_test_123', url: 'https://billing.stripe.com/p/session/test_123' };
      },
    },
  },
  subscriptions: {
    retrieve: async (id) => ({
      id,
      current_period_end: 1780000000,
      customer: 'cus_test_123',
      status: 'active',
    }),
  },
  webhooks: {
    constructEvent: (rawBody, sig, secret) => {
      if (sig !== 'valid-signature') {
        throw new Error('No signatures found matching the expected signature version for payload');
      }
      return JSON.parse(rawBody.toString());
    },
  },
};

function mockStripeFactory() {
  return mockStripeClient;
}

// express モック：ルートハンドラを記録するだけの最小実装
let capturedApp = null;
function mockExpress() {
  capturedApp = {
    routes: {},
    use: () => {},
    post: function (path, ...handlers) {
      this.routes['POST ' + path] = handlers[handlers.length - 1];
    },
    get: function (path, ...handlers) {
      this.routes['GET ' + path] = handlers[handlers.length - 1];
    },
    listen: () => {},
  };
  return capturedApp;
}
mockExpress.raw = () => (req, res, next) => {
  if (typeof next === 'function') next();
};
mockExpress.json = () => (req, res, next) => {
  if (typeof next === 'function') next();
};

Module._load = function (request, parent, isMain) {
  if (request === 'express') return mockExpress;
  if (request === 'stripe') return mockStripeFactory;
  if (request === 'firebase-admin') return mockAdmin;
  return origLoad.apply(this, arguments);
};

// ---- server.js を読む（モックが差し替わった状態で） ----
require('../server.js');

const webhookHandler = capturedApp.routes['POST /webhook'];
const createCheckoutHandler = capturedApp.routes['GET /create-checkout-session'];
const portalHandler = capturedApp.routes['GET /portal'];

// ---- テスト用ヘルパー ----

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
  return res;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function invokeWebhook(event, signature) {
  const req = {
    body: Buffer.from(JSON.stringify(event)),
    headers: { 'stripe-signature': signature },
  };
  const res = makeRes();
  await webhookHandler(req, res);
  return res;
}

// ---- テスト ----

const results = [];

async function runTest(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('PASS: ' + name);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log('FAIL: ' + name + ' — ' + err.message);
  }
}

async function main() {
  assert(typeof webhookHandler === 'function', 'POST /webhook のハンドラが登録されていません');
  assert(typeof createCheckoutHandler === 'function', 'GET /create-checkout-session のハンドラが登録されていません');
  assert(typeof portalHandler === 'function', 'GET /portal のハンドラが登録されていません');

  // (1) 正しい署名の checkout.session.completed で subscription が active になる
  await runTest('(1) checkout.session.completed で subscription が active になる', async () => {
    firestoreCalls.length = 0;
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_123',
          metadata: { uid: 'user-123' },
          subscription: 'sub_test_123',
          customer: 'cus_test_123',
        },
      },
    };
    const res = await invokeWebhook(event, 'valid-signature');
    assert(res.statusCode === 200, 'ステータスが 200 ではありません: ' + res.statusCode);

    const setCall = firestoreCalls.find(
      (c) => c.op === 'set' && c.collection === 'members' && c.id === 'user-123'
    );
    assert(setCall, 'members/user-123 への set が呼ばれていません: ' + JSON.stringify(firestoreCalls));
    assert(setCall.options && setCall.options.merge === true, 'set に { merge: true } が付いていません');
    const sub = setCall.data.subscription;
    assert(sub, 'subscription が書き込まれていません');
    assert(sub.plan === 'ai', 'plan が ai ではありません: ' + sub.plan);
    assert(sub.status === 'active', 'status が active ではありません: ' + sub.status);
    assert(
      sub.currentPeriodEnd === 1780000000 * 1000,
      'currentPeriodEnd が current_period_end×1000 ではありません: ' + sub.currentPeriodEnd
    );
    assert(sub.stripeCustomerId === 'cus_test_123', 'stripeCustomerId が正しくありません: ' + sub.stripeCustomerId);
    assert(typeof sub.updatedAt === 'number' && sub.updatedAt > 0, 'updatedAt がミリ秒の数値ではありません');
  });

  // (2) customer.subscription.deleted で status が inactive になる
  await runTest('(2) customer.subscription.deleted で status が inactive になる', async () => {
    firestoreCalls.length = 0;
    const event = {
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_test_123',
          metadata: { uid: 'user-123' },
          customer: 'cus_test_123',
          status: 'canceled',
        },
      },
    };
    const res = await invokeWebhook(event, 'valid-signature');
    assert(res.statusCode === 200, 'ステータスが 200 ではありません: ' + res.statusCode);

    const updateCall = firestoreCalls.find(
      (c) => c.op === 'update' && c.collection === 'members' && c.id === 'user-123'
    );
    assert(updateCall, 'members/user-123 への update が呼ばれていません: ' + JSON.stringify(firestoreCalls));
    assert(
      updateCall.data['subscription.status'] === 'inactive',
      "subscription.status が inactive ではありません: " + JSON.stringify(updateCall.data)
    );
    assert(
      typeof updateCall.data['subscription.updatedAt'] === 'number',
      'subscription.updatedAt が更新されていません'
    );
  });

  // (3) 署名が不正なとき 400 になる
  await runTest('(3) 署名が不正なとき 400 になる', async () => {
    firestoreCalls.length = 0;
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_123',
          metadata: { uid: 'user-123' },
          subscription: 'sub_test_123',
          customer: 'cus_test_123',
        },
      },
    };
    const res = await invokeWebhook(event, 'invalid-signature');
    assert(res.statusCode === 400, 'ステータスが 400 ではありません: ' + res.statusCode);
    assert(firestoreCalls.length === 0, '署名不正なのに Firestore への書き込みがありました');
  });

  // (4) 知らないイベントは 200 で無視される
  await runTest('(4) 知らないイベントは 200 で無視される', async () => {
    firestoreCalls.length = 0;
    const event = { type: 'payment_intent.succeeded', data: { object: { id: 'pi_test_123' } } };
    const res = await invokeWebhook(event, 'valid-signature');
    assert(res.statusCode === 200, 'ステータスが 200 ではありません: ' + res.statusCode);
    assert(firestoreCalls.length === 0, '知らないイベントなのに Firestore への書き込みがありました');
  });

  // (5) GET /create-checkout-session が URL を返す。uid が無いときは 400
  await runTest('(5) /create-checkout-session が metadata.uid 付きで URL を返す', async () => {
    stripeCalls.length = 0;
    const req = { query: { uid: 'user-123' } };
    const res = makeRes();
    await createCheckoutHandler(req, res);
    assert(res.statusCode === 200, 'ステータスが 200 ではありません: ' + res.statusCode);
    assert(
      res.body && typeof res.body.url === 'string' && res.body.url.indexOf('https://checkout.stripe.com/') === 0,
      'Checkout の URL が返されていません: ' + JSON.stringify(res.body)
    );
    const createCall = stripeCalls.find((c) => c.op === 'checkout.create');
    assert(createCall, 'Stripe の checkout.sessions.create が呼ばれていません');
    assert(createCall.params.mode === 'subscription', 'mode が subscription ではありません');
    assert(createCall.params.line_items[0].price === 'price_dummy', 'Price ID が正しくありません');
    assert(createCall.params.metadata.uid === 'user-123', 'metadata.uid が正しくありません');
    assert(
      typeof createCall.params.success_url === 'string' &&
        createCall.params.success_url.indexOf('https://kyudo-app.onrender.com') === 0,
      'success_url がアプリの URL ではありません: ' + createCall.params.success_url
    );
    assert(
      typeof createCall.params.cancel_url === 'string' &&
        createCall.params.cancel_url.indexOf('https://kyudo-app.onrender.com') === 0,
      'cancel_url がアプリの URL ではありません: ' + createCall.params.cancel_url
    );

    // uid が無いときは 400
    const res2 = makeRes();
    await createCheckoutHandler({ query: {} }, res2);
    assert(res2.statusCode === 400, 'uid 無しのとき 400 ではありません: ' + res2.statusCode);
  });

  // (6) GET /portal が保存済みの customer id から Portal の URL を返す
  await runTest('(6) /portal が保存済みの customer id から URL を返す', async () => {
    stripeCalls.length = 0;
    const req = { query: { uid: 'user-123' } };
    const res = makeRes();
    await portalHandler(req, res);
    assert(res.statusCode === 200, 'ステータスが 200 ではありません: ' + res.statusCode);
    assert(
      res.body && typeof res.body.url === 'string' && res.body.url.indexOf('https://billing.stripe.com/') === 0,
      'Portal の URL が返されていません: ' + JSON.stringify(res.body)
    );
    const portalCall = stripeCalls.find((c) => c.op === 'portal.create');
    assert(portalCall, 'Stripe の billingPortal.sessions.create が呼ばれていません');
    assert(portalCall.params.customer === 'cus_test_123', 'customer id が正しくありません: ' + portalCall.params.customer);
  });

  const passed = results.filter((r) => r.ok).length;
  console.log('\n結果: ' + passed + '/' + results.length + ' 件成功');
  if (passed !== results.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('テストの実行に失敗しました: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});

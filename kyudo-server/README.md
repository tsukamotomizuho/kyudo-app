# 弓道 的中分析アプリ — 課金サーバー

AI分析だけ月額500円のサブスクリプションを Stripe で管理する Webhook サーバーです。
アプリ本体（`kyudo.html`）とは別のプロセスで動きます。

## 仕組み

- ユーザーがアプリから `GET /create-checkout-session?uid=...` を呼ぶと、月額500円の
  Checkout Session を作り、決済ページの URL を返します。
- 決済が完了すると Stripe が `POST /webhook` を呼び、サーバーが
  `members/{uid}` の `subscription` を `active` に更新します。
- 解約・プラン管理は `GET /portal?uid=...` が返す Stripe Billing Portal で行います。
- `subscription` はサーバー（Admin SDK）だけが書けます。クライアントが自分で
  書き換えられないよう、`firestore.rules` で `subscription` の変更を禁止しています。

## エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/webhook` | Stripe Webhook。署名検証（`STRIPE_WEBHOOK_SECRET`）を行い、`checkout.session.completed` / `customer.subscription.updated` / `customer.subscription.deleted` を処理します。署名が不正なときは 400、知らないイベントは 200 で無視します。 |
| GET | `/create-checkout-session?uid=...` | 月額500円の Price で Checkout Session を作り、`{ "url": "..." }` を返します。`uid` が無いときは 400 です。作成したセッションの `metadata` に `uid` を入れます。 |
| GET | `/portal?uid=...` または `?customerId=...` | Stripe Billing Portal のセッションを作り、`{ "url": "..." }` を返します。`uid` だけの場合は `members/{uid}` から `subscription.stripeCustomerId` を読みます。 |

### `members/{uid}` の `subscription` の形

```json
{
  "plan": "ai",
  "status": "active",
  "currentPeriodEnd": 1780000000000,
  "stripeCustomerId": "cus_xxxx",
  "updatedAt": 1763430000000
}
```

- `checkout.session.completed`：上記の形で `status: "active"` にします。
- `customer.subscription.updated`：`status` と `currentPeriodEnd` を更新します。
- `customer.subscription.deleted`：`status` を `"inactive"` にします。

## 環境変数

| 変数名 | 必須 | 説明 |
|---|---|---|
| `STRIPE_SECRET_KEY` | 必須 | Stripe のシークレットキー（`sk_live_...` / テスト用は `sk_test_...`）。 |
| `STRIPE_WEBHOOK_SECRET` | 必須 | Stripe Webhook の署名シークレット（`whsec_...`）。Webhook エンドポイント登録時に表示されます。 |
| `STRIPE_PRICE_ID` | 必須 | 月額500円の Price ID（`price_...`）。 |
| `FIREBASE_SERVICE_ACCOUNT` | 必須 | Firebase サービスアカウントキーの JSON 文字列。無いと起動時にエラーを出して終了します。 |
| `PORT` | 任意 | 待ち受けるポート。既定は `3000`。Render では Render が設定する `PORT` を使います。 |
| `APP_URL` | 任意 | アプリの公開 URL。成功・キャンセルURL、Portal の戻り先に使います。既定は `https://kyudo-app.onrender.com`。 |

秘密鍵・シークレットをコードに直書きしないでください。すべて環境変数で渡します。
以下の例の値はすべてプレースホルダです。

## Render へのデプロイ手順

1. このフォルダ（`server.js`・`package.json`・`README.md`）を GitHub リポジトリに
   入れます（アプリ本体と同じリポジトリでかまいません。`kyudo-server/` 以下に置きます）。
2. Render のダッシュボードで「New +」→「Web Service」を選び、リポジトリを選びます。
3. 設定は次のようにします。
   - **Root Directory**：`kyudo-server`
   - **Runtime**：`Node`
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Instance Type**：無料枠の `Free` でかまいません（15分無アクセスでスリープします）。
4. 「Environment Variables」で上記の環境変数を設定します。
   - `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`STRIPE_PRICE_ID`、
     `FIREBASE_SERVICE_ACCOUNT`（JSON 全文を1行の文字列として貼り付けます）、
     `APP_URL`（`https://kyudo-app.onrender.com`）。
   - `PORT` は Render が自動で設定するので、設定しなくてかまいません。
5. 「Create Web Service」を押すとデプロイが始まります。ログに
   `課金サーバーが起動しました` と出れば成功です。
   公開 URL（例：`https://kyudo-server-xxxx.onrender.com`）を控えます。

## Stripe 側の設定

### 1. 商品・Price の作成

1. Stripe ダッシュボード →「商品」→「商品を作成」を開きます。
2. 商品名は例：`AI分析プラン`、説明は例：`弓道 的中分析アプリの AI 分析（月額）`。
3. 価格は「定期支払い」、金額 `500` 円、請求期間「毎月」で作成します。
4. 作成した Price の ID（`price_...`）を控え、`STRIPE_PRICE_ID` に設定します。

### 2. Webhook エンドポイントの登録とシークレットの取得

1. Stripe ダッシュボード →「開発者」→「Webhook」→「エンドポイントを追加」を開きます。
2. エンドポイント URL に Render の公開 URL + `/webhook` を入力します。
   例：`https://kyudo-server-xxxx.onrender.com/webhook`
3. リッスンするイベントで次を選びます。
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. 作成後に表示される「署名シークレット」（`whsec_...`）を控え、
   `STRIPE_WEBHOOK_SECRET` に設定します。

### 3. テストモードでの確認手順

1. Stripe をテストモードにし、テスト用のキー（`sk_test_...`）と
   テスト用の Price（`price_...`）を作って環境変数に設定します。
2. テスト用のカード番号 `4242 4242 4242 4242`（有効期限は未来の日付、CVC は任意の3桁）
   でアプリから Checkout を開き、決済を完了します。
3. Firestore の `members/{uid}` の `subscription.status` が `active` になれば成功です。
4. Stripe ダッシュボードのテストモードでサブスクリプションをキャンセルし、
   `subscription.status` が `inactive` になることを確認します。
5. 確認が終わったら本番モードのキー・Price・Webhook シークレットに置き換え、
   Render の環境変数を更新して再デプロイします。

## ローカルでの起動

```sh
cd kyudo-server
npm install
STRIPE_SECRET_KEY=sk_test_xxx \
STRIPE_WEBHOOK_SECRET=whsec_xxx \
STRIPE_PRICE_ID=price_xxx \
FIREBASE_SERVICE_ACCOUNT='{"projectId":"...","clientEmail":"...","privateKey":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"}' \
APP_URL=https://kyudo-app.onrender.com \
npm start
```

## テスト

Stripe・Firebase Admin はモックに差し替えるため、本物のパッケージの
インストールは不要で、`node` だけで実行できます。

```sh
node test/webhook.test.js
```

確認する内容：

1. 正しい署名の `checkout.session.completed` で `members/{uid}` の
   `subscription` が `active` になること。
2. `customer.subscription.deleted` で `status` が `inactive` になること。
3. 署名が不正なとき 400 になること。
4. 知らないイベントは 200 で無視されること。
5. `GET /create-checkout-session` が `metadata.uid` 付きのセッションを作り、URL を返すこと。
6. `GET /portal` が保存済みの customer id から Portal の URL を返すこと。

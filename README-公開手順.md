# 弓道アプリ — git + Render で Web 公開する手順

このフォルダの中身をそのまま GitHub に上げて、Render につなぐと公開できます。
無料枠でできます。

## フォルダの中身
- `index.html` … 弓道アプリ本体（`kyudo.html` を `index.html` にしたもの）
- `render.yaml` … Render 用の設定（Static Site）
- `firestore.rules` … Firestore のルール（参考・保管用。Render には使いません）

## 0. 公開前にやること（大事）
`index.html` の中のこの部分を探してください：

```js
const DEFAULT_FIREBASE_CONFIG=null;
```

このまま公開すると、開いた人は自分の端末で firebaseConfig を
貼らないと Firestore につながりません。
部員みんなが貼り付けなしで使えるようにするには、こう書き換えます：

```js
const DEFAULT_FIREBASE_CONFIG={apiKey:"...",authDomain:"....firebaseapp.com",projectId:"...",storageBucket:"....appspot.com",messagingSenderId:"...",appId:"1:...:web:..."};
```

`...` の部分は、Firebase コンソールでコピーした自分の firebaseConfig です。
※ Firebase のウェブ用 apiKey は公開用の識別子で、パスワードではありません。
データの保護は Firestore のルール（`firestore.rules` を適用済みのもの）と
匿名ログインで行います。apiKey だけでは他人の記録は書き換えられません。

書き換えなくても公開はできます。その場合は、開いた人それぞれが
アプリ内の「🔥 Firebaseで共有する」欄に config を貼る必要があります。

## 1. GitHub に上げる
1. https://github.com/ で新しいリポジトリを作る（名前は例：`kyudo-app`、Public でOK）
2. このフォルダの中身（`index.html`、`render.yaml`）をアップロードする
   - 「Add file → Upload files」からドラッグ＆ドロップでOK（git コマンド不要）
   - git を使う場合は、フォルダで以下を実行：
     ```
     git init
     git add index.html render.yaml
     git commit -m "弓道アプリを公開"
     git branch -M main
     git remote add origin https://github.com/（自分のユーザー名）/kyudo-app.git
     git push -u origin main
     ```

## 2. Render につなぐ
1. https://render.com/ を開いて、GitHub アカウントでサインイン（無料）
2. ダッシュボードで「New +」→「Static Site」を選ぶ
3. GitHub のリポジトリ `kyudo-app` を選ぶ
4. 設定はこうなっていることを確認する：
   - Name：`kyudo-app`
   - Branch：`main`
   - Build Command：（空欄のまま）
   - Publish Directory：`./`（または空欄）
   - `render.yaml` がある場合は、自動でこの設定が読み込まれます
5. 「Create Static Site」を押す
6. 数十秒〜数分待つと、`https://kyudo-app.onrender.com` のような URL が発行されます

## 3. 公開後の確認
1. 発行された URL を開く
2. 記録タブで的をタップして記録できるか確認する
3. ランキングタブで「Firestore（kyudo-app-e13ad）に接続中」と出ていればOK
   - 出ていない場合は、`DEFAULT_FIREBASE_CONFIG` の書き換え忘れか、
     Firebase 側で匿名ログインが有効になっていないかを確認する
4. その URL を部員に共有する

## 更新したいとき
- `index.html` を修正 → GitHub に上げ直す（アップロード or `git push`）
- Render は自動で再デプロイします（数分待つ）

## 注意
- 無料プランの Static Site は、しばらくアクセスがないと最初の表示が
  少し遅くなることがあります（スリープ）。部活で使う分には問題ありません。
- 動画は各端末のブラウザ内にだけ保存され、Firestore には送られません。
  公開しても動画が他の人に見えることはありません。

# LINEミニアプリ ゲームテンプレート（広告収益モデル）

LIFF v2 上で動く、広告収益前提のゲーム用ボイラープレート。外部ライブラリ依存なし。

## 構成

```
index.html          レイアウト。ゲーム領域と広告枠を分離してある
css/style.css       セーフエリア対応、広告枠の高さ予約（CLS対策）
js/config.js        LIFF ID・広告設定。最初にここを埋める
js/liff-boot.js     liff.init と実行環境判定。最後に読み込まれる
js/ads.js           広告スロット管理。タグ未発行でも動く
js/game.js          ゲームのライフサイクル。update()/draw() を書き換えて使う
```

スクリプトはすべて `defer`。記述順に実行されるので
`sdk.js → config → ads → game → liff-boot` の順で依存が解決される。

## セットアップ

1. LINE Developersコンソールでミニアプリチャネルを作成
2. `js/config.js` の `LIFF_ID_BY_HOST` に、開発用 / 審査用 / 本番用それぞれの
   エンドポイントURLのホスト名と LIFF ID を対応させて記入
3. HTTPSで配信（審査前・審査中はベーシック認証をかけてよい）
4. Tester権限のアカウントで開発用チャネルのLIFF URLを開いて確認

## 広告を有効化する

広告タグはネットワークパートナー契約とサイト審査の通過後に発行される。
それまでは `config.ads.tagSrc` を空のままにしておけば、枠だけ確保して
広告なしで動く。

1. [説明資料](https://www.lycbiz.com/sites/default/files/media/jp/download/JP_LINE_Ad_Network_ProductGuide_Publisher-Partner.pdf)を確認
2. [LINEヤフー広告ネットワーク（パブリッシャー向け）](https://www.lycbiz.com/jp/partner/adnetwork/ly-ads/)から申し込み
3. ネットワークパートナーツールでミニアプリをサイト審査に提出
4. 発行された広告タグの URL を `config.ads.tagSrc` に設定
5. `js/ads.js` の `render()` 内、コメントで示した1行にタグの表示処理を書く
6. 実サイズに合わせて `css/style.css` の `--ad-banner-height` を調整

掲載できるのは **LINEヤフー広告ネットワーク ディスプレイ広告（Web）のみ**。
他のアドネットワークはポリシー違反になる。サービス提供地域は日本限定。

## このテンプレートが守っている制約

| 制約 | 対応箇所 |
|---|---|
| Lighthouse Performance 50以上 | 外部ライブラリなし、全スクリプト `defer`、広告タグは初回描画後に遅延読み込み |
| セーフエリア（横向き 左右44px / 下21px） | `css/style.css` の `@media (orientation: landscape)` |
| チャネル同意の簡略化 | 初期スコープを `openid` のみに限定。`getProfile()` は使う画面まで遅延 |
| 外部ブラウザ対応（2025-10-01〜） | `liff.isInClient()` で分岐、`withLoginOnExternalBrowser: true` |
| カスタムアクションボタン規定 | `shareResult()` は bubble のみ / ボタン1つ / primary のみ |
| 広告でユーザーを閉じ込めない | インタースティシャルは最短表示後に必ず閉じられる |

## まだ入っていないもの（実装時に追加する）

- **退会時の権限取消**（必須要件）。サーバー側で権限取消エンドポイントを叩き、
  その旨を利用規約に記載する
- サーバー側のスコア保存・ランキング
- サービスメッセージ送信（サーバー側APIから。広告的な内容は送れない）
- アイコン（背景130×130px / ロゴ54〜90px / PNG・JPEG）

## 参考

- [LINEミニアプリ ドキュメント](https://developers.line.biz/ja/docs/line-mini-app/)
- [LINEミニアプリに広告を掲載する](https://developers.line.biz/ja/docs/line-mini-app/service/line-mini-app-ads/)
- [LINEミニアプリポリシー](https://terms2.line.me/LINE_MINI_App?lang=ja)

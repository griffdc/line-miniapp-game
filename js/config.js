/**
 * アプリ全体の設定。
 *
 * LINEミニアプリのチャネルは内部で「開発用 / 審査用 / 本番用」の3つに分かれ、
 * それぞれ別の LIFF ID と別のエンドポイントURLを持つ。
 * このファイルは「今どの環境で動いているか」を判定して LIFF ID を選ぶ。
 */
(function () {
  'use strict';

  /**
   * LIFF ID は、コンソールの「LIFF URL」からドメインを除いた部分。
   *   https://miniapp.line.me/2011455375-ycLfjOvl
   *                           ~~~~~~~~~~~~~~~~~~~ これが LIFF ID
   *
   * @type {Record<'development'|'review'|'production', string>}
   */
  var LIFF_IDS = {
    development: '2011455375-ycLfjOvl',
    review:      '2011455376-eBrPW4pe',
    production:  '2011455377-8BgjdROz'
  };

  /**
   * エンドポイントURL（＝このファイルを配信しているURL）から環境を判定する。
   * キーは LIFF URL ではなく、コンソールの「エンドポイントURL」に設定した
   * 自分のホスティング先のホスト名であることに注意。
   *
   * @type {Record<string, keyof LIFF_IDS>}
   */
  var ENV_BY_HOST = {
    'localhost': 'development',
    '127.0.0.1': 'development'
    // 例: 環境ごとにホストを分ける場合はここに追加する
    // 'dev.example.com': 'development',
    // 'review.example.com': 'review',
    // 'game.example.com': 'production'
  };

  /**
   * 3環境を同じホストに置く場合のパス判定。
   * 例: https://example.com/dev/  https://example.com/review/  https://example.com/
   *
   * @type {Array<[RegExp, keyof LIFF_IDS]>}
   */
  var ENV_BY_PATH = [
    [/^\/dev(\/|$)/, 'development'],
    [/^\/review(\/|$)/, 'review']
  ];

  function resolveEnvironment() {
    // ① ビルド時に注入された値を最優先（Vite なら import.meta.env、
    //    静的ホスティングなら index.html にインラインで window.__ENV__ を書く）
    if (window.__ENV__ && LIFF_IDS[window.__ENV__]) return window.__ENV__;

    // ② パスで判定
    for (var i = 0; i < ENV_BY_PATH.length; i++) {
      if (ENV_BY_PATH[i][0].test(location.pathname)) return ENV_BY_PATH[i][1];
    }

    // ③ ホスト名で判定
    if (ENV_BY_HOST[location.hostname]) return ENV_BY_HOST[location.hostname];

    // ④ GitHub Pages は動作確認用とみなす。
    //    本番を Pages で運用する場合はこのブロックを消すこと。
    if (/\.github\.io$/.test(location.hostname)) return 'development';

    // ⑤ 該当なしは本番扱い（誤って開発用IDで公開されるより安全）
    return 'production';
  }

  var environment = resolveEnvironment();

  function resolveLiffId() {
    return LIFF_IDS[environment] || '';
  }

  window.APP_CONFIG = {
    environment: environment,
    liffId: resolveLiffId(),

    /**
     * 初期スコープは openid のみに絞る。
     * 認証済ミニアプリ + LIFF v2.13.x 以降 + openid のみ の条件を満たすと
     * チャネル同意画面が省略され、起動離脱が減る。
     * profile / chat_message.write が要るなら、必要になった画面で
     * liff.permission.requestAll() を呼んで後から要求する。
     */
    initialScopes: ['openid'],

    /**
     * 外部ブラウザで開かれたとき、初期化と同時にログインさせるか。
     *
     * false 推奨。true にすると起動直後に LINE の認証画面へリダイレクトするため、
     *  - 開発中はブラウザで画面を確認できない
     *    （チャネルが「開発中」だと 400 Bad Request になる）
     *  - LINEアカウントを持たないユーザーを門前払いしてしまう
     * 広告収益は到達ユーザー数に比例するので、ログインは
     * スコア保存やシェアなど「本当に必要になった時点」で求める。
     */
    loginOnExternalBrowser: false,

    ads: {
      /**
       * サイト審査通過後に LINEヤフー広告ネットワークの管理ツールから
       * 発行される広告タグの URL をここに入れる。
       * 空のままなら広告は読み込まれず、枠だけが確保される（開発時の既定）。
       */
      tagSrc: '',

      /** 広告スクリプトの読み込みを遅らせるミリ秒。初回描画を優先するため。 */
      loadDelayMs: 1200,

      /** ラウンド終了何回ごとにインタースティシャルを出すか */
      interstitialEveryRounds: 3,

      /** インタースティシャルの最短表示時間（ms）。これ未満では閉じさせない */
      interstitialMinVisibleMs: 1000
    },

    /** localStorage のキー接頭辞 */
    storagePrefix: 'miniapp-game:'
  };
})();

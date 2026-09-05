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
    // ① エンドポイントURLの ?env= を最優先。
    //    3環境を同じ配信先に置く場合、これが唯一の確実な判別手段。
    //    コンソールの各エンドポイントURLに付けておく:
    //      開発用 .../?env=development
    //      審査用 .../?env=review
    //      本番用 .../?env=production
    //    エンドポイントURLのクエリパラメータはLIFFのリダイレクト後も保持される。
    var m = /[?&]env=(development|review|production)\b/.exec(location.search);
    if (m) return m[1];

    // ② ビルド時に注入された値（Vite なら import.meta.env、
    //    静的ホスティングなら index.html にインラインで window.__ENV__ を書く）
    if (window.__ENV__ && LIFF_IDS[window.__ENV__]) return window.__ENV__;

    // ③ パスで判定
    for (var i = 0; i < ENV_BY_PATH.length; i++) {
      if (ENV_BY_PATH[i][0].test(location.pathname)) return ENV_BY_PATH[i][1];
    }

    // ④ ホスト名で判定
    if (ENV_BY_HOST[location.hostname]) return ENV_BY_HOST[location.hostname];

    // ⑤ 該当なしは本番扱い。
    //    ここを「開発用」に倒してはいけない。開発用チャネルは「開発中」ステータスなので、
    //    開発者ロールを持たない一般ユーザーは起動できなくなる。
    return 'production';
  }

  var environment = resolveEnvironment();

  function resolveLiffId() {
    return LIFF_IDS[environment] || '';
  }

  /**
   * LIFF を通さずにゲームだけ起動するモード。
   * ローカルプレビューでは liff.init がチャネルのエンドポイントURLと一致せず
   * 失敗するため、localhost と file:// では自動的にこちらへ倒す。
   * 本番ホストで誤って有効にならないよう、明示指定は ?standalone=1 のみ受け付ける。
   */
  function resolveStandalone() {
    if (/[?&]standalone=1\b/.test(location.search)) return true;
    if (location.protocol === 'file:') return true;
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  window.APP_CONFIG = {
    environment: environment,
    standalone: resolveStandalone(),
    liffId: resolveLiffId(),

    /**
     * 外部に配る用のリンク。シェアメッセージなどに使う。
     * 配信先URLではなく本番用のLIFF URLを渡すこと。
     * 配信先URLを直接開くとLIFFとして起動せず、機能が揃わない。
     */
    permanentLink: 'https://miniapp.line.me/' + LIFF_IDS.production,

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

      /**
       * リトライ何回ごとにインタースティシャルを出すか。
       * 1 = 毎回。0 にすると出さない。
       *
       * 表示するのはゲームオーバー時ではなく「もう一度」を押した時。
       * 結果を見る前に挟むと、何点だったか分からないまま待たされる。
       */
      interstitialEveryRounds: 1,

      /** インタースティシャルの最短表示時間（ms）。これ未満では閉じさせない */
      interstitialMinVisibleMs: 1000
    },

    /** localStorage のキー接頭辞 */
    storagePrefix: 'miniapp-game:',

    /**
     * ゲームのチューニング値。手触りはすべてここで決まる。
     * 絵ではなくこの数値を触って「気持ちよさ」を作る。
     */
    game: {
      // --- 物理
      //
      // ★ この3つの数値は実測で決めている。安易に変えないこと。
      //
      // gravity: 1.2 だと Matter のソルバーが12段前後で破綻し、
      //   「同一サイズをブレなしで真ん中に積む」という絶対に倒れないはずの
      //   条件ですら塔が吹き飛ぶ。0.6 にすると 8/8 で完走する。
      //   反復回数を4倍にしても解決しなかった（衝突エネルギー側の問題）。
      // chamferRatio: 0.34 だと角が丸すぎて接触が点になり、摩擦が効かず転がる。
      //   0.12 で平面接触になり安定する。
      // frictionAir は着地後の揺り戻しを収束させるために必要。
      gravity: 0.6,
      friction: 0.9,        // 低いと滑って崩れる
      frictionStatic: 1.0,
      frictionAir: 0.03,    // 着地後の微振動を減衰させる
      // ゼリーらしく少し弾む。単体では簡単になるが（跳ねて収まる）、
      // 下の shake と組み合わせると揺れを増幅して崩れやすくなる。
      restitution: 0.3,
      density: 0.0012,
      chamferRatio: 0.12,   // 角の丸め。大きいほどゼリーらしいが転がって崩れる

      // --- 土台。壁は置かない（落ちたら終了が唯一の失敗条件）
      // 幅は背景画像の皿に合わせる（background.plateWidth）。
      // ※ 幅を変えても難易度はほとんど変わらない（0.62→0.42 で平均11.6→11.5）。
      //    塔は中心に積まれるので、幅は倒れ始めてからしか効かない。
      platformThickness: 24,
      fallLimitY: 420,      // 地面(y=0)よりこれだけ下に落ちたら崩壊とみなす

      // --- カメラ
      groundScreenMargin: 120,  // 地面を画面下からどれだけ上に置くか
      cameraHeadroom: 0.42,     // 塔の先端を画面のどのあたりに保つか
      cameraLerp: 0.08,         // 追従の緩さ。速いと積む位置を見失う

      // --- 操作
      dropperScreenY: 70,
      dropperEdgeMargin: 40,
      dropCooldownMs: 380,

      // --- 表示
      pxPerCm: 10,

      /**
       * 背景画像。皿の上面が物理の土台（world y = 0）に重なるように描く。
       * カメラと一緒にスクロールするので、皿は本当に地面として振る舞う。
       *
       * 数値は img/game-bg.jpg を実測したもの。画像を差し替えたら測り直すこと。
       *   groundY    皿の上面が画像の高さの何割の位置にあるか
       *   plateWidth 物を載せられる幅が画像の幅の何割か
       */
      background: {
        src: './img/game-bg.jpg',
        width: 900, height: 1599, // 読み込み前でもレイアウトを決められるように持つ
        groundY: 0.757,
        plateWidth: 0.82,
        skyColor: '#65c5fd',   // 画像より上を塗る（塔が伸びると見える）
        floorColor: '#d8c9a3'  // 画像より下を塗る
      },

      /**
       * ぷるぷる変形（描画のみ。物理には影響しない）。
       * 手触りはここの数値で決まる。物理パラメータと違って自由に触ってよい。
       */
      wobble: {
        points: 16,              // 輪郭のサンプル数。増やすと滑らかだが重い
        renderChamferRatio: 0.34, // 描画用の丸め。物理(0.12)より大きくして柔らかく見せる
        renderScale: 1.08,       // 物理より少し大きく描く。積んだとき隙間が空かない
        stiffness: 0.055,        // 復元力。小さいほど大きくゆっくり揺れる
        damping: 0.958,          // 速度の減衰(毎ステップの倍率)。1に近いほど長く揺れる
        spread: 0.40,            // 隣へ伝わる量。大きいほど波が輪郭を回る
        impactScale: 2.6,        // 衝突の強さ→へこみ量
        // へこみの上限。ゼリーの短辺に対する比率。
        // 絶対値で固定すると小さいゼリーだけ崩れる（涙型・三日月型になった）
        maxOffsetRatio: 0.20,
        falloff: 0.0028,         // 接触点から離れた輪郭への減衰。小さいほど広く波及
        // 隣のゼリーへ伝わる変形の強さ（伝わる先は接触経由で決まる）
        neighborScale: 0.75,

        // 落下・着地のスカッシュ＆ストレッチ。
        // 落ちる間は進行方向に伸び、ぶつかると潰れる。柔らかさが一番出る要素。
        squashScale: 0.05,
        squashMax: 0.32
      },

      /**
       * 着地の衝撃を、接触点より上のゼリーに横向きの速度として伝える。
       * 塔が実際に揺れる。難易度を決めている最大の要素はこれ。
       *
       * ★ 実測メモ（狙い=常に土台中心、10シード平均、普通のプレイ=ブレ12px）
       *   接触経由の伝播に直した後の値:
       *     scale 1.4 → 11.2個 / 2.2 → 8.2個 / 3.0 → 7.1個
       *   hopDecay を 0.9 にすると衝撃が減衰せず塔全体に及び、
       *   完璧なプレイでも7個で崩れて理不尽になる。0.75 が上限。
       *
       *   効かなかった手:
       *     土台を狭める     0.62→0.42 で 11.6→11.5。ほぼ無意味
       *     摩擦を下げる     滑って自分で収まるので、むしろ簡単になる
       *     反発だけ上げる   単体では 11.2個。揺れと組んで初めて効く
       *
       *   却下した手:
       *     塔を継続的に揺らす。全ボディを起こし続けるので sleeping が無効化され、
       *     微振動が蓄積して「完璧なプレイでも8個で崩れる」状態になった。
       *
       *   伝える先は「接触をたどって繋がっているゼリー」に限る。
       *   距離や高さで判定すると、触れていない離れたゼリーまで動いてしまう
       *   （左端の1つめが、右端に落とした2つめのせいで転げ落ちる不具合になった）。
       *
       *   scale を上げると①完璧なプレイも崩れるようになる（1.4 で27個）。
       *   これは設計上の脆さであってバグではない。
       *   ソルバーの健全性は tools/stack-test.mjs が「揺れ無し」で別途確認する。
       */
      shake: {
        scale: 3.0,
        maxHops: 8,        // 接触を何個たどるまで伝えるか
        hopDecay: 0.75,    // 1つたどるごとに弱める倍率
        minStrength: 0.3   // これ未満の弱い接触では揺らさない
      },

      /**
       * ゼリーの種類。
       * 形状は大・中・小・横長・縦長の5種類あれば十分な変化が出る。
       */
      jellyTypes: [
        { id: 'grape',  w: 46, h: 42, color: '#c77dff' },
        { id: 'peach',  w: 58, h: 52, color: '#ff6b9d' },
        { id: 'melon',  w: 74, h: 62, color: '#6bcb77' },
        { id: 'soda',   w: 92, h: 38, color: '#4d96ff' },
        { id: 'mango',  w: 46, h: 72, color: '#ffd93d' }
      ]
    }
  };
})();

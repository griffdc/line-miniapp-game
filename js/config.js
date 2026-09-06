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
      gravity: 0.5,         // 参考動画は約3倍のスロー。加速は残す（等速にはしない）
      /**
       * この角度(°)より傾いている間は sleep させない。
       * 皿の端でゆっくり倒れかけている body は速度が小さく、Matter が「静止」と
       * 誤認して眠らせるため、傾いたまま固まる。実測: 8° で固まりが 0 になり、
       * ⓪ の塔の安定性も落ちない。sleep の運動しきい値を下げる方式は
       * 塔が全滅した（0/6）ので採らない。
       */
      tiltNoSleepDeg: 8,
      friction: 0.9,        // 低いと滑って崩れる
      frictionStatic: 1.0,
      frictionAir: 0.03,    // 着地後の微振動を減衰させる
      // 参考動画は着地で一切跳ねない（粘性のあるゼリー）。0 にする。
      // 以前は 0.3 で shake と組んで崩れやすさを出していたので、その分は shake.scale で補う。
      restitution: 0.5,
      density: 0.0012,
      chamferRatio: 0.12,   // 角の丸め。大きいほどゼリーらしいが転がって崩れる
      /**
       * ゼリー同士のめり込み深さ(px)。Matter の slop に渡す。
       * slop は「この深さまでは重なりを補正しない」しきい値なので、
       * 積まれたゼリーは物理的にこの深さだけ重なった状態で釣り合う。
       * 皿との接触にも同じ値が効く（ペアの大きい方が採用される）。
       *
       * ★ 実測: 3 以上にすると皿の端からはみ出したゼリーが落ちなくなる
       *   （皿にめり込んだ分、皿の側面が壁として働く。tilt-test 落下 40→27→0）。
       *   5 では ⓪ も 7/8 に落ちる。物理で重ねるのは 2 まで。
       *   見た目のめり込みは wobble.renderScale と press.cushion で足す。
       */
      sinkPx: 2,

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
      // 落とした瞬間に与えるわずかな回転（rad/step）。参考動画のブロックは落下中にゆっくり傾く
      // 0.012 以上にすると、完璧に真ん中へ落としても傾いて着地し塔が倒れる（⓪が完走しなくなる）。
      dropSpin: 0.006,
      // HUD（つぎ / 高さ / ステージ）の下に来る位置。上に置くと文字と重なる
      dropperScreenY: 118,
      dropperEdgeMargin: 40,
      dropCooldownMs: 380,

      /**
       * ステージ。ゴールバーの高さ(cm)まで積めばクリア。
       * 一覧を超えたステージは、最後の値に stepBeyondCm を足し続ける。
       *
       * 目安: ゼリー1個 ≒ 5cm。普通のプレイは 11個前後(≒55cm)で崩れる（shake の実測メモ参照）。
       *       上手いプレイで 13個(≒65cm)。それ以上はかなり難しい。
       *
       * 曲線は「1ステージ進むごとにゼリー1個ぶん（+5cm）」の線形。
       * 以前は +10cm/ステージ で、ステージ3(40cm)が平均的な崩壊点に当たり
       * 多くの人がそこで止まる形だった。今はステージ6で40cmに達する。
       * もっと緩くするなら stepBeyondCm を小さく、一覧の刻みも同じ幅に揃える。
       */
      stages: {
        goalsCm: [15, 20, 25, 30, 35, 40, 45, 50, 55, 60],
        stepBeyondCm: 5,
        // バーを超えた状態をこのフレーム数維持したらクリア。
        // 跳ねて一瞬だけ超えたのを成立させないための猶予。
        holdFrames: 45
      },

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
        groundY: 0.772,
        plateWidth: 0.84,
        skyColor: '#41b6fe',   // 画像より上を塗る（塔が伸びると見える）
        floorColor: '#d4c299'  // 画像より下を塗る
      },

      /**
       * ぷるぷる変形（描画のみ。物理には影響しない）。
       * 手触りはここの数値で決まる。物理パラメータと違って自由に触ってよい。
       */
      wobble: {
        points: 16,              // 輪郭のサンプル数。増やすと滑らかだが重い
        renderChamferRatio: 0.34, // 描画用の丸め。物理(0.12)より大きくして柔らかく見せる
        renderScale: 1.12,       // 物理より大きく描く。sinkPx(2px) と合わせて接触面が 7〜8px 重なって見える
        // ★ ぷるぷる度は「振れ幅」と「揺れている時間」の2つで決まる。実測（peach 58x52 の縦の伸び縮み）:
        //     stiffness .06 / damping .78 / 上限 .30 → 18.4px(高さの35%)  217ms で収まる（＝ほぼ揺れない）
        //     stiffness .09 / damping .91 / 上限 .38 → 23.3px(高さの45%)  約600ms 揺れる  ← 採用
        //     damping .93 にすると 1000ms 揺れ続けて落ち着かない
        //   これは描画レイヤーの値。いくら動かしても物理（積みやすさ）は変わらない。
        stiffness: 0.09,         // 復元力。小さいほど大きくゆっくり戻る
        damping: 0.91,           // 速度の減衰(毎ステップの倍率)。1に近いほど長く揺れる
        spread: 0.28,            // 隣へ伝わる量。大きいと波が輪郭を回って「ぷるん」に見える
        impactScale: 3.2,        // 衝突の強さ→へこみ量
        // へこみの上限。ゼリーの短辺に対する比率。
        // 絶対値で固定すると小さいゼリーだけ崩れる（涙型・三日月型になった）
        maxOffsetRatio: 0.38,
        falloff: 0.0028,         // 接触点から離れた輪郭への減衰。小さいほど広く波及
        // 隣のゼリーへ伝わる変形の強さ（伝わる先は接触経由で決まる）
        neighborScale: 0.75,

        // 落下・着地のスカッシュ＆ストレッチ。
        // 落ちる間は進行方向に伸び、ぶつかると潰れる。柔らかさが一番出る要素。
        squashScale: 0.03,       // 落下中の伸び。上げすぎると落ちてくる姿が細長くなる
        squashMax: 0.20
      },

      /**
       * 載っている重さによる押し潰れ（描画のみ）。
       * 物理の接触情報から、接触面を平らに押し、押し出した分を横へふくらませる。
       * 参考にしたソフトボディ動画で一番目を引く「下のブロックが平たく広がる」表現。
       */
      press: {
        perMass: 1.6,     // 上に載る質量1あたり何px押し込むか（ゼリー1個 ≒ 質量2.4〜5.5）。
                          // 2.2 だと3個下で上限に張り付き、段階的な潰れが消えた
        selfRatio: 0.6,   // 自分の重さで支えに押し付けられる分の比率
        falloff: 0.0012,  // 接触点から離れた面への減衰。小さいほど面全体が平らになる
        bulge: 0.7,       // 押し込んだ分のうち横へふくらむ割合（体積保存の強さ）
        // めり込みの縁。上に載ったゼリーの幅の外側だけを盛り上げて、
        // 下のゼリーが上のゼリーを包み込むように見せる（sinkPx の物理的な重なりと合わせて使う）。
        cushion: 0.9,      // 盛り上がりの高さ（押し込み量に対する比）
        cushionWidth: 18   // 盛り上がりが届く幅(px)。輪郭点の間隔(≒14px)より広くしないと点に当たらない
      },

      /**
       * ガラスのグミの質感（描画のみ）。
       */
      look: {
        alpha: 0.62,     // 本体の透け具合。境界は縁の暗い線とリムライトで確保する
        edge: 0.05,      // 厚みの縁の幅（短辺に対する比）。太いと額縁に見える
        edgeAlpha: 0.5,  // 厚みの縁の濃さ
        specular: 0.7,   // 上面の光の芯の強さ
        rim: 0.6         // 縁のリムライト
      },

      /**
       * 着地の衝撃で塔を揺らす（難易度を決めている最大の要素）。
       *
       * モデル: 着地点が「受け手の中心からどれだけずれたか」(0〜1) に比例して、
       * 受け手とその下に連なるゼリーへ横向きの速度を与える。下へ行くほど hopDecay で弱まる。
       * 完璧に中心へ落とせば揺れない（⓪が成立する）。着地1回につき1回だけ。
       *
       * ★ 以前は「接触が起きるたびに、接触点より上のゼリーへ scale 倍の速度」を与えていた。
       *   揺れたゼリー同士の接触がまた揺れを生み、横速度が 1200px/step まで暴走して
       *   ゼリーが吹っ飛んでいた（実測）。しかも上に載せる通常の着地では
       *   「接触点より上」に誰もいないので、難易度はこの暴走だけで作られていた。
       *
       * ★ 実測（8シード平均。① = 同一サイズ・ブレ0・揺れあり、これが完走しないと「真ん中に落としたのに崩れる」）
       *   deadZone 0   / scale 12:  ① 0/8(10個)  ② 9.0  ③  9.8  ④  9.9
       *   deadZone 0.2 / scale 15:  ① 4/8(36個)  ② 9.3  ③ 11.6  ④  9.4
       *   deadZone 0.3 / scale 15:  ① 8/8        ② 11.6 ③ 10.0  ④ 10.4  ← 採用
       *   maxDv 8 にすると静止しているゼリーが 9.7px/step で目に見えて滑る（6 で 7.4）
       *   塔は着地のたびに数px横へずれていくので、deadZone が 0.3 ないと真ん中に落としても揺れてしまう。
       */
      shake: {
        scale: 15,         // 衝突速度 × ずれ(0〜1) × これ = 付与する横速度(px/step)
        maxDv: 6,          // 1回に付与する横速度の上限。落下速度(≒4.2)より少し上。これが吹っ飛び防止の要
        deadZone: 0.3,     // ずれがこれ未満なら揺らさない（塔を起こしもしない。眠りが塔を支えている）
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
